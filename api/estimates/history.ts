// The status history job (docs/work/ideas/estimates.md R-3.11–R-3.13): each
// closed issue of the user's with their time has its status history read from
// the tracker (read only), checked, and stored whole; a read the issue has
// moved past is stale (migration 0018's trigger) and read again. The tracker
// is read outside any transaction; the result is written in one, and only
// over the generation and the issue version the read started from.
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { connections, issueHistoryReads, issueStatusChanges, issues, statusSnapshots, type Connection } from "@db/schema";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerType } from "@contracts/providers";
import { toStatusChanges, workStretches } from "@contracts/estimate";
import { getDb, q } from "../queries/connection";
import { raiseEstimateRevision } from "../queries/estimateRevision";
import { boundTracker } from "../sync/engine";
import { ProviderError } from "../providers/core/errors";
import { TRACKER_REGISTRY, trackerAdapter } from "../providers/registry";
import type { BoundTracker } from "../providers/core/bind";
import type { RemoteStatusStep, TrackerProbe } from "../providers/types";

const isCategory = (c: string): c is StatusCategory => (STATUS_CATEGORIES as readonly string[]).includes(c);

/** Histories read per pass, across users */
export const HISTORY_PASS = 50;
const MIN = 60_000;

/** When a failed read is tried again: 5 min, doubling, at most a day. */
export const retryAt = (now: number, attempts: number) => now + Math.min(24 * 60 * MIN, 5 * MIN * 2 ** attempts);

/** Trackers with a history: their issues are read (one with no status history in it is then invalid, never unsupported) */
function historyTypes(): string[] {
  return (Object.keys(TRACKER_REGISTRY) as TrackerType[]).filter((t) => {
    const c = trackerAdapter(t)?.capabilities;
    return c?.statusHistory === true || c?.history === true;
  });
}

/**
 * A tracker that gives no status history: unsupported (every worklog counts, and
 * the estimate says so) only when it has no history at all; a history that can't
 * be read as statuses is not proven, so it stays out (D-3.6).
 */
export function withoutStatusHistory(c: { history: boolean }): { state: "invalid"; reason: string } | { state: "unsupported"; reason: null } {
  return c.history ? { state: "invalid", reason: "noStatusHistory" } : { state: "unsupported", reason: null };
}

/** Closed issues with the user's time get a read row: pending, or unsupported on a tracker with no history at all. */
async function enrol(): Promise<void> {
  const added = await q<{ user_id: number }>(
    `INSERT INTO "issue_history_reads" ("item_id", "user_id", "state")
     SELECT i."id", i."user_id", CASE WHEN c."type" = ANY(?) THEN 'pending' ELSE 'unsupported' END
     FROM "issues" i JOIN "connections" c ON c."id" = i."connection_id"
     WHERE i."category" = 'done' AND i."gone_at" IS NULL
       AND EXISTS (SELECT 1 FROM "worklogs" w WHERE w."item_id" = i."id" AND w."user_id" = i."user_id")
     ON CONFLICT DO NOTHING
     RETURNING "user_id"`,
    historyTypes(),
  );
  for (const userId of new Set(added.map((r) => r.user_id))) await raiseEstimateRevision(getDb(), userId);
}

type Due = {
  itemId: number;
  userId: number;
  generation: number;
  attempts: number;
  connectionId: number | null;
  remoteId: string;
  key: string;
  statusId: string | null;
  category: string;
  remoteUpdatedAt: number | null;
  remoteCreatedAt: number | null;
};

/** What the pass reads: pending and stale, and retries whose time has come; the longest waiting first. */
async function dueReads(now: number): Promise<Due[]> {
  return getDb()
    .select({
      itemId: issueHistoryReads.itemId,
      userId: issueHistoryReads.userId,
      generation: issueHistoryReads.generation,
      attempts: issueHistoryReads.attempts,
      connectionId: issues.connectionId,
      remoteId: issues.remoteId,
      key: issues.key,
      statusId: issues.statusId,
      category: issues.category,
      remoteUpdatedAt: issues.remoteUpdatedAt,
      remoteCreatedAt: issues.remoteCreatedAt,
    })
    .from(issueHistoryReads)
    .innerJoin(issues, eq(issues.id, issueHistoryReads.itemId))
    // No status id yet: it stays pending until the sync fills it.
    .where(
      and(
        isNotNull(issues.statusId),
        or(inArray(issueHistoryReads.state, ["pending", "stale"]), and(eq(issueHistoryReads.state, "retry"), lte(issueHistoryReads.nextAttemptAt, new Date(now)))),
      ),
    )
    .orderBy(asc(sql`coalesce(${issueHistoryReads.readAt}, 0)`), asc(issueHistoryReads.itemId))
    .limit(HISTORY_PASS);
}

/** A connection's statuses by id (the job reads them once per pass). */
export type Known = { statuses: Map<string, { name: string; category: StatusCategory }> };

/** A connection's statuses: what the tracker lists, and those it doesn't that synced issues are in. */
export async function statusesOf(conn: Connection, b: BoundTracker, meta: { signal: AbortSignal; correlationId: string }): Promise<Known> {
  const statuses = new Map<string, { name: string; category: StatusCategory }>();
  if (b.capabilities.statuses && b.statuses) {
    let sources: TrackerProbe["activeSources"] | null = null;
    try {
      sources = conn.probe ? (JSON.parse(conn.probe) as TrackerProbe).activeSources : null;
    } catch {
      sources = null;
    }
    for (const source of sources ?? (await b.probe(meta)).activeSources) for (const s of await b.statuses(meta, source)) statuses.set(s.id, { name: s.name, category: s.category });
  }
  // A status the tracker doesn't list (monday's blank) is known by the synced issues that are in it.
  const seen = await getDb()
    .selectDistinct({ id: issues.statusId, name: issues.status, category: issues.category })
    .from(issues)
    .where(and(eq(issues.connectionId, conn.id), isNotNull(issues.statusId)));
  for (const s of seen) if (s.id !== null && !statuses.has(s.id) && isCategory(s.category)) statuses.set(s.id, { name: s.name, category: s.category });
  return { statuses };
}

/** The statuses this server already knows of a connection: their snapshots, and the synced issues' (no call). */
export async function storedStatuses(connectionId: number): Promise<Known> {
  const statuses = new Map<string, { name: string; category: StatusCategory }>();
  for (const s of await getDb().select().from(statusSnapshots).where(eq(statusSnapshots.connectionId, connectionId)))
    if (isCategory(s.category)) statuses.set(s.statusId, { name: s.name, category: s.category });
  const seen = await getDb()
    .selectDistinct({ id: issues.statusId, name: issues.status, category: issues.category })
    .from(issues)
    .where(and(eq(issues.connectionId, connectionId), isNotNull(issues.statusId)));
  for (const s of seen) if (s.id !== null && !statuses.has(s.id) && isCategory(s.category)) statuses.set(s.id, { name: s.name, category: s.category });
  return { statuses };
}

/** Writes what a read found, only over the generation and issue version it started from. */
async function settle(
  due: Due,
  outcome: { state: "available" | "invalid" | "unsupported"; reason: string | null; steps: RemoteStatusStep[]; changes: { ordinal: number; at: number; from: string | null; to: string }[] },
  now: number,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ generation: issueHistoryReads.generation, updatedAt: issues.remoteUpdatedAt })
      .from(issueHistoryReads)
      .innerJoin(issues, eq(issues.id, issueHistoryReads.itemId))
      .where(eq(issueHistoryReads.itemId, due.itemId))
      .for("update", { of: issueHistoryReads });
    if (!row || row.generation !== due.generation || row.updatedAt !== due.remoteUpdatedAt) return false;
    await tx.delete(issueStatusChanges).where(eq(issueStatusChanges.itemId, due.itemId));
    if (outcome.changes.length)
      await tx.insert(issueStatusChanges).values(outcome.changes.map((c) => ({ itemId: due.itemId, ordinal: c.ordinal, at: new Date(c.at), fromStatusId: c.from, toStatusId: c.to })));
    await tx
      .update(issueHistoryReads)
      .set({
        state: outcome.state,
        reason: outcome.reason,
        readAt: new Date(now),
        sourceUpdatedAt: due.remoteUpdatedAt,
        statusIdAtRead: due.statusId,
        changes: outcome.changes.length,
        attempts: 0,
        nextAttemptAt: null,
        generation: sql`${issueHistoryReads.generation} + 1`,
      })
      .where(eq(issueHistoryReads.itemId, due.itemId));
    await raiseEstimateRevision(tx, due.userId);
    return true;
  });
}

/** A failed read: nothing of it kept, tried again later. */
async function failed(due: Due, reason: string, now: number) {
  await getDb().transaction(async (tx) => {
    const done = await tx
      .update(issueHistoryReads)
      .set({ state: "retry", reason, attempts: due.attempts + 1, nextAttemptAt: new Date(retryAt(now, due.attempts)), generation: sql`${issueHistoryReads.generation} + 1` })
      .where(and(eq(issueHistoryReads.itemId, due.itemId), eq(issueHistoryReads.generation, due.generation)))
      .returning({ itemId: issueHistoryReads.itemId });
    if (done.length) await raiseEstimateRevision(tx, due.userId);
  });
}

/** Saves, for each status the history met, what the tracker says of it now (a status deleted later stays readable). */
async function snapshot(connectionId: number, met: Set<string>, known: Known, now: number) {
  const rows = [...met].flatMap((id) => {
    const s = known.statuses.get(id);
    return s ? [{ connectionId, statusId: id, name: s.name, category: s.category, seenAt: new Date(now) }] : [];
  });
  if (rows.length)
    await getDb()
      .insert(statusSnapshots)
      .values(rows)
      .onConflictDoUpdate({ target: [statusSnapshots.connectionId, statusSnapshots.statusId], set: { name: sql`excluded."name"`, category: sql`excluded."category"`, seenAt: sql`excluded."seen_at"` } });
}

async function readOne(due: Due, conn: Connection, b: BoundTracker, known: Known, now: number): Promise<void> {
  const meta = { signal: AbortSignal.timeout(60_000), correlationId: `history-${due.itemId}-${now}` };
  if (!b.capabilities.statusHistory || !b.statusHistory) {
    await settle(due, { ...withoutStatusHistory(b.capabilities), steps: [], changes: [] }, now);
    return;
  }
  let steps: RemoteStatusStep[];
  try {
    steps = await b.statusHistory(meta, { remoteId: due.remoteId, key: due.key });
  } catch (e) {
    // An answer that can't be read as statuses is not proven: invalid, not tried again until the issue changes.
    if (e instanceof ProviderError && e.kind === "incompatible") await settle(due, { state: "invalid", reason: "incompatible", steps: [], changes: [] }, now);
    else await failed(due, e instanceof ProviderError ? e.kind : "error", now);
    return;
  }
  const met = new Set(steps.flatMap((s) => [s.to.id, ...(s.from ? [s.from.id] : [])]));
  await snapshot(conn.id, met, known, now);
  const snapped = new Set(
    met.size
      ? (await getDb().select({ id: statusSnapshots.statusId }).from(statusSnapshots).where(and(eq(statusSnapshots.connectionId, conn.id), inArray(statusSnapshots.statusId, [...met])))).map((r) => r.id)
      : [],
  );
  const converted = toStatusChanges(
    steps.map((s, i) => ({ sourceOrdinal: i, at: s.at, from: s.from ? [{ id: s.from.id, text: s.from.name }] : [], to: [{ id: s.to.id, text: s.to.name }] })),
    [...known.statuses].map(([id, s]) => ({ id, name: s.name })),
  );
  if (!converted.ok) {
    await settle(due, { state: "invalid", reason: converted.reason, steps, changes: [] }, now);
    return;
  }
  // Coherence only (which statuses count as work is the estimate's): a status nothing places is unknown.
  const check = workStretches({
    changes: converted.changes,
    createdAt: due.remoteCreatedAt ?? 0,
    readAt: now,
    statusNow: due.statusId ?? "",
    classify: (id) => (known.statuses.has(id) || snapped.has(id) ? false : null),
    closed: due.category === "done" || due.category === "cancelled",
  });
  await settle(due, { state: check.ok ? "available" : "invalid", reason: check.ok ? null : check.reason, steps, changes: converted.changes }, now);
}

/** One pass of the job: enrols new closed issues, then reads up to HISTORY_PASS due histories. */
export async function readDueHistories(now = Date.now()): Promise<{ read: number }> {
  await enrol();
  const due = await dueReads(now);
  const conns = new Map<number, { conn: Connection; b: BoundTracker | null; known: Known | null }>();
  let read = 0;
  for (const d of due) {
    if (d.connectionId === null) continue;
    let c = conns.get(d.connectionId);
    if (!c) {
      const [conn] = await getDb().select().from(connections).where(eq(connections.id, d.connectionId));
      c = { conn, b: conn ? boundTracker(conn) : null, known: null };
      conns.set(d.connectionId, c);
    }
    if (!c.conn || !c.b) continue;
    try {
      c.known ??= await statusesOf(c.conn, c.b, { signal: AbortSignal.timeout(60_000), correlationId: `history-statuses-${c.conn.id}-${now}` });
    } catch (e) {
      await failed(d, e instanceof ProviderError ? e.kind : "error", now);
      continue;
    }
    await readOne(d, c.conn, c.b, c.known, now);
    read++;
  }
  return { read };
}
