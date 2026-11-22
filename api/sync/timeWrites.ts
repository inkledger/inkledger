// The user's time on a tracker that keeps entries (Jira included), through
// the provider contract: written through to the tracker (D10); while it
// can't be reached, queued in the outbox and replayed in order later. For
// Jira the calls are the ones its own path made (jira-gate.test.ts).
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { connections, issues, outbox, worklogs, worklogSinks, type Connection, type Worklog } from "@db/schema";
import { PENDING_PREFIX } from "@contracts/types";
import { COMPANION_TYPES } from "./companions";
import { MAX_OUTBOX_ATTEMPTS } from "@contracts/types";
import { instant, localDateOf, type TimeZone } from "@contracts/values";
import { getDb, type Db } from "../queries/connection";
import { issueAt } from "../queries/issueAt";
import { withDeleteReason } from "../queries/trash";
import { connOf } from "../providers/connections";
import type { BoundTracker } from "../providers/core/bind";
import { ProviderError } from "../providers/core/errors";
import { t as tr } from "@contracts/i18n";
import { certainRefusal, providerTrpcError } from "../providers/trpc";
import type { IssueRef, RemoteWorklog } from "../providers/types";
import { boundTracker } from "./engine";
import { createThere, deleteThere, dropOld, entriesOf, landed, linkSink, pushCreate, pushUpdate, sameTime, startOf } from "./worklogs";
import { oneReplay, withOutboxLock, type ReplayResult } from "./outboxLocks";
import { callMeta } from "../lib/callMeta";

/** Where one issue's time goes: its tracker, bound, the issue's reference there, the zone its dates are in. */
export type ContractTime = { conn: Connection; b: BoundTracker; ref: IssueRef; zone: TimeZone };

const meta = () => callMeta("time");

/** A failure worth trying again later (the tracker unreachable, busy, slow), not a refusal. */
const queueable = (e: unknown) => e instanceof ProviderError && e.transient;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A fault's details to the log (a ProviderError is the tracker's own words, shown to the user). */
const logFault = (e: unknown) => {
  if (!(e instanceof ProviderError)) console.error(e);
};

/** The issue's time through the contract, or null: a tracker keeping no entries (its time stays in inkledger). */
export async function contractTime(userId: number, conn: Connection, issueKey: string): Promise<ContractTime | null> {
  const b = boundTracker(conn);
  if (!b || !entriesOf(b)) return null;
  const [row] = await getDb()
    .select({ remoteId: issues.remoteId, projectKey: issues.projectKey })
    .from(issues)
    .where(issueAt(userId, conn.id, issueKey))
    .limit(1);
  const ref: IssueRef = { remoteId: row?.remoteId ?? issueKey, key: issueKey, ...(row?.projectKey ? { container: { remoteId: row.projectKey, key: row.projectKey } } : {}) };
  return { conn, b, ref, zone: connOf(conn).timeZone };
}

async function reread(id: number): Promise<Worklog> {
  const [row] = await getDb().select().from(worklogs).where(eq(worklogs.id, id));
  return row;
}

async function queue(t: ContractTime, w: Worklog, kind: "create" | "update" | "delete", remoteId = "", db: Db | Tx = getDb()) {
  const [entry] = await db
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
  // Queued: its replay first looks whether it landed (adoptLanded), so it is never logged twice.
  const queueIt = async () => {
    const entry = await queue(t, row, "create");
    await getDb().update(worklogs).set({ remoteId: `pending-${entry.id}` }).where(eq(worklogs.id, row.id));
  };
  let remote;
  try {
    remote = await createThere(t.b, row, t.ref, meta(), t.zone);
  } catch (e) {
    // Only a certain refusal drops it: no answer, a cancel or an odd answer may have landed.
    if (certainRefusal(e)) {
      await withDeleteReason("merged", (tx) => tx.delete(worklogs).where(eq(worklogs.id, row.id)));
      throw e;
    }
    logFault(e);
    await queueIt();
    return reread(row.id);
  }
  try {
    await landed(row, t.conn, remote);
  } catch (e) {
    // The tracker has it, this side failed to record it: kept, and linked at the replay.
    console.error(e);
    await queueIt().catch((err: unknown) => console.error(err));
    return reread(row.id);
  }
  // Only the issue's shown total: the next sync sets it anyway, the link is already recorded.
  await bumpSpent(t.conn, input.issueKey, input.seconds).catch((e: unknown) => console.error(e));
  return reread(row.id);
}

/** A changed worklog: on the tracker now, or kept here and queued. Refused: nothing changes. */
export async function updateThrough(t: ContractTime, current: Worklog, fields: { timeSpentSeconds: number; started: Date; comment: string }): Promise<Worklog> {
  const next = { ...current, ...fields };
  // Older queued edits taken first: no replay sends them under this one.
  const older = await claimQueuedUpdates(t.conn, current.id);
  let queued = false;
  try {
    await pushUpdate(t.b, t.conn, next, t.ref, meta(), t.zone);
  } catch (e) {
    // Only a certain refusal changes nothing: otherwise it may have landed, and sending the same values again is safe.
    if (certainRefusal(e)) {
      await releaseClaims(older);
      throw e;
    }
    logFault(e);
    queued = true;
  }
  // This side in one go: an older queued edit replayed later would undo this one.
  await getDb().transaction(async (tx) => {
    await dropQueuedUpdates(older, tx);
    if (queued) await queue(t, next, "update", current.remoteId, tx);
    else await bumpSpent(t.conn, current.issueKey, fields.timeSpentSeconds - current.timeSpentSeconds, tx);
    await tx.update(worklogs).set({ ...fields, syncedAt: new Date() }).where(eq(worklogs.id, current.id));
  });
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
  const older = await claimQueuedUpdates(t.conn, current.id);
  if (remoteId) {
    try {
      if ((await deleteThere(t.b, meta(), t.ref, remoteId)) === "deleted") await bumpSpent(t.conn, current.issueKey, -current.timeSpentSeconds);
    } catch (e) {
      if (!certainRefusal(e)) {
        // Deleting again is safe (gone already: done), so anything but a refusal is tried later.
        logFault(e);
        await queue(t, current, "delete", remoteId);
      } else {
        await releaseClaims(older);
        throw e;
      }
    }
  }
  await withDeleteReason("user", async (tx) => {
    await dropQueuedUpdates(older, tx);
    await tx.delete(worklogs).where(eq(worklogs.id, current.id));
  });
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

/** The entry holds this time: a session as sameTime, a day's entry on that day in the tracker's zone; the same length. */
const holds = (span: RemoteWorklog["span"], v: { started: Date; seconds: number }, zone: TimeZone) =>
  span.kind === "session" ? sameTime({ started: new Date(span.start), seconds: span.seconds }, v) : span.kind === "date" && span.seconds === v.seconds && span.date === localDateOf(instant(v.started.getTime()), zone);

async function adoptLanded(
  t: ContractTime,
  conn: Connection,
  local: Worklog,
  queuedAt: Date,
  replacing?: { remoteId: string; version: string | null },
  sent?: { started: Date; seconds: number; comment: string },
): Promise<boolean> {
  if (!t.b.worklogs?.list) return false;
  const db = getDb();
  const there = await t.b.worklogs.list(meta(), t.ref);
  // Entries the user deleted while offline (their delete still queued): never "ours, landed",
  // or that delete's replay would take this worklog with it.
  const deleting = new Set(
    (await db.select({ remoteId: outbox.remoteId }).from(outbox).where(and(eq(outbox.connectionId, conn.id), eq(outbox.kind, "delete")))).map((r) => r.remoteId),
  );
  const notBefore = queuedAt.getTime() - ADOPT_WINDOW_MS;
  // What was sent, which may differ from the worklog now (its time changed while queued).
  const mine = sent ?? { started: local.started, seconds: local.timeSpentSeconds };
  const words = sent?.comment ?? local.comment;
  for (const w of there) {
    if (w.authorRemoteId !== conn.remoteAccountId || w.remoteId === replacing?.remoteId || deleting.has(w.remoteId)) continue;
    if (!holds(w.span, mine, t.zone)) continue;
    // Only its day known: a twin is easier to mistake for it, so it must be bounded in time and carry the very words sent.
    if (w.span.kind !== "session" && (!w.createdAt || !sameWords(w.comment, words))) continue;
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
    // A day's copy is read back at its import start: one at another hour is a worklog of its own.
    if (linked && linked.id !== local.id && (linked.id < local.id || !sameTime({ started: linked.started, seconds: linked.seconds }, w.span.kind === "session" ? mine : { started: startOf(w.span, t.zone), seconds: w.span.seconds }))) continue;
    // A queued change is about an older worklog: any newer one of the same time may be a twin
    // the user logged, so only an entry linked to none is taken (read back meanwhile, it stays
    // twice, as it did; never another worklog's entry, and the old one with it, gone).
    // Nor one of the same time the user logged on the tracker itself (with no creation time to
    // bound it, on GitLab, of any age): ours carries the very words sent.
    if (replacing && ((linked && linked.id !== local.id) || !sameWords(w.comment, local.comment))) continue;
    await landedOn(local, conn, w.remoteId, w.version ?? null);
    // The entry it replaces goes, as after a recreate that was answered (queued if it can't now).
    if (replacing) await dropOld(t.b, conn, local, t.ref, meta(), replacing.remoteId, replacing.version);
    // Its time changed while it waited: the caller changes the entry, words included.
    if (sent && movedSince(sent, local)) return true;
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

/**
 * A change queued where the tracker logs an entry again (GitLab, Gitea): the new entry may
 * have landed with its answer lost. Taken as a create's would be (adoptLanded, the entry it
 * replaces never), so the retry doesn't log the time twice; the old entry goes then.
 */
async function adoptRecreated(t: ContractTime, conn: Connection, local: Worklog, queuedAt: Date): Promise<boolean> {
  const write = entriesOf(t.b)?.write;
  if (write?.mode !== "entry" || write.update !== "recreate") return false;
  const [sink] = await getDb()
    .select({ remoteId: worklogSinks.remoteId, version: worklogSinks.version })
    .from(worklogSinks)
    .where(and(eq(worklogSinks.worklogId, local.id), eq(worklogSinks.sinkConnectionId, conn.id)))
    .limit(1);
  // Nothing there yet (no link, or a placeholder copied to it): nothing to replace.
  if (!sink?.remoteId || /^(local|new|pending)-/.test(sink.remoteId)) return false;
  return adoptLanded(t, conn, local, queuedAt, { remoteId: sink.remoteId, version: sink.version });
}

/**
 * The service's entry for this worklog already holds its time and words (a queued edit that
 * landed, its answer lost): its new revision is recorded, nothing is sent again. True when so.
 */
async function alreadyUpdated(t: ContractTime, conn: Connection, local: Worklog): Promise<boolean> {
  if (!t.b.worklogs?.list) return false;
  const [sink] = await getDb()
    .select({ remoteId: worklogSinks.remoteId })
    .from(worklogSinks)
    .where(and(eq(worklogSinks.worklogId, local.id), eq(worklogSinks.sinkConnectionId, conn.id)))
    .limit(1);
  const id = sink?.remoteId ?? local.remoteId;
  const w = (await t.b.worklogs.list(meta(), t.ref)).find((x) => x.remoteId === id);
  if (!w || !holds(w.span, { started: local.started, seconds: local.timeSpentSeconds }, t.zone) || !sameWords(w.comment, local.comment)) return false;
  await linkSink(local.id, conn.id, w.remoteId, w.version ?? null);
  return true;
}

/** How far the service's clock may be from ours when it stamps an entry it made. */
const CLOCK_SKEW_MS = 60_000;

/** A queued delete of a create whose answer was lost: no id there, the values sent, when it may have landed. */
export const isLostCreate = (e: Pick<typeof outbox.$inferSelect, "kind" | "remoteId" | "landedAfter">) => e.kind === "delete" && !e.remoteId && e.landedAfter !== null;

/**
 * The entry is the lost create such a delete is about: the values sent, the very words, made
 * after its first send and before the delete (a day's entry, or one with no creation time
 * known, only where it keeps a start: it is deleted, so never a guess).
 */
export function buriedBy(
  tomb: Pick<typeof outbox.$inferSelect, "started" | "timeSpentSeconds" | "comment" | "landedAfter" | "createdAt">,
  e: Pick<RemoteWorklog, "span" | "comment" | "createdAt">,
  zone: TimeZone,
): boolean {
  if (!tomb.started || !tomb.landedAfter) return false;
  if (!holds(e.span, { started: tomb.started, seconds: tomb.timeSpentSeconds }, zone) || !sameWords(e.comment, tomb.comment)) return false;
  if (e.createdAt == null) return e.span.kind === "session";
  const at = Number(e.createdAt);
  return at >= tomb.landedAfter.getTime() - CLOCK_SKEW_MS && at <= tomb.createdAt.getTime() + CLOCK_SKEW_MS;
}

/**
 * A queued create dropped with its worklog (deleted while queued): sent at least once, it
 * may have landed with its answer lost, so a delete carrying the values sent looks for it.
 */
export async function buryLostCreate(taken: typeof outbox.$inferSelect, db: Db | Tx = getDb()) {
  if (taken.kind !== "create") return;
  await db.insert(outbox).values({
    userId: taken.userId,
    connectionId: taken.connectionId,
    itemId: taken.itemId,
    kind: "delete",
    issueKey: taken.issueKey,
    remoteId: "",
    timeSpentSeconds: taken.timeSpentSeconds,
    started: taken.started,
    comment: taken.comment,
    landedAfter: new Date(taken.createdAt.getTime() - ADOPT_WINDOW_MS),
  });
}

/** The entry a lost create left, found by its delete (only one linked to no worklog: never another's), deleted there. */
async function dropLanded(t: ContractTime, conn: Connection, tomb: typeof outbox.$inferSelect) {
  // No list there: nothing to look for.
  if (!t.b.worklogs?.list) return;
  const there = await t.b.worklogs.list(meta(), t.ref);
  for (const w of there) {
    if (w.authorRemoteId !== conn.remoteAccountId || !buriedBy(tomb, w, t.zone)) continue;
    const [linked] = await getDb()
      .select({ id: worklogSinks.id })
      .from(worklogSinks)
      .where(and(eq(worklogSinks.sinkConnectionId, conn.id), eq(worklogSinks.remoteId, w.remoteId)))
      .limit(1);
    if (linked) continue;
    await deleteThere(t.b, meta(), t.ref, w.remoteId);
    return;
  }
}

/** The worklog's time is no longer what was sent. */
const movedSince = (sent: { started: Date; seconds: number }, local: Worklog) => sent.seconds !== local.timeSpentSeconds || sent.started.getTime() !== local.started.getTime();

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
  const id = entry.kind === "create" ? `${PENDING_PREFIX}${entry.id}` : entry.remoteId;
  if (!id) return undefined;
  return (
    await db
      .select()
      .from(worklogs)
      .where(and(eq(worklogs.userId, entry.userId), eq(worklogs.connectionId, conn.id), eq(worklogs.issueKey, entry.issueKey), eq(worklogs.remoteId, id)))
  )[0];
}

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
          await deleteThere(t.b, meta(), t.ref, entry.remoteId);
          // A sync between queueing and now may have read it back.
          await withDeleteReason("merged", (tx) =>
            tx.delete(worklogs).where(and(eq(worklogs.userId, conn.userId), eq(worklogs.connectionId, conn.id), eq(worklogs.issueKey, entry.issueKey), eq(worklogs.remoteId, entry.remoteId))),
          );
        } else if (isLostCreate(entry)) await dropLanded(t, conn, entry);
      } else {
        const local = await queuedWorklog(entry, conn);
        // Gone here meanwhile (deleted while queued): nothing left to send.
        if (local) {
          const sendUpdate = async (local: Worklog) => {
            if (await adoptRecreated(t, conn, local, entry.createdAt)) return;
            await pushUpdate(t.b, conn, local, t.ref, meta(), t.zone).catch(async (e: unknown) => {
              // An earlier try landed, its answer lost: the entry moved on to these very values.
              if (!(e instanceof ProviderError && e.kind === "conflict" && (await alreadyUpdated(t, conn, local)))) throw e;
            });
          };
          if (entry.kind === "create") {
            // As last sent (an edit while queued changes only the worklog): what may have landed.
            const sent = { started: entry.started ?? local.started, seconds: entry.timeSpentSeconds, comment: entry.comment };
            const adopted = await adoptLanded(t, conn, local, entry.createdAt, undefined, sent);
            if (!adopted) {
              // This try's values: its answer lost too, the next replay looks for these.
              await db.update(outbox).set({ timeSpentSeconds: local.timeSpentSeconds, started: local.started, comment: local.comment }).where(eq(outbox.id, entry.id));
              await pushCreate(t.b, conn, local, t.ref, meta(), t.zone);
            }
            // Only the issue's shown total: a failure here must not send the entry again.
            await bumpSpent(conn, entry.issueKey, local.timeSpentSeconds).catch((e: unknown) => console.error(e));
            if (adopted && movedSince(sent, local)) {
              // Landed with its old time: changed as a queued edit (kept as one if this try fails).
              const now = await reread(local.id);
              await db.update(outbox).set({ kind: "update", remoteId: now.remoteId, timeSpentSeconds: now.timeSpentSeconds, started: now.started, comment: now.comment }).where(eq(outbox.id, entry.id));
              await sendUpdate(now);
            }
          } else await sendUpdate(local);
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

/**
 * The worklog's queued edits, claimed for a newer change (or its delete), which supersedes
 * them: a replay (here or in another process on this database) skips them meanwhile. One a
 * replay is sending right now is never taken from under it: the change waits (CONFLICT).
 */
async function claimQueuedUpdates(conn: Pick<Connection, "id">, worklogId: number): Promise<number[]> {
  const db = getDb();
  const now = Date.now();
  const queued = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.connectionId, conn.id), eq(outbox.kind, "update"), eq(outbox.worklogId, worklogId)));
  if (queued.length === 0) return [];
  const ids = queued.map((r) => r.id);
  const taken = await db
    .update(outbox)
    .set({ claimedAt: now })
    .where(and(inArray(outbox.id, ids), or(isNull(outbox.claimedAt), lt(outbox.claimedAt, now - CLAIM_TTL_MS))))
    .returning({ id: outbox.id });
  if (taken.length < ids.length) {
    await releaseClaims(taken.map((r) => r.id));
    throw new TRPCError({ code: "CONFLICT", message: tr("server.worklogs.justSynced") });
  }
  return ids;
}

/** Claimed edits given back to the queue (the change that claimed them was refused). */
async function releaseClaims(ids: number[]) {
  if (ids.length) await getDb().update(outbox).set({ claimedAt: null }).where(inArray(outbox.id, ids));
}

/** Claimed edits a newer change superseded: gone. */
async function dropQueuedUpdates(ids: number[], db: Db | Tx = getDb()) {
  if (ids.length) await db.delete(outbox).where(inArray(outbox.id, ids));
}

/**
 * The tracker's total on the issue moved by what it just accepted: shown at
 * once instead of at the next sync, which sets the exact figure anyway.
 */
async function bumpSpent(conn: Pick<Connection, "id" | "userId">, issueKey: string, delta: number, db: Db | Tx = getDb()) {
  if (delta === 0) return;
  await db
    .update(issues)
    .set({ timeSpentSeconds: sql`greatest(0, coalesce(${issues.timeSpentSeconds}, 0) + ${delta})` })
    .where(issueAt(conn.userId, conn.id, issueKey));
}
