// Time sinks besides each worklog's own tracker (Harvest, Clockify, Toggl,
// Everhour…): every worklog of the user goes to each of their sink
// connections too, after the fact and in the background, never holding up a
// log. A worklog's place on each sink is a worklog_sinks row: "pending"
// until sent, "synced" with the sink's id, "failed" with why (no target
// mapped, refused). A deleted worklog leaves its sink entries to delete in
// the outbox (its rows go with it). Filed under the target its container is
// mapped to (sink_mappings), else the sink's default. A sink can instead
// stand in for one tracker connection (Tempo for its Jira, sync/companion.ts):
// it takes only the worklogs filed through it, and the tracker's own id of
// each is kept on the worklog.
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { connections, issues, outbox, sinkMappings, worklogs, worklogSinks, type Connection, type Worklog } from "@db/schema";
import { TIME_SINK_TYPES, type TimeSinkType, type TrackerType } from "@contracts/providers";
import { instant, localDate, localDateOf, type TimeZone } from "@contracts/values";
import { getDb } from "../queries/connection";
import { liveConnections } from "../queries/liveConnections";
import { issueAt } from "../queries/issueAt";
import { bindSink, type BoundSink } from "../providers/core/bind";
import { goneIsDone, ProviderError } from "../providers/core/errors";
import { connectionOptions, connOf } from "../providers/connections";
import { sinkAdapter, sinkStatus } from "../providers/registry";
import type { ExternalRef, RemoteWorklog, SinkTarget, WorklogInput } from "../providers/types";
import { withDeleteReason } from "../queries/trash";
import { linkSink, roundingSlack, timeInput } from "./worklogs";
import { COMPANIONS } from "./companions";
import { MAX_OUTBOX_ATTEMPTS } from "@contracts/types";
import { backoffMs } from "./state";
import { buriedBy, CLAIM_TTL_MS, holds, isLostCreate, sameWords, unbury } from "./timeWrites";
import { inMaintenance } from "../lib/maintenance";
import { callMeta } from "../lib/callMeta";

const meta = () => callMeta("sink");
const SINKS = new Set<string>(TIME_SINK_TYPES);
export { COMPANIONS } from "./companions";
const BESIDE = (type: string) => SINKS.has(type) && !COMPANIONS[type as TimeSinkType];

/** Unverified sinks write only once the user allowed it. */
const mayWrite = (c: Connection) => sinkStatus(c.type as TimeSinkType) !== "experimental" || c.writesAllowed === 1;

/** The user's live sink connections beside their trackers. */
async function sinkConnections(userId: number): Promise<Connection[]> {
  return (await liveConnections(userId, { okOnly: true })).filter((c) => BESIDE(c.type));
}

/** The tracker connection a sink stands in for, or null (a sink beside every tracker). */
export function trackerOfSink(c: Connection): number | null {
  const k = COMPANIONS[c.type as TimeSinkType];
  const id = k ? Number(connectionOptions(c)[k.option]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The live sink standing in for this tracker connection and allowed to write, if any: its new worklogs go there. */
export async function companionOf(tracker: Connection): Promise<Connection | null> {
  return (await liveConnections(tracker.userId, { okOnly: true })).find((c) => trackerOfSink(c) === tracker.id && mayWrite(c)) ?? null;
}

async function companionConnections(userId: number): Promise<Connection[]> {
  return (await liveConnections(userId, { okOnly: true })).filter((c) => trackerOfSink(c) !== null);
}

/** A sink connection bound (unverified integrations write only once allowed). */
export function boundSink(conn: Connection): BoundSink | null {
  const adapter = sinkAdapter(conn.type as TimeSinkType);
  if (!adapter) return null;
  return bindSink(adapter, { ...connOf(conn), type: conn.type as TimeSinkType, writable: mayWrite(conn) });
}

/** A worklog logged or changed: due on every sink of its user. */
export async function markForSinks(userId: number, worklogId: number) {
  const sinks = await sinkConnections(userId);
  if (sinks.length === 0) return;
  await getDb()
    .insert(worklogSinks)
    .values(sinks.map((s) => ({ worklogId, sinkConnectionId: s.id, state: "pending" })))
    .onConflictDoUpdate({
      target: [worklogSinks.worklogId, worklogSinks.sinkConnectionId],
      // A push under way sees the revision moved: it leaves the link due instead of marking it sent.
      set: { state: "pending", lastError: null, revision: sql`${worklogSinks.revision} + 1` },
    });
}

/**
 * A time sink's delete written before its worklog's delete went through:
 * held, tied to the worklog (worklog_id), until the worklog is gone. The
 * database then clears worklog_id (ON DELETE SET NULL) and the delete is due.
 * A worklog its tracker kept keeps its sink entries; a crash in between
 * converges either way: gone, the delete goes; still here, it stays held and
 * the next delete writes it again.
 */
export const heldSinkDelete: SQL = sql`(${outbox.kind} = 'delete' and ${outbox.worklogId} is not null)`;

/** A worklog about to be deleted: its entries on the sinks beside its tracker, held until it is gone (written again, never twice). */
export async function holdSinkDeletes(w: Worklog): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ sink: worklogSinks.sinkConnectionId, remoteId: worklogSinks.remoteId })
    .from(worklogSinks)
    .innerJoin(connections, eq(connections.id, worklogSinks.sinkConnectionId))
    .where(and(eq(worklogSinks.worklogId, w.id), sql`${worklogSinks.remoteId} IS NOT NULL`, inArray(connections.type, TIME_SINK_TYPES.filter(BESIDE))));
  // Its issue, so a day-totals sink recounts its own tracker's day only (a key may be on two trackers).
  const [item] = w.connectionId === null ? [] : await db.select({ id: issues.id }).from(issues).where(issueAt(w.userId, w.connectionId, w.issueKey)).limit(1);
  const values = rows.flatMap((r) =>
    !r.remoteId || r.sink === w.connectionId
      ? []
      : [{ userId: w.userId, connectionId: r.sink, itemId: item?.id ?? null, kind: "delete", issueKey: w.issueKey, remoteId: r.remoteId, worklogId: w.id, timeSpentSeconds: w.timeSpentSeconds, started: w.started }],
  );
  await db.transaction(async (tx) => {
    // Still here, and kept until this commits: gone (another delete got there first, its
    // own sink deletes queued), there is nothing to hold, and no row may point at it.
    const [still] = await tx.select({ id: worklogs.id }).from(worklogs).where(eq(worklogs.id, w.id)).for("key share");
    if (!still) return;
    await tx.delete(outbox).where(and(heldSinkDelete, eq(outbox.worklogId, w.id)));
    if (values.length > 0) await tx.insert(outbox).values(values);
  });
}

/** The worklog stayed (its tracker refused the delete): its held sink deletes go. */
export async function dropHeldSinkDeletes(worklogId: number): Promise<void> {
  await getDb().delete(outbox).where(and(heldSinkDelete, eq(outbox.worklogId, worklogId)));
}

type Mapping = { target: SinkTarget; activityId: string | null };

async function mappingFor(sinkId: number, containerId: number | null): Promise<Mapping | null> {
  const rows = await getDb()
    .select()
    .from(sinkMappings)
    .where(and(eq(sinkMappings.sinkConnectionId, sinkId), containerId === null ? isNull(sinkMappings.containerId) : or(eq(sinkMappings.containerId, containerId), isNull(sinkMappings.containerId))));
  const own = rows.find((r) => r.containerId === containerId) ?? rows.find((r) => r.containerId === null);
  if (!own) return null;
  let path: SinkTarget["path"] = [];
  try {
    path = JSON.parse(own.targetPath) as SinkTarget["path"];
  } catch {
    path = [];
  }
  return { target: { remoteId: own.targetRemoteId, name: own.targetName, path }, activityId: own.activityId };
}

/** The issue a worklog is on, as a sink names it back (its tracker, key, link, title). */
async function refOf(w: { userId: number; connectionId: number | null; issueKey: string }): Promise<{ ref: ExternalRef; containerId: number | null }> {
  // Its own connection's issue; one whose worklog is gone (a deleted day on a day-total sink): the key on any of the user's.
  const [i] = await getDb()
    .select({ remoteId: issues.remoteId, key: issues.key, url: issues.url, summary: issues.summary, containerId: issues.containerId, type: connections.type, connectionId: issues.connectionId })
    .from(issues)
    .innerJoin(connections, eq(connections.id, issues.connectionId))
    .where(and(eq(issues.userId, w.userId), w.connectionId === null ? sql`true` : eq(issues.connectionId, w.connectionId), eq(issues.key, w.issueKey)))
    .limit(1);
  const [c] = i ? [] : await getDb().select({ type: connections.type }).from(connections).where(eq(connections.id, w.connectionId ?? -1));
  return {
    ref: {
      trackerType: (i?.type ?? c?.type ?? "jira") as TrackerType,
      trackerConnectionId: w.connectionId ?? i?.connectionId ?? 0,
      issue: { remoteId: i?.remoteId ?? w.issueKey, key: w.issueKey },
      snapshot: { url: i?.url ?? "", title: i?.summary ?? w.issueKey },
    },
    containerId: i?.containerId ?? null,
  };
}

const fail = async (worklogId: number, sinkId: number, why: string) =>
  getDb()
    .update(worklogSinks)
    .set({ state: "failed", lastError: why.slice(0, 500) })
    .where(and(eq(worklogSinks.worklogId, worklogId), eq(worklogSinks.sinkConnectionId, sinkId)));

/**
 * A worklog a stand-in sink filed: the tracker's own id of it on the worklog
 * (its feed reads it back as this one), a copy read back before the answer
 * came folded into it.
 */
async function adoptTrackerId(w: Worklog, trackerId: string) {
  if (w.connectionId === null) return;
  const connectionId = w.connectionId;
  if (w.remoteId !== trackerId) {
    await withDeleteReason("merged", async (tx) => {
      await tx
        .delete(worklogs)
        .where(and(eq(worklogs.userId, w.userId), eq(worklogs.connectionId, connectionId), eq(worklogs.issueKey, w.issueKey), eq(worklogs.remoteId, trackerId), ne(worklogs.id, w.id)));
      await tx.update(worklogs).set({ remoteId: trackerId }).where(eq(worklogs.id, w.id));
    });
  }
  await linkSink(w.id, connectionId, trackerId, null);
}

/** How far a sink's clock may be behind ours when it stamps an entry it just made. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Where the sink honours no idempotency key (Tempo), a create sent before with its answer lost
 * (no answer, an odd one, a fault here) may be there already: before sending it again, the
 * day's entries are read. Ours: on its issue, the time last sent (the worklog may have changed
 * since: then `moved`), by this account, made after the first send, and linked to no other
 * worklog. The first send's time and the values sent are on its link.
 */
async function landedBefore(b: BoundSink, sink: Connection, w: Worklog, ref: ExternalRef, zone: TimeZone): Promise<{ e: RemoteWorklog; moved: boolean } | null> {
  if (b.capabilities.entries.idempotency !== "local") return null;
  const db = getDb();
  const [link] = await db
    .select({ sentAt: worklogSinks.syncedAt, seconds: worklogSinks.sentSeconds, started: worklogSinks.sentStarted, comment: worklogSinks.sentComment })
    .from(worklogSinks)
    .where(and(eq(worklogSinks.worklogId, w.id), eq(worklogSinks.sinkConnectionId, sink.id)));
  if (!link?.sentAt) return null;
  const sent = link.seconds !== null && link.started ? { started: link.started, seconds: link.seconds, comment: link.comment ?? "" } : { started: w.started, seconds: w.timeSpentSeconds, comment: w.comment };
  const moved = sent.seconds !== w.timeSpentSeconds || sent.started.getTime() !== w.started.getTime() || sent.comment !== w.comment;
  const day = localDateOf(instant(sent.started.getTime()), zone);
  const there = await b.entries.list(meta(), { from: day, to: day });
  for (const e of there) {
    if (e.authorRemoteId !== sink.remoteAccountId) continue;
    if (!e.issue || (e.issue.remoteId !== ref.issue.remoteId && e.issue.key !== ref.issue.key)) continue;
    if (!holds(e.span, sent, zone, e.dayOnly, roundingSlack(b.capabilities.entries.limits, sent.seconds))) continue;
    // Only its day known: a twin is easier to mistake for it, so it must be bounded in time and carry the very words sent.
    if ((e.span.kind !== "session" || e.dayOnly) && (e.createdAt == null || !sameWords(e.comment, sent.comment))) continue;
    if (e.createdAt != null && Number(e.createdAt) < link.sentAt.getTime() - CLOCK_SKEW_MS) continue;
    const [taken] = await db
      .select({ id: worklogSinks.id })
      .from(worklogSinks)
      .where(and(eq(worklogSinks.sinkConnectionId, sink.id), eq(worklogSinks.remoteId, e.remoteId)));
    if (!taken) return { e, moved };
  }
  return null;
}

/** A create on the sink, its first send's time and this send's values kept on the link (landedBefore reads them). */
async function createOnce(b: BoundSink, sink: Connection, w: Worklog, ref: ExternalRef, target: SinkTarget | null, input: WorklogInput): Promise<RemoteWorklog> {
  if (b.capabilities.entries.idempotency === "local") {
    await getDb()
      .update(worklogSinks)
      .set({ syncedAt: sql`coalesce(${worklogSinks.syncedAt}, ${Date.now()})`, sentSeconds: w.timeSpentSeconds, sentStarted: w.started, sentComment: w.comment })
      .where(and(eq(worklogSinks.worklogId, w.id), eq(worklogSinks.sinkConnectionId, sink.id)));
  }
  return b.entries.create!(meta(), ref, target, input, { idempotencyKey: w.uuid });
}

/**
 * A create of a worklog deleted before its answer came (queued with the values sent): its
 * entry on the sink, as landedBefore finds one, made before the delete; or null.
 */
async function buriedEntry(b: BoundSink, sink: Connection, g: typeof outbox.$inferSelect): Promise<RemoteWorklog | null> {
  if (!g.started) return null;
  const zone = connOf(sink).timeZone;
  const { ref } = await refOf({ userId: g.userId, connectionId: trackerOfSink(sink), issueKey: g.issueKey });
  const day = localDateOf(instant(g.started.getTime()), zone);
  for (const e of await b.entries.list(meta(), { from: day, to: day })) {
    if (e.authorRemoteId !== sink.remoteAccountId || !e.issue || (e.issue.remoteId !== ref.issue.remoteId && e.issue.key !== ref.issue.key)) continue;
    if (!buriedBy(g, e, zone, roundingSlack(b.capabilities.entries.limits, g.timeSpentSeconds))) continue;
    const [taken] = await getDb()
      .select({ id: worklogSinks.id })
      .from(worklogSinks)
      .where(and(eq(worklogSinks.sinkConnectionId, sink.id), eq(worklogSinks.remoteId, e.remoteId)));
    if (!taken) return e;
  }
  return null;
}

/** One worklog onto one sink: created, changed, or its day's total set. */
export async function pushOne(b: BoundSink, sink: Connection, w: Worklog, remoteId: string | null) {
  const c = b.capabilities;
  const { ref, containerId } = await refOf(w);
  const mapped = await mappingFor(sink.id, containerId);
  if (c.target.use === "required" && !mapped) return fail(w.id, sink.id, "noTarget");
  const target = c.target.use === "none" ? null : (mapped?.target ?? null);
  const zone = connOf(sink).timeZone;
  const linkOf = and(eq(worklogSinks.worklogId, w.id), eq(worklogSinks.sinkConnectionId, sink.id));
  // The worklog as it is when this push starts: a change after it leaves the link due.
  const [link] = await getDb().select({ revision: worklogSinks.revision, pushedDay: worklogSinks.pushedDay }).from(worklogSinks).where(linkOf);
  let landed: RemoteWorklog | null;
  let day: string | null = null;
  if (c.entries.model === "dayTotals") {
    // The issue's total that day, all its worklogs together.
    const on = localDateOf(instant(w.started.getTime()), zone);
    day = on;
    const same = await getDb()
      .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(and(eq(worklogs.userId, w.userId), eq(worklogs.connectionId, w.connectionId ?? -1), eq(worklogs.issueKey, w.issueKey)));
    const totalOn = (d: string) => same.filter((x) => localDateOf(instant(x.started.getTime()), zone) === d).reduce((a, x) => a + x.seconds, 0);
    const total = totalOn(on);
    landed = await b.entries.setDayTotal!(meta(), ref, target, on, total, { idempotencyKey: `${w.uuid}:${on}:${total}` });
    // Moved from another day: that day's total is set again too, without it.
    const before = link?.pushedDay ? localDate(link.pushedDay) : null;
    if (before && before !== on) {
      const left = totalOn(before);
      await b.entries.setDayTotal!(meta(), ref, target, before, left, { idempotencyKey: `${w.uuid}:${before}:${left}` });
    }
  } else {
    const input: WorklogInput = {
      time: timeInput(c.entries.shape, w, zone),
      comment: w.comment,
      ...(mapped?.activityId ? { activityId: mapped.activityId } : {}),
    };
    const found = remoteId && b.entries.update ? null : await landedBefore(b, sink, w, ref, zone);
    if (remoteId && b.entries.update) landed = await b.entries.update(meta(), remoteId, input, {});
    else if (found?.moved && b.entries.update) {
      // Landed as sent before an edit: its entry first (a failed change is sent as one next time), then changed.
      await getDb().update(worklogSinks).set({ remoteId: found.e.remoteId }).where(linkOf);
      const trackerId = COMPANIONS[sink.type as TimeSinkType]?.trackerIdOf(found.e);
      if (trackerId) await adoptTrackerId(w, trackerId);
      landed = await b.entries.update(meta(), found.e.remoteId, input, {});
    } else landed = found?.e ?? (await createOnce(b, sink, w, ref, target, input));
  }
  const sent = { remoteId: landed?.remoteId ?? remoteId, version: landed?.version ?? null, lastError: null, syncedAt: new Date(), ...(day ? { pushedDay: day } : {}) };
  const done = await getDb()
    .update(worklogSinks)
    .set({ ...sent, state: "synced" })
    .where(and(linkOf, eq(worklogSinks.revision, link?.revision ?? 0)))
    .returning({ id: worklogSinks.id });
  // Changed while it was sending: what landed is kept (the next push updates it), the link stays due.
  if (done.length === 0) {
    const kept = await getDb().update(worklogSinks).set(sent).where(linkOf).returning({ id: worklogSinks.id });
    // Its worklog deleted while this create was under way: the entry it left goes too.
    if (kept.length === 0 && !remoteId && landed && c.entries.model !== "dayTotals") return dropOrphan(b, sink, w, landed.remoteId);
  }
  const companion = COMPANIONS[sink.type as TimeSinkType];
  const trackerId = companion && landed ? companion.trackerIdOf(landed) : null;
  if (trackerId) await adoptTrackerId(w, trackerId);
}

/** An entry left by a create whose worklog was deleted meanwhile: deleted there, or queued to be. */
async function dropOrphan(b: BoundSink, sink: Connection, w: Worklog, entryId: string) {
  if (!b.entries.delete) return;
  try {
    await goneIsDone(b.entries.delete(meta(), entryId, {}));
  } catch (e) {
    if (!(e instanceof ProviderError && e.transient)) console.error(e);
    await getDb().insert(outbox).values({ userId: w.userId, connectionId: sink.id, kind: "delete", issueKey: w.issueKey, remoteId: entryId, timeSpentSeconds: w.timeSpentSeconds, started: w.started });
  }
}

const running = new Set<number>();

/**
 * The user's pending sink work, each sink in turn: entries to send, then
 * entries to delete. A sink out of reach keeps its work for the next pass;
 * one that refuses an entry says why on it. Unverified sinks whose writes
 * aren't allowed yet keep everything pending.
 */
/** Worklogs and deletes sent to one sink in a pass: the rest waits for the next pass. */
const SINK_BATCH = 100;

/** The wait before a failed delete's next try: a minute after the first failure, doubling after each (the sync's backoff), at most an hour. */
export const deleteRetryDelayMs = (attempts: number) => backoffMs(attempts + 1);

export async function pushSinks(userId: number, now: () => number = Date.now, o: { force?: boolean } = {}): Promise<{ sent: number; failed: number }> {
  // A restore replacing the database: the next pass sends it.
  if (running.has(userId) || inMaintenance()) return { sent: 0, failed: 0 };
  running.add(userId);
  let sent = 0;
  let failed = 0;
  try {
    const db = getDb();
    const [beside, companions] = await Promise.all([sinkConnections(userId), companionConnections(userId)]);
    for (const sink of [...beside, ...companions]) {
      const b = boundSink(sink);
      if (!b || !mayWrite(sink)) continue;
      const leaseOver = () => or(isNull(worklogSinks.claimedAt), lt(worklogSinks.claimedAt, now() - CLAIM_TTL_MS));
      const due = await db
        .select({ w: worklogs, remoteId: worklogSinks.remoteId, linkId: worklogSinks.id })
        .from(worklogSinks)
        .innerJoin(worklogs, eq(worklogs.id, worklogSinks.worklogId))
        .where(and(eq(worklogSinks.sinkConnectionId, sink.id), eq(worklogSinks.state, "pending"), leaseOver()))
        .orderBy(asc(worklogs.id))
        .limit(SINK_BATCH);
      // Claimed first, all at once: another server process on this database skips them
      // (two passes would send an entry twice, or race a day's total).
      const mine = due.length
        ? new Set(
            (
              await db
                .update(worklogSinks)
                .set({ claimedAt: now() })
                .where(and(inArray(worklogSinks.id, due.map((d) => d.linkId)), leaseOver()))
                .returning({ id: worklogSinks.id })
            ).map((r) => r.id),
          )
        : new Set<number>();
      try {
        for (const { w, remoteId, linkId } of due) {
          if (!mine.has(linkId)) continue;
          try {
            await pushOne(b, sink, w, remoteId);
            sent++;
          } catch (e) {
            if (e instanceof ProviderError && e.transient) break;
            failed++;
            await fail(w.id, sink.id, e instanceof Error ? e.message : String(e));
          }
        }
      } finally {
        if (mine.size) await db.update(worklogSinks).set({ claimedAt: null }).where(inArray(worklogSinks.id, [...mine]));
      }
      // Deletes still to try (under the attempts cap, their wait over), oldest first;
      // the user's own "Send now" tries them all, waiting or stuck.
      const gone = await db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.connectionId, sink.id),
            eq(outbox.kind, "delete"),
            // Held while its worklog is still here (heldSinkDelete).
            isNull(outbox.worklogId),
            ...(o.force ? [] : [lt(outbox.attempts, MAX_OUTBOX_ATTEMPTS), or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, now()))]),
          ),
        )
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(SINK_BATCH);
      // Claimed first, all at once, as the trackers' queue is (timeWrites): another server
      // process on the same database skips them. Sent ones go in one delete at the end (a
      // crash before it: they are tried again once their claim runs out, and each send is
      // idempotent: its key, and a delete already done counts as done).
      const at = now();
      const claimedRows = gone.length === 0
        ? []
        : await db
            .update(outbox)
            .set({ claimedAt: at })
            .where(and(inArray(outbox.id, gone.map((g) => g.id)), or(isNull(outbox.claimedAt), lt(outbox.claimedAt, at - CLAIM_TTL_MS))))
            .returning();
      const order = new Map(gone.map((g, i) => [g.id, i]));
      const claimed = claimedRows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      // What a day's total is made of, read once per issue for the pass: its tracker, its ref, its worklogs.
      const trackers = new Map<number, number | null>();
      const refs = new Map<string, Awaited<ReturnType<typeof refOf>>>();
      const left = new Map<string, { started: Date; seconds: number }[]>();
      const done: number[] = [];
      try {
        for (let i = 0; i < claimed.length; i++) {
          const g = claimed[i];
          try {
            if (isLostCreate(g)) {
              // No id there: the entry its create may have left, looked for and deleted.
              const e = await buriedEntry(b, sink, g);
              if (e && b.entries.delete) await goneIsDone(b.entries.delete(meta(), e.remoteId, {}));
            } else if (b.capabilities.entries.model === "dayTotals") {
              // A day's total without the deleted worklog (0 removes the day): its own
              // tracker's time only, as its issue (item_id) says; a delete from before that
              // was kept goes by the key, as then.
              let tracker: number | null = null;
              if (g.itemId !== null) {
                if (!trackers.has(g.itemId)) {
                  const [item] = await db.select({ connectionId: issues.connectionId }).from(issues).where(eq(issues.id, g.itemId));
                  trackers.set(g.itemId, item?.connectionId ?? null);
                }
                tracker = trackers.get(g.itemId) ?? null;
              }
              const group = `${g.userId}:${tracker ?? ""}:${g.issueKey}`;
              if (!refs.has(group)) refs.set(group, await refOf({ connectionId: tracker, userId: g.userId, issueKey: g.issueKey }));
              if (!left.has(group)) {
                left.set(
                  group,
                  await db
                    .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
                    .from(worklogs)
                    .where(and(eq(worklogs.userId, g.userId), eq(worklogs.issueKey, g.issueKey), ...(tracker === null ? [] : [eq(worklogs.connectionId, tracker)]))),
                );
              }
              const { ref } = refs.get(group)!;
              const zone = connOf(sink).timeZone;
              const day = localDateOf(instant((g.started ?? new Date()).getTime()), zone);
              const total = left.get(group)!.filter((x) => localDateOf(instant(x.started.getTime()), zone) === day).reduce((a, x) => a + x.seconds, 0);
              await b.entries.setDayTotal!(meta(), ref, null, day, total, { idempotencyKey: `del:${g.id}` });
            } else if (b.entries.delete) {
              await goneIsDone(b.entries.delete(meta(), g.remoteId, {}));
            }
            done.push(g.id);
            sent++;
          } catch (e) {
            // Out of reach: no attempt counted, this one and the rest wait for the next pass.
            if (e instanceof ProviderError && e.transient) {
              await db.update(outbox).set({ claimedAt: null }).where(inArray(outbox.id, claimed.slice(i).map((c) => c.id)));
              break;
            }
            failed++;
            const attempts = g.attempts + 1;
            // Its last try: a lost create's entry is no longer kept out of the tracker's reads.
            if (attempts === MAX_OUTBOX_ATTEMPTS) await unbury(g);
            await db
              .update(outbox)
              .set({ attempts, nextAttemptAt: now() + deleteRetryDelayMs(attempts), claimedAt: null, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500) })
              .where(eq(outbox.id, g.id));
          }
        }
      } finally {
        if (done.length > 0) await db.delete(outbox).where(inArray(outbox.id, done));
      }
    }
    return { sent, failed };
  } finally {
    running.delete(userId);
  }
}

/** After a worklog was logged, changed or deleted: the sinks hear of it soon, without holding up the answer. */
export function sinksSoon(userId: number) {
  setTimeout(() => void pushSinks(userId).catch((e: unknown) => console.warn(`[sinks] ${String(e)}`)), 0).unref();
}
