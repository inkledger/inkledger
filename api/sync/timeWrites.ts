// The user's time on a tracker that keeps entries (Jira included), through
// the provider contract: written through to the tracker (D10); while it
// can't be reached, queued in the outbox and replayed in order later. For
// Jira the calls are the ones its own path made (jira-gate.test.ts).
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { connections, issues, outbox, worklogs, worklogSinks, type Connection, type Worklog } from "@db/schema";
import { COMPANION_TYPES } from "./companions";
import { MAX_OUTBOX_ATTEMPTS } from "@contracts/types";
import type { TimeZone } from "@contracts/values";
import { getDb } from "../queries/connection";
import { withDeleteReason } from "../queries/trash";
import { connOf } from "../providers/connections";
import type { BoundTracker } from "../providers/core/bind";
import { ProviderError } from "../providers/core/errors";
import { t as tr } from "@contracts/i18n";
import { providerTrpcError } from "../providers/trpc";
import type { IssueRef } from "../providers/types";
import { boundTracker } from "./engine";
import { deleteThere, entriesOf, linkSink, pushCreate, pushUpdate, sameTime } from "./worklogs";
import { oneReplay, withOutboxLock, type ReplayResult } from "./outboxLocks";

/** Where one issue's time goes: its tracker, bound, the issue's reference there, the zone its dates are in. */
export type ContractTime = { conn: Connection; b: BoundTracker; ref: IssueRef; zone: TimeZone };

const meta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `time-${Date.now()}` });

/** A failure worth trying again later (the tracker unreachable, busy, slow), not a refusal. */
const queueable = (e: unknown) => e instanceof ProviderError && e.transient;

/** The issue's time through the contract, or null: a tracker keeping no entries (its time stays in inkledger). */
export async function contractTime(userId: number, conn: Connection, issueKey: string): Promise<ContractTime | null> {
  const b = boundTracker(conn);
  if (!b || !entriesOf(b)) return null;
  const [row] = await getDb()
    .select({ remoteId: issues.remoteId, projectKey: issues.projectKey })
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, conn.id), eq(issues.key, issueKey)))
    .limit(1);
  const ref: IssueRef = { remoteId: row?.remoteId ?? issueKey, key: issueKey, ...(row?.projectKey ? { container: { remoteId: row.projectKey, key: row.projectKey } } : {}) };
  return { conn, b, ref, zone: connOf(conn).timeZone };
}

async function reread(id: number): Promise<Worklog> {
  const [row] = await getDb().select().from(worklogs).where(eq(worklogs.id, id));
  return row;
}

async function queue(t: ContractTime, w: Worklog, kind: "create" | "update" | "delete", remoteId = "") {
  const [entry] = await getDb()
    .insert(outbox)
    .values({ userId: w.userId, connectionId: t.conn.id, kind, issueKey: w.issueKey, remoteId: remoteId, worklogId: kind === "delete" ? null : w.id, timeSpentSeconds: w.timeSpentSeconds, started: w.started, comment: w.comment })
    .returning();
  return entry;
}

/** A new worklog: on the tracker now, or queued (its id "pending-N" until replayed). Refused by the tracker: not kept. */
export async function createThrough(t: ContractTime, input: { userId: number; issueKey: string; seconds: number; started: Date; comment: string }): Promise<Worklog> {
  const [row] = await getDb()
    .insert(worklogs)
    .values({
      userId: input.userId,
      connectionId: t.conn.id,
      issueKey: input.issueKey,
      remoteId: `new-${randomUUID()}`,
      timeSpentSeconds: input.seconds,
      started: input.started,
      comment: input.comment,
      authorAccountId: t.conn.remoteAccountId,
      syncedAt: new Date(),
    })
    .returning();
  try {
    await pushCreate(t.b, t.conn, row, t.ref, meta(), t.zone);
    await bumpSpent(t.conn, input.issueKey, input.seconds);
  } catch (e) {
    if (!queueable(e)) {
      await withDeleteReason("merged", (tx) => tx.delete(worklogs).where(eq(worklogs.id, row.id)));
      throw e;
    }
    const entry = await queue(t, row, "create");
    await getDb().update(worklogs).set({ remoteId: `pending-${entry.id}` }).where(eq(worklogs.id, row.id));
  }
  return reread(row.id);
}

/** A changed worklog: on the tracker now, or kept here and queued. Refused: nothing changes. */
export async function updateThrough(t: ContractTime, current: Worklog, fields: { timeSpentSeconds: number; started: Date; comment: string }): Promise<Worklog> {
  const next = { ...current, ...fields };
  try {
    await pushUpdate(t.b, t.conn, next, t.ref, meta(), t.zone);
    await bumpSpent(t.conn, current.issueKey, fields.timeSpentSeconds - current.timeSpentSeconds);
    // An older queued edit replayed later would undo this one.
    await dropQueuedUpdates(t.conn, current.id);
  } catch (e) {
    if (!queueable(e)) throw e;
    await dropQueuedUpdates(t.conn, current.id);
    await queue(t, next, "update", current.remoteId);
  }
  await getDb().update(worklogs).set({ ...fields, syncedAt: new Date() }).where(eq(worklogs.id, current.id));
  return reread(current.id);
}

/** A deleted worklog: gone from the tracker now, or queued; to the trash here either way. */
export async function deleteThrough(t: ContractTime, current: Worklog): Promise<void> {
  const [sink] = await getDb()
    .select({ remoteId: worklogSinks.remoteId })
    .from(worklogSinks)
    .where(and(eq(worklogSinks.worklogId, current.id), eq(worklogSinks.sinkConnectionId, t.conn.id)))
    .limit(1);
  // Its id on the service (a row from before the sink links: its own id); a placeholder
  // (local-, new-, pending-), on the row or copied to its link, names nothing there yet.
  const known = sink?.remoteId ?? current.remoteId;
  const remoteId = /^(local|new|pending)-/.test(known) ? null : known;
  await dropQueuedUpdates(t.conn, current.id);
  if (remoteId) {
    try {
      await deleteThere(t.b, meta(), t.ref, remoteId);
      await bumpSpent(t.conn, current.issueKey, -current.timeSpentSeconds);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "notFound") {
        // already gone there
      } else if (queueable(e)) {
        await queue(t, current, "delete", remoteId);
      } else {
        throw e;
      }
    }
  }
  await withDeleteReason("user", (tx) => tx.delete(worklogs).where(eq(worklogs.id, current.id)));
}

/**
 * A claim older than this belongs to a process that died mid-replay: the
 * entry is free again (every call has its own, shorter timeout).
 */
export const CLAIM_TTL_MS = 5 * 60_000;

/**
 * A worklog still being created on its tracker: its row "new-…", younger than
 * a claim's lease (every call has a shorter timeout), or filed through a sink
 * standing in for the tracker (Tempo) that hasn't taken it yet, however long
 * that takes. A sync that doesn't see it on the tracker must leave it be (its
 * answer, or its push, is on the way); otherwise its process died mid-create
 * and a sync may drop it.
 */
export const creationInFlight = (now = Date.now()): SQL =>
  sql`(${worklogs.remoteId} like 'new-%' and (${worklogs.syncedAt} > ${now - CLAIM_TTL_MS} or exists (select 1 from ${worklogSinks} join ${connections} on ${connections.id} = ${worklogSinks.sinkConnectionId} where ${worklogSinks.worklogId} = ${worklogs.id} and ${inArray(connections.type, COMPANION_TYPES)} and ${worklogSinks.state} <> 'synced')))`;

/** How long before queueing a timed-out create may have been stored by the service. */
const ADOPT_WINDOW_MS = 5 * 60_000;

/**
 * An entry of ours already on the service for this worklog (an earlier try
 * landed, its answer lost): same length, within a minute, by this account,
 * stored no earlier than shortly before it was queued, and linked to no
 * other worklog (or to a copy a sync read back meanwhile, identical: that
 * copy goes). The worklog is linked to it; true when one was.
 */
/** The same comment as words: how a tracker or a sync may store it (trimmed, spaces folded) aside. */
export const sameWords = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

async function adoptLanded(t: ContractTime, conn: Connection, local: Worklog, queuedAt: Date): Promise<boolean> {
  if (!t.b.worklogs?.list) return false;
  const db = getDb();
  const there = await t.b.worklogs.list(meta(), t.ref);
  const notBefore = queuedAt.getTime() - ADOPT_WINDOW_MS;
  const mine = { started: local.started, seconds: local.timeSpentSeconds };
  for (const w of there) {
    if (w.authorRemoteId !== conn.remoteAccountId || w.span.kind !== "session") continue;
    if (!sameTime({ started: new Date(w.span.start), seconds: w.span.seconds }, mine)) continue;
    if (w.createdAt && new Date(w.createdAt).getTime() < notBefore) continue;
    const [linked] = await db
      .select({ id: worklogs.id, started: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogSinks)
      .innerJoin(worklogs, eq(worklogs.id, worklogSinks.worklogId))
      .where(and(eq(worklogSinks.sinkConnectionId, conn.id), eq(worklogSinks.remoteId, w.remoteId)))
      .limit(1);
    // Another worklog's entry: only its copy a sync read back meanwhile (made after ours, the
    // same time) is ours to take; an older twin keeps it. (A twin logged while ours waited, the
    // same time, can't be told from that copy: its comment may have been edited since either.)
    if (linked && linked.id !== local.id && (linked.id < local.id || !sameTime({ started: linked.started, seconds: linked.seconds }, mine))) continue;
    await landedOn(local, conn, w.remoteId, w.version ?? null);
    // The comment changed while it waited: sent now, where the tracker changes an entry in
    // place (one that logs it again would churn, and keeps no comment on some: Gitea). Refused
    // there, the entry stays as it landed (the words here only); not answering, tried again.
    const write = entriesOf(t.b)?.write;
    if (write?.mode === "entry" && write.update === "native" && !sameWords(w.comment, local.comment)) {
      await pushUpdate(t.b, conn, local, t.ref, meta(), t.zone).catch((e: unknown) => {
        if (queueable(e)) throw e;
        if (!(e instanceof ProviderError)) console.error(e);
      });
    }
    return true;
  }
  return false;
}

/** The worklog is the service's entry `remoteId`: a copy of it a sync read back meanwhile goes (no trace). */
async function landedOn(local: Worklog, conn: Connection, remoteId: string, version: string | null) {
  await withDeleteReason("merged", async (tx) => {
    await tx
      .delete(worklogs)
      .where(and(eq(worklogs.userId, local.userId), eq(worklogs.connectionId, conn.id), eq(worklogs.issueKey, local.issueKey), eq(worklogs.remoteId, remoteId), ne(worklogs.id, local.id)));
    await tx.update(worklogs).set({ remoteId: remoteId, syncedAt: new Date() }).where(eq(worklogs.id, local.id));
  });
  await linkSink(local.id, conn.id, remoteId, version);
}

/** The worklog a queued change is about: by its link, or (queued before links) by its placeholder or remote id. */
async function queuedWorklog(entry: typeof outbox.$inferSelect, conn: Connection): Promise<Worklog | undefined> {
  const db = getDb();
  if (entry.worklogId !== null) return (await db.select().from(worklogs).where(eq(worklogs.id, entry.worklogId)))[0];
  const id = entry.kind === "create" ? `${PENDING}${entry.id}` : entry.remoteId;
  if (!id) return undefined;
  return (
    await db
      .select()
      .from(worklogs)
      .where(and(eq(worklogs.userId, entry.userId), eq(worklogs.connectionId, conn.id), eq(worklogs.issueKey, entry.issueKey), eq(worklogs.remoteId, id)))
  )[0];
}

const PENDING = "pending-";

/**
 * The connection's queued changes, in order, once its tracker answers again.
 * One replay per connection at a time (concurrent asks share it), never
 * alongside an edit of a queued worklog; each entry claimed first (another
 * server process may be replaying the same queue). Stops at the first one
 * it still can't reach (order matters, and being offline says nothing of the
 * entry: no attempt counted); a change the tracker refuses counts an
 * attempt and the queue goes on.
 */
export function replayContract(conn: Connection): Promise<ReplayResult> {
  return oneReplay(`${conn.userId}:${conn.id}`, () => withOutboxLock(conn.userId, () => doReplay(conn)));
}

async function doReplay(conn: Connection): Promise<ReplayResult> {
  const db = getDb();
  const entries = await db
    .select()
    .from(outbox)
    .where(and(eq(outbox.connectionId, conn.id), lt(outbox.attempts, MAX_OUTBOX_ATTEMPTS)))
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
  let synced = 0;
  let failed = 0;
  for (const queued of entries) {
    const now = Date.now();
    // Claimed atomically: discarded meanwhile, or another process has it (and the rest: order matters).
    const [entry] = await db
      .update(outbox)
      .set({ claimedAt: now })
      .where(and(eq(outbox.id, queued.id), or(isNull(outbox.claimedAt), lt(outbox.claimedAt, now - CLAIM_TTL_MS))))
      .returning();
    if (!entry) {
      const [still] = await db.select({ id: outbox.id }).from(outbox).where(eq(outbox.id, queued.id));
      if (still) break;
      continue;
    }
    const t = await contractTime(conn.userId, conn, entry.issueKey);
    if (!t) {
      await db.update(outbox).set({ claimedAt: null }).where(eq(outbox.id, entry.id));
      break;
    }
    try {
      if (entry.kind === "delete") {
        if (entry.remoteId) {
          await deleteThere(t.b, meta(), t.ref, entry.remoteId).catch((e: unknown) => {
            if (!(e instanceof ProviderError && e.kind === "notFound")) throw e;
          });
          // A sync between queueing and now may have read it back.
          await withDeleteReason("merged", (tx) =>
            tx.delete(worklogs).where(and(eq(worklogs.userId, conn.userId), eq(worklogs.connectionId, conn.id), eq(worklogs.issueKey, entry.issueKey), eq(worklogs.remoteId, entry.remoteId))),
          );
        }
      } else {
        const local = await queuedWorklog(entry, conn);
        // Gone here meanwhile (deleted while queued): nothing left to send.
        if (local) {
          if (entry.kind === "create") {
            if (!(await adoptLanded(t, conn, local, entry.createdAt))) await pushCreate(t.b, conn, local, t.ref, meta(), t.zone);
            await bumpSpent(conn, entry.issueKey, local.timeSpentSeconds);
          } else {
            await pushUpdate(t.b, conn, local, t.ref, meta(), t.zone);
          }
        }
      }
      await db.delete(outbox).where(eq(outbox.id, entry.id));
      synced++;
    } catch (e) {
      failed++;
      // A fault's details to the log: the queue shows general words for it.
      if (!(e instanceof ProviderError)) console.error(e);
      const offline = queueable(e);
      await db
        .update(outbox)
        // In the user's words (the queue shows it): a tracker's refusal, no answer, or a fault.
        .set({ attempts: offline ? entry.attempts : entry.attempts + 1, lastError: (e instanceof ProviderError ? providerTrpcError(e).message : tr("server.internal.error")).slice(0, 500), claimedAt: null })
        .where(eq(outbox.id, entry.id));
      if (offline) break;
    }
  }
  const remaining = await db.select({ id: outbox.id }).from(outbox).where(eq(outbox.userId, conn.userId));
  return { synced, failed, remaining: remaining.length };
}

/** A newer edit (or the delete) supersedes queued edits of the same worklog. */
async function dropQueuedUpdates(conn: Pick<Connection, "id">, worklogId: number) {
  await getDb()
    .delete(outbox)
    .where(and(eq(outbox.connectionId, conn.id), eq(outbox.kind, "update"), eq(outbox.worklogId, worklogId)));
}

/**
 * The tracker's total on the issue moved by what it just accepted: shown at
 * once instead of at the next sync, which sets the exact figure anyway.
 */
async function bumpSpent(conn: Pick<Connection, "id" | "userId">, issueKey: string, delta: number) {
  if (delta === 0) return;
  await getDb()
    .update(issues)
    .set({ timeSpentSeconds: sql`greatest(0, coalesce(${issues.timeSpentSeconds}, 0) + ${delta})` })
    .where(and(eq(issues.userId, conn.userId), eq(issues.connectionId, conn.id), eq(issues.key, issueKey)));
}
