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
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { connections, issues, outbox, sinkMappings, worklogs, worklogSinks, type Connection, type Worklog } from "@db/schema";
import { TIME_SINK_TYPES, type TimeSinkType, type TrackerType } from "@contracts/providers";
import { instant, localDateOf } from "@contracts/values";
import { getDb } from "../queries/connection";
import { bindSink, type BoundSink } from "../providers/core/bind";
import { ProviderError } from "../providers/core/errors";
import { connOf } from "../providers/connections";
import { sinkAdapter, sinkStatus } from "../providers/registry";
import { jiraWorklogIdOf } from "../providers/tempo/adapter";
import type { ExternalRef, RemoteWorklog, SinkTarget, WorklogInput } from "../providers/types";
import { withDeleteReason } from "../queries/trash";
import { linkSink, timeInput } from "./worklogs";
import { MAX_OUTBOX_ATTEMPTS } from "@contracts/types";
import { backoffMs } from "./state";
import { CLAIM_TTL_MS } from "./timeWrites";

const meta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `sink-${Date.now()}` });
const SINKS = new Set<string>(TIME_SINK_TYPES);
/**
 * Sinks that stand in for one tracker connection: which one (from their
 * options) and the tracker's own id of an entry they filed.
 */
export const COMPANIONS: Partial<Record<TimeSinkType, { tracker: TrackerType; option: string; trackerIdOf: (r: RemoteWorklog) => string | null }>> = {
  tempo: { tracker: "jira", option: "jiraConnectionId", trackerIdOf: jiraWorklogIdOf },
};
const BESIDE = (type: string) => SINKS.has(type) && !COMPANIONS[type as TimeSinkType];

const optionsOf = (c: Connection): Record<string, unknown> => {
  try {
    const o = JSON.parse(c.options) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Unverified sinks write only once the user allowed it. */
const mayWrite = (c: Connection) => sinkStatus(c.type as TimeSinkType) !== "experimental" || c.writesAllowed === 1;

async function liveConnections(userId: number): Promise<Connection[]> {
  return getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), isNull(connections.archivedAt), eq(connections.status, "ok")));
}

/** The user's live sink connections beside their trackers. */
async function sinkConnections(userId: number): Promise<Connection[]> {
  return (await liveConnections(userId)).filter((c) => BESIDE(c.type));
}

/** The tracker connection a sink stands in for, or null (a sink beside every tracker). */
export function trackerOfSink(c: Connection): number | null {
  const k = COMPANIONS[c.type as TimeSinkType];
  const id = k ? Number(optionsOf(c)[k.option]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The live sink standing in for this tracker connection and allowed to write, if any: its new worklogs go there. */
export async function companionOf(tracker: Connection): Promise<Connection | null> {
  return (await liveConnections(tracker.userId)).find((c) => trackerOfSink(c) === tracker.id && mayWrite(c)) ?? null;
}

async function companionConnections(userId: number): Promise<Connection[]> {
  return (await liveConnections(userId)).filter((c) => trackerOfSink(c) !== null);
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
  for (const s of sinks) {
    await getDb()
      .insert(worklogSinks)
      .values({ worklogId, sinkConnectionId: s.id, state: "pending" })
      .onConflictDoUpdate({ target: [worklogSinks.worklogId, worklogSinks.sinkConnectionId], set: { state: "pending", lastError: null } });
  }
}

/** A worklog about to be deleted: its entries on the sinks are queued to go too (its rows are going). */
export async function queueSinkDeletes(w: Worklog) {
  const db = getDb();
  const rows = await db
    .select({ sink: worklogSinks.sinkConnectionId, remoteId: worklogSinks.remoteId })
    .from(worklogSinks)
    .innerJoin(connections, eq(connections.id, worklogSinks.sinkConnectionId))
    .where(and(eq(worklogSinks.worklogId, w.id), sql`${worklogSinks.remoteId} IS NOT NULL`, inArray(connections.type, TIME_SINK_TYPES.filter(BESIDE))));
  for (const r of rows) {
    if (!r.remoteId || r.sink === w.connectionId) continue;
    await db.insert(outbox).values({ userId: w.userId, connectionId: r.sink, kind: "delete", issueKey: w.issueKey, remoteId: r.remoteId, timeSpentSeconds: w.timeSpentSeconds, started: w.started });
  }
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

/** One worklog onto one sink: created, changed, or its day's total set. */
export async function pushOne(b: BoundSink, sink: Connection, w: Worklog, remoteId: string | null) {
  const c = b.capabilities;
  const { ref, containerId } = await refOf(w);
  const mapped = await mappingFor(sink.id, containerId);
  if (c.target.use === "required" && !mapped) return fail(w.id, sink.id, "noTarget");
  const target = c.target.use === "none" ? null : (mapped?.target ?? null);
  const zone = connOf(sink).timeZone;
  let landed: RemoteWorklog | null;
  if (c.entries.model === "dayTotals") {
    // The issue's total that day, all its worklogs together.
    const day = localDateOf(instant(w.started.getTime()), zone);
    const same = await getDb()
      .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(and(eq(worklogs.userId, w.userId), eq(worklogs.connectionId, w.connectionId ?? -1), eq(worklogs.issueKey, w.issueKey)));
    const total = same.filter((x) => localDateOf(instant(x.started.getTime()), zone) === day).reduce((a, x) => a + x.seconds, 0);
    landed = await b.entries.setDayTotal!(meta(), ref, target, day, total, { idempotencyKey: `${w.uuid}:${day}:${total}` });
  } else {
    const input: WorklogInput = {
      time: timeInput(c.entries.shape, w, zone),
      comment: w.comment,
      ...(mapped?.activityId ? { activityId: mapped.activityId } : {}),
    };
    landed =
      remoteId && b.entries.update
        ? await b.entries.update(meta(), remoteId, input, {})
        : await b.entries.create!(meta(), ref, target, input, { idempotencyKey: w.uuid });
  }
  await getDb()
    .update(worklogSinks)
    .set({ state: "synced", remoteId: landed?.remoteId ?? remoteId, version: landed?.version ?? null, lastError: null, syncedAt: new Date() })
    .where(and(eq(worklogSinks.worklogId, w.id), eq(worklogSinks.sinkConnectionId, sink.id)));
  const companion = COMPANIONS[sink.type as TimeSinkType];
  const trackerId = companion && landed ? companion.trackerIdOf(landed) : null;
  if (trackerId) await adoptTrackerId(w, trackerId);
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
  if (running.has(userId)) return { sent: 0, failed: 0 };
  running.add(userId);
  let sent = 0;
  let failed = 0;
  try {
    const db = getDb();
    for (const sink of [...(await sinkConnections(userId)), ...(await companionConnections(userId))]) {
      const b = boundSink(sink);
      if (!b || !mayWrite(sink)) continue;
      const due = await db
        .select({ w: worklogs, remoteId: worklogSinks.remoteId })
        .from(worklogSinks)
        .innerJoin(worklogs, eq(worklogs.id, worklogSinks.worklogId))
        .where(and(eq(worklogSinks.sinkConnectionId, sink.id), eq(worklogSinks.state, "pending")))
        .orderBy(asc(worklogs.id))
        .limit(SINK_BATCH);
      for (const { w, remoteId } of due) {
        try {
          await pushOne(b, sink, w, remoteId);
          sent++;
        } catch (e) {
          if (e instanceof ProviderError && e.transient) break;
          failed++;
          await fail(w.id, sink.id, e instanceof Error ? e.message : String(e));
        }
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
            ...(o.force ? [] : [lt(outbox.attempts, MAX_OUTBOX_ATTEMPTS), or(isNull(outbox.nextAttemptAt), lte(outbox.nextAttemptAt, now()))]),
          ),
        )
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(SINK_BATCH);
      for (const queued of gone) {
        // Claimed first, as the trackers' queue is (timeWrites): another server process on the same database skips it.
        const at = now();
        const [g] = await db
          .update(outbox)
          .set({ claimedAt: at })
          .where(and(eq(outbox.id, queued.id), or(isNull(outbox.claimedAt), lt(outbox.claimedAt, at - CLAIM_TTL_MS))))
          .returning();
        if (!g) continue;
        try {
          if (b.capabilities.entries.model === "dayTotals") {
            // A day's total without the deleted worklog (0 removes the day).
            const { ref } = await refOf({ connectionId: null, userId: g.userId, issueKey: g.issueKey });
            const zone = connOf(sink).timeZone;
            const day = localDateOf(instant((g.started ?? new Date()).getTime()), zone);
            const rest = await db
              .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
              .from(worklogs)
              .where(and(eq(worklogs.userId, g.userId), eq(worklogs.issueKey, g.issueKey)));
            const total = rest.filter((x) => localDateOf(instant(x.started.getTime()), zone) === day).reduce((a, x) => a + x.seconds, 0);
            await b.entries.setDayTotal!(meta(), ref, null, day, total, { idempotencyKey: `del:${g.id}` });
          } else if (b.entries.delete) {
            await b.entries.delete(meta(), g.remoteId, {}).catch((e: unknown) => {
              if (!(e instanceof ProviderError && e.kind === "notFound")) throw e;
            });
          }
          await db.delete(outbox).where(eq(outbox.id, g.id));
          sent++;
        } catch (e) {
          // Out of reach: no attempt counted, the rest waits for the next pass.
          if (e instanceof ProviderError && e.transient) {
            await db.update(outbox).set({ claimedAt: null }).where(eq(outbox.id, g.id));
            break;
          }
          failed++;
          const attempts = g.attempts + 1;
          await db
            .update(outbox)
            .set({ attempts, nextAttemptAt: now() + deleteRetryDelayMs(attempts), claimedAt: null, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500) })
            .where(eq(outbox.id, g.id));
        }
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
