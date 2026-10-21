// The worklog registry against any tracker or time sink, through the
// provider contract: a worklog pushed with its uuid as the idempotency key,
// changed the way its service allows (in place, replaced, or deleted and
// logged again, the link kept), deleted; and the service's own feed of
// entries read back into the registry. Every tracker that keeps entries
// writes through here (sync/timeWrites.ts); Jira's feed is still read by
// its own sync (worklogSync.ts).
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { outbox, worklogs, worklogSinks, type Connection } from "@db/schema";
import type { EntryCapabilities } from "@contracts/providers";
import { instant, instantAtLocal, localDateOf, type TimeZone } from "@contracts/values";
import { getDb } from "../queries/connection";
import { withDeleteReason } from "../queries/trash";
import type { BoundTracker, CallMeta } from "../providers/core/bind";
import { ProviderError } from "../providers/core/errors";
import { eachPage } from "../providers/core/paging";
import type { Checkpoint, IssueRef, RemoteWorklog, TimeInput, WorklogInput } from "../providers/types";
import type { Budget } from "./budget";

type Local = typeof worklogs.$inferSelect;
type Sink = typeof worklogSinks.$inferSelect;

/** The entries model of a tracker that keeps entries, or null. */
export function entriesOf(b: BoundTracker): Extract<EntryCapabilities, { model: "entries" }> | null {
  const t = b.capabilities.time;
  return t.mode === "entries" && t.entries.model === "entries" ? t.entries : null;
}

/** The worklog as its service takes it: a start, or only its day in the connection's zone. */
export function timeInput(shape: "session" | "date", w: Pick<Local, "started" | "timeSpentSeconds">, zone: TimeZone): TimeInput {
  const start = instant(w.started.getTime());
  return shape === "session" ? { kind: "session", start, seconds: w.timeSpentSeconds } : { kind: "date", date: localDateOf(start, zone), seconds: w.timeSpentSeconds };
}

async function sinkOf(worklogId: number, connectionId: number): Promise<Sink | undefined> {
  const [row] = await getDb()
    .select()
    .from(worklogSinks)
    .where(and(eq(worklogSinks.worklogId, worklogId), eq(worklogSinks.sinkConnectionId, connectionId)))
    .limit(1);
  return row;
}

/** The registry follows what the service now has: its id (the primary sink's id on the worklog too) and revision. */
async function landed(local: Local, conn: Pick<Connection, "id">, remote: RemoteWorklog) {
  if (local.connectionId === conn.id) {
    // A copy of it a sync read back meanwhile is the same worklog: it goes, without a trace.
    await withDeleteReason("merged", async (tx) => {
      await tx
        .delete(worklogs)
        .where(and(eq(worklogs.userId, local.userId), eq(worklogs.connectionId, conn.id), eq(worklogs.issueKey, local.issueKey), eq(worklogs.remoteId, remote.remoteId), ne(worklogs.id, local.id)));
      await tx.update(worklogs).set({ remoteId: remote.remoteId, syncedAt: new Date() }).where(eq(worklogs.id, local.id));
    });
  }
  await linkSink(local.id, conn.id, remote.remoteId, remote.version ?? null);
}

/**
 * The worklog is the service's entry `remoteId` on that sink. The same entry
 * under another worklog already (an issue key changed between syncs): the
 * registry keeps the first, as the database's own trigger does.
 */
export async function linkSink(worklogId: number, sinkConnectionId: number, remoteId: string, version: string | null) {
  try {
    await getDb()
      .insert(worklogSinks)
      .values({ worklogId, sinkConnectionId, remoteId, state: "synced", version, syncedAt: new Date() })
      .onConflictDoUpdate({
        target: [worklogSinks.worklogId, worklogSinks.sinkConnectionId],
        set: { remoteId, state: "synced", version, lastError: null, syncedAt: new Date() },
      });
  } catch (e) {
    if ((e as { cause?: { code?: string }; code?: string }).cause?.code !== "23505" && (e as { code?: string }).code !== "23505") throw e;
  }
}

function inputOf(b: BoundTracker, local: Local, zone: TimeZone): WorklogInput {
  const e = entriesOf(b);
  if (!e) throw new ProviderError("invalid", `${b.type} keeps no time entries`);
  return { time: timeInput(e.shape, local, zone), comment: local.comment };
}

/** A new worklog on the service: a retry with the same uuid lands once (natively, or by inkledger's own key). */
export async function pushCreate(b: BoundTracker, conn: Pick<Connection, "id">, local: Local, ref: IssueRef, meta: CallMeta, zone: TimeZone) {
  if (!b.worklogs?.create) throw new ProviderError("invalid", `${b.type} doesn't take new entries`);
  const remote = await b.worklogs.create(meta, ref, inputOf(b, local, zone), { idempotencyKey: local.uuid });
  await landed(local, conn, remote);
  return remote;
}

/**
 * A changed worklog, the way the service allows: updated in place (with
 * the revision it was read at, where the service keeps revisions), or
 * deleted and logged again (the new entry is linked to the same worklog).
 */
export async function pushUpdate(b: BoundTracker, conn: Pick<Connection, "id">, local: Local, ref: IssueRef, meta: CallMeta, zone: TimeZone) {
  const e = entriesOf(b);
  const sink = await sinkOf(local.id, conn.id);
  if (!sink?.remoteId) return pushCreate(b, conn, local, ref, meta, zone);
  if (!e || e.write.mode !== "entry" || e.write.update === "none") throw new ProviderError("invalid", `${b.type} entries can't be changed`);
  const input = inputOf(b, local, zone);
  if (e.write.update === "recreate") {
    await b.worklogs!.delete!(meta, ref, sink.remoteId, { expectedVersion: sink.version ?? undefined });
    // A new key per content: a retry of this same change lands once, the original create's key is not reused.
    const remote = await b.worklogs!.create!(meta, ref, input, { idempotencyKey: `${local.uuid}:${input.time.kind === "session" ? input.time.start : input.time.date}:${input.time.seconds}` });
    await landed(local, conn, remote);
    return remote;
  }
  const remote = await b.worklogs!.update!(meta, ref, sink.remoteId, input, { expectedVersion: sink.version ?? undefined });
  await landed(local, conn, remote);
  return remote;
}

/** Gone from the service (already gone counts as done); the registry row goes with it. */
export async function pushDelete(b: BoundTracker, conn: Pick<Connection, "id">, local: Pick<Local, "id">, ref: IssueRef, meta: CallMeta) {
  const sink = await sinkOf(local.id, conn.id);
  if (sink?.remoteId) {
    if (!b.worklogs?.delete) throw new ProviderError("invalid", `${b.type} entries can't be deleted`);
    await b.worklogs.delete(meta, ref, sink.remoteId, { expectedVersion: sink.version ?? undefined });
  }
  await getDb()
    .delete(worklogSinks)
    .where(and(eq(worklogSinks.worklogId, local.id), eq(worklogSinks.sinkConnectionId, conn.id)));
}

/** A date entry's start: 09:00 in the connection's zone (only its day is known). */
function startOf(span: RemoteWorklog["span"], zone: TimeZone): Date {
  return new Date(span.kind === "session" ? span.start : instantAtLocal(span.date, 9, zone));
}

/** Two entries are the same time: same length, starts within a minute (a create whose answer was lost, read back). */
export const SAME_START_MS = 60_000;
export const sameTime = (a: { started: Date; seconds: number }, b: { started: Date; seconds: number }) =>
  a.seconds === b.seconds && Math.abs(a.started.getTime() - b.started.getTime()) < SAME_START_MS;

/** What the service has, as stored for a conflict (the user picks). */
export type RemoteSnapshot = { seconds: number; started: number; comment: string };

/**
 * A new entry read from the service that is one of ours not confirmed yet
 * (written, its answer lost; or queued): the local worklog it is, or none.
 */
async function ownUnconfirmed(conn: Pick<Connection, "id" | "userId">, issueKey: string, remote: { started: Date; seconds: number }): Promise<Local | undefined> {
  const candidates = await getDb()
    .select()
    .from(worklogs)
    .where(
      and(
        eq(worklogs.userId, conn.userId),
        eq(worklogs.connectionId, conn.id),
        eq(worklogs.issueKey, issueKey),
        or(sql`${worklogs.remoteId} LIKE 'new-%'`, sql`${worklogs.remoteId} LIKE 'pending-%'`),
      ),
    );
  return candidates.find((c) => sameTime({ started: c.started, seconds: c.timeSpentSeconds }, remote));
}

/** A worklog with a change of ours not on the service yet: queued, or its sink not synced. */
async function hasOwnChange(worklogId: number, connectionId: number, sink: Pick<Sink, "state"> | undefined): Promise<boolean> {
  if (sink && sink.state !== "synced") return true;
  const [queued] = await getDb()
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.worklogId, worklogId), eq(outbox.connectionId, connectionId), inArray(outbox.kind, ["create", "update"])))
    .limit(1);
  return !!queued;
}

/**
 * The service's feed of entries into the registry: the user's own, on an
 * issue; a known one updated, a new one added (the primary sink's), one the
 * service reports removed deleted here (the trash comes with WP-15).
 */
export async function syncEntries(
  b: BoundTracker,
  conn: Pick<Connection, "id" | "userId" | "remoteAccountId">,
  opts: { since: Checkpoint | null; meta: CallMeta; budget: Budget; zone: TimeZone },
): Promise<{ checkpoint: Checkpoint | null; upserted: number; removed: number }> {
  const changed = b.worklogs?.changed;
  if (!changed) throw new ProviderError("invalid", `${b.type} has no feed of entries`);
  const db = getDb();
  let upserted = 0;
  let removed = 0;
  const { checkpoint } = await eachPage(
    async (q) => {
      await opts.budget.take(opts.meta.signal);
      return changed(opts.meta, q);
    },
    opts.since,
    async (items, gone) => {
      for (const w of items) {
        if (w.authorRemoteId !== conn.remoteAccountId || !w.issue?.key) continue;
        const values = { timeSpentSeconds: w.span.seconds, started: startOf(w.span, opts.zone), comment: w.comment, syncedAt: new Date() };
        const locked = w.locked ? JSON.stringify(w.locked) : null;
        const [known] = await db
          .select({ worklogId: worklogSinks.worklogId, state: worklogSinks.state })
          .from(worklogSinks)
          .where(and(eq(worklogSinks.sinkConnectionId, conn.id), eq(worklogSinks.remoteId, w.remoteId)))
          .limit(1);
        const ours = known ? undefined : await ownUnconfirmed(conn, w.issue.key, { started: values.started, seconds: values.timeSpentSeconds });
        if (known) {
          const [local] = await db.select().from(worklogs).where(eq(worklogs.id, known.worklogId));
          // A service that keeps only the day: the clock time here stands while the day is the same.
          if (local && w.dayOnly && localDateOf(instant(local.started.getTime()), opts.zone) === localDateOf(instant(values.started.getTime()), opts.zone)) values.started = local.started;
          const differs = !!local && (local.timeSpentSeconds !== values.timeSpentSeconds || local.started.getTime() !== values.started.getTime() || local.comment !== values.comment);
          if (local && differs && (await hasOwnChange(local.id, conn.id, known))) {
            // Changed on both sides: kept as it is here, the service's version beside it, until the user picks.
            const snapshot: RemoteSnapshot = { seconds: values.timeSpentSeconds, started: values.started.getTime(), comment: values.comment };
            await db
              .update(worklogSinks)
              .set({ state: "conflict", remoteSnapshot: JSON.stringify(snapshot), version: w.version ?? null, locked })
              .where(and(eq(worklogSinks.worklogId, known.worklogId), eq(worklogSinks.sinkConnectionId, conn.id)));
          } else {
            // Unchanged here: the service's version wins.
            await db.update(worklogs).set(values).where(eq(worklogs.id, known.worklogId));
            await db
              .update(worklogSinks)
              .set({ version: w.version ?? null, state: "synced", remoteSnapshot: null, locked })
              .where(and(eq(worklogSinks.worklogId, known.worklogId), eq(worklogSinks.sinkConnectionId, conn.id)));
          }
        } else if (ours) {
          // Ours, read back before its answer came: the same worklog, never a second one.
          await landed(ours, conn, w);
          await db.update(worklogSinks).set({ locked }).where(and(eq(worklogSinks.worklogId, ours.id), eq(worklogSinks.sinkConnectionId, conn.id)));
          await db.delete(outbox).where(and(eq(outbox.worklogId, ours.id), eq(outbox.connectionId, conn.id), eq(outbox.kind, "create")));
        } else {
          const [made] = await db
            .insert(worklogs)
            .values({ userId: conn.userId, connectionId: conn.id, issueKey: w.issue.key, remoteId: w.remoteId, authorAccountId: w.authorRemoteId, ...values })
            .onConflictDoUpdate({ target: [worklogs.userId, worklogs.connectionId, worklogs.issueKey, worklogs.remoteId], set: values })
            .returning({ id: worklogs.id });
          await db.update(worklogSinks).set({ version: w.version ?? null, locked }).where(and(eq(worklogSinks.worklogId, made.id), eq(worklogSinks.sinkConnectionId, conn.id)));
        }
        upserted++;
      }
      for (const g of gone) {
        const [known] = await db
          .select({ worklogId: worklogSinks.worklogId })
          .from(worklogSinks)
          .where(and(eq(worklogSinks.sinkConnectionId, conn.id), eq(worklogSinks.remoteId, g.remoteId)))
          .limit(1);
        if (known) {
          await db.delete(worklogs).where(and(eq(worklogs.id, known.worklogId), eq(worklogs.connectionId, conn.id)));
          removed++;
        }
      }
    },
  );
  return { checkpoint, upserted, removed };
}
