// The worklog registry against any tracker or time sink, through the
// provider contract: a worklog pushed with its uuid as the idempotency key,
// changed the way its service allows (in place, replaced, or deleted and
// logged again, the link kept), deleted; and the service's own feed of
// entries read back into the registry. Every tracker that keeps entries
// writes through here (sync/timeWrites.ts); Jira's feed is still read by
// its own sync (worklogSync.ts).
import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
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

/** Entries written per statement at most (5 to 10 parameters each, 65535 per statement). */
const PAGE_SLICE = 1000;

const slices = <T>(all: T[]): T[][] => Array.from({ length: Math.ceil(all.length / PAGE_SLICE) }, (_, i) => all.slice(i * PAGE_SLICE, (i + 1) * PAGE_SLICE));

/** An UPDATE … FROM (VALUES …) row: each value cast, so the first row types the column. */
const valuesOf = (rows: SQL[][]) => sql.join(rows.map((r) => sql`(${sql.join(r, sql`, `)})`), sql`, `);

/**
 * One page of the service's feed into the registry. Read once for the page (the
 * entries already known, their worklogs, our own not confirmed yet, our queued
 * changes) and written in a few statements, however many entries: the cost of a
 * page does not grow with it. A conflict and one of ours read back (both rare) are
 * still written one by one. Not one transaction: a page cut halfway is read again on
 * the next pass (the checkpoint only moves after it) and lands the same.
 */
async function applyPage(
  conn: Pick<Connection, "id" | "userId" | "remoteAccountId">,
  items: RemoteWorklog[],
  gone: { remoteId: string }[],
  zone: TimeZone,
): Promise<{ upserted: number; removed: number }> {
  const db = getDb();
  const mine = items.filter((w) => w.authorRemoteId === conn.remoteAccountId && !!w.issue?.key);
  // An entry named twice in a page ends as its last, as entry after entry did; its first
  // copy is the one that could be ours (the later ones found it known by then).
  const entries = [...new Map(mine.map((w) => [w.remoteId, w])).values()];
  const firsts = new Map<string, RemoteWorklog>();
  for (const w of mine) if (!firsts.has(w.remoteId)) firsts.set(w.remoteId, w);

  const ids = entries.map((w) => w.remoteId);
  const knownRows =
    ids.length === 0
      ? []
      : await db
          .select({ worklogId: worklogSinks.worklogId, state: worklogSinks.state, remoteId: worklogSinks.remoteId })
          .from(worklogSinks)
          .where(and(eq(worklogSinks.sinkConnectionId, conn.id), inArray(worklogSinks.remoteId, ids)));
  const known = new Map(knownRows.map((k) => [k.remoteId ?? "", k]));
  const locals = new Map(
    (knownRows.length === 0 ? [] : await db.select().from(worklogs).where(inArray(worklogs.id, knownRows.map((k) => k.worklogId)))).map((l) => [l.id, l]),
  );
  // Ours not confirmed yet (written, its answer lost; or queued), on the issues of the new entries.
  const newKeys = [...new Set(entries.flatMap((w) => (!known.has(w.remoteId) && w.issue?.key ? [w.issue.key] : [])))];
  const unconfirmed =
    newKeys.length === 0
      ? []
      : await db
          .select()
          .from(worklogs)
          .where(
            and(
              eq(worklogs.userId, conn.userId),
              eq(worklogs.connectionId, conn.id),
              inArray(worklogs.issueKey, newKeys),
              or(sql`${worklogs.remoteId} LIKE 'new-%'`, sql`${worklogs.remoteId} LIKE 'pending-%'`),
            ),
          );

  type Read = { w: RemoteWorklog; key: string; values: { timeSpentSeconds: number; started: Date; comment: string; syncedAt: Date }; locked: string | null };
  const reads: (Read & { k?: { worklogId: number; state: string }; local?: Local; differs: boolean })[] = entries.map((w) => {
    const values = { timeSpentSeconds: w.span.seconds, started: startOf(w.span, zone), comment: w.comment, syncedAt: new Date() };
    const k = known.get(w.remoteId);
    const local = k ? locals.get(k.worklogId) : undefined;
    // A service that keeps only the day: the clock time here stands while the day is the same.
    if (local && w.dayOnly && localDateOf(instant(local.started.getTime()), zone) === localDateOf(instant(values.started.getTime()), zone)) values.started = local.started;
    const differs = !!local && (local.timeSpentSeconds !== values.timeSpentSeconds || local.started.getTime() !== values.started.getTime() || local.comment !== values.comment);
    // (Every entry here has its issue: the others were left out above.)
    return { w, key: w.issue?.key ?? "", values, locked: w.locked ? JSON.stringify(w.locked) : null, k, local, differs };
  });
  // A change of ours not on the service yet, for the known entries that differ: queued, or its sink not synced.
  const differing = reads.filter((r) => r.differs).map((r) => r.local!.id);
  const queued = new Set(
    differing.length === 0
      ? []
      : (
          await db
            .select({ worklogId: outbox.worklogId })
            .from(outbox)
            .where(and(inArray(outbox.worklogId, differing), eq(outbox.connectionId, conn.id), inArray(outbox.kind, ["create", "update"])))
        ).map((r) => r.worklogId),
  );

  const updated: Read[] = [];
  const updatedIds: number[] = [];
  const added: Read[] = [];
  for (const r of reads) {
    const { w, values, locked, k, local } = r;
    if (k) {
      if (local && r.differs && (k.state !== "synced" || queued.has(local.id))) {
        // Changed on both sides: kept as it is here, the service's version beside it, until the user picks.
        const snapshot: RemoteSnapshot = { seconds: values.timeSpentSeconds, started: values.started.getTime(), comment: values.comment };
        await db
          .update(worklogSinks)
          .set({ state: "conflict", remoteSnapshot: JSON.stringify(snapshot), version: w.version ?? null, locked })
          .where(and(eq(worklogSinks.worklogId, k.worklogId), eq(worklogSinks.sinkConnectionId, conn.id)));
      } else {
        // Unchanged here: the service's version wins.
        updated.push(r);
        updatedIds.push(k.worklogId);
      }
      continue;
    }
    const first = firsts.get(w.remoteId) ?? w;
    const firstTime = { started: startOf(first.span, zone), seconds: first.span.seconds };
    const at = unconfirmed.findIndex((c) => c.issueKey === r.key && sameTime({ started: c.started, seconds: c.timeSpentSeconds }, firstTime));
    if (at >= 0) {
      // Ours, read back before its answer came: the same worklog, never a second one.
      const [ours] = unconfirmed.splice(at, 1);
      await landed(ours, conn, first);
      await db.update(worklogSinks).set({ locked: first.locked ? JSON.stringify(first.locked) : null }).where(and(eq(worklogSinks.worklogId, ours.id), eq(worklogSinks.sinkConnectionId, conn.id)));
      await db.delete(outbox).where(and(eq(outbox.worklogId, ours.id), eq(outbox.connectionId, conn.id), eq(outbox.kind, "create")));
      if (first !== w) {
        // Named again later in the page: then known, its last copy's values win.
        if (w.dayOnly && localDateOf(instant(ours.started.getTime()), zone) === localDateOf(instant(values.started.getTime()), zone)) values.started = ours.started;
        updated.push(r);
        updatedIds.push(ours.id);
      }
    } else {
      added.push(r);
    }
  }

  if (updated.length > 0) {
    await db.execute(sql`UPDATE ${worklogs} SET time_spent_seconds = v.seconds, started = v.started, comment = v.comment, synced_at = v.synced_at
      FROM (VALUES ${valuesOf(updated.map((r, i) => [sql`${updatedIds[i]}::int`, sql`${r.values.timeSpentSeconds}::int`, sql`${r.values.started.getTime()}::bigint`, sql`${r.values.comment}::text`, sql`${r.values.syncedAt.getTime()}::bigint`]))})
      AS v(id, seconds, started, comment, synced_at) WHERE ${worklogs.id} = v.id`);
    await db.execute(sql`UPDATE ${worklogSinks} SET version = v.version, state = 'synced', remote_snapshot = NULL, locked = v.locked
      FROM (VALUES ${valuesOf(updated.map((r, i) => [sql`${updatedIds[i]}::int`, sql`${r.w.version ?? null}::text`, sql`${r.locked}::text`]))})
      AS v(worklog_id, version, locked) WHERE ${worklogSinks.worklogId} = v.worklog_id AND ${worklogSinks.sinkConnectionId} = ${conn.id}`);
  }
  if (added.length > 0) {
    const made = await db
      .insert(worklogs)
      .values(added.map(({ w, key, values }) => ({ userId: conn.userId, connectionId: conn.id, issueKey: key, remoteId: w.remoteId, authorAccountId: w.authorRemoteId, ...values })))
      .onConflictDoUpdate({
        target: [worklogs.userId, worklogs.connectionId, worklogs.issueKey, worklogs.remoteId],
        set: { timeSpentSeconds: sql`excluded.time_spent_seconds`, started: sql`excluded.started`, comment: sql`excluded.comment`, syncedAt: sql`excluded.synced_at` },
      })
      .returning({ id: worklogs.id, remoteId: worklogs.remoteId });
    const byRemote = new Map(added.map((r) => [r.w.remoteId, r]));
    await db.execute(sql`UPDATE ${worklogSinks} SET version = v.version, locked = v.locked
      FROM (VALUES ${valuesOf(made.map((m) => [sql`${m.id}::int`, sql`${byRemote.get(m.remoteId)?.w.version ?? null}::text`, sql`${byRemote.get(m.remoteId)?.locked ?? null}::text`]))})
      AS v(worklog_id, version, locked) WHERE ${worklogSinks.worklogId} = v.worklog_id AND ${worklogSinks.sinkConnectionId} = ${conn.id}`);
  }

  // Gone on the service: their worklogs go here, in one statement.
  const goneIds = [...new Set(gone.map((g) => g.remoteId))];
  const goneRows =
    goneIds.length === 0
      ? []
      : await db
          .select({ worklogId: worklogSinks.worklogId, remoteId: worklogSinks.remoteId })
          .from(worklogSinks)
          .where(and(eq(worklogSinks.sinkConnectionId, conn.id), inArray(worklogSinks.remoteId, goneIds)));
  if (goneRows.length > 0) await db.delete(worklogs).where(and(inArray(worklogs.id, goneRows.map((g) => g.worklogId)), eq(worklogs.connectionId, conn.id)));
  // Each known one once (named twice, the second found nothing, as entry after entry did).
  return { upserted: mine.length, removed: goneRows.length };
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
  let upserted = 0;
  let removed = 0;
  const { checkpoint } = await eachPage(
    async (q) => {
      await opts.budget.take(opts.meta.signal);
      return changed(opts.meta, q);
    },
    opts.since,
    async (items, gone) => {
      // A very large page in slices, one after the other (a statement takes 65535 parameters
      // at most): all its entries first, then what is gone, as entry after entry did.
      for (const some of slices(items)) upserted += (await applyPage(conn, some, [], opts.zone)).upserted;
      for (const someGone of slices(gone)) removed += (await applyPage(conn, [], someGone, opts.zone)).removed;
    },
  );
  return { checkpoint, upserted, removed };
}
