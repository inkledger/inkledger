// What the team report reads about each account besides its worklogs: how
// fresh its time is (the trackers it imports time from) and its work
// schedules (the target its hours are judged against). Read only.
import { and, inArray, isNull } from "drizzle-orm";
import { connections, connectionSync, syncState, workDayOverrides, workSchedules, type Connection } from "@db/schema";
import { EPOCH_DAY, type DayOverrides, type ScheduleVersion } from "@contracts/workSchedule";
import { normalizeWorkSchedule, type WorkDay } from "@contracts/workScheduleSchema";
import { getDb } from "./connection";
import { boundTracker } from "../sync/engine";
import { entriesOf } from "../sync/worklogs";
import { listScheduleVersions, parseWorkDay } from "../routers/workSchedule";

/** Time read more than this long ago may miss what was logged on the tracker since. */
export const STALE_AFTER_MS = 24 * 60 * 60_000;

/**
 * How far an account's time can be trusted:
 * - ok: every tracker it imports time from was read recently;
 * - stale / never: one was read long ago, or never;
 * - reconnect: one refuses its credentials (nothing is read until it is reconnected);
 * - local: its time lives here only, nothing to import.
 * `at` is the oldest read among its trackers (null: never, or local).
 */
export type Freshness = { state: "ok" | "stale" | "never" | "reconnect" | "local"; at: number | null };

/** The connection's time is imported from its tracker: Jira's worklogs, or another tracker's entries feed. */
function importsTime(conn: Connection): boolean {
  if (conn.type === "jira") return true;
  try {
    const b = boundTracker(conn);
    return !!b && !!entriesOf(b) && !!b.worklogs?.changed;
  } catch {
    // Options it can't read: it imports nothing until fixed (the user sees it on their connection).
    return false;
  }
}

/** Freshness of each account's time (every id gets one). */
export async function timeFreshness(userIds: number[], now: number = Date.now()): Promise<Map<number, Freshness>> {
  const out = new Map<number, Freshness>(userIds.map((id) => [id, { state: "local", at: null }]));
  if (userIds.length === 0) return out;
  const db = getDb();
  const conns = (await db
    .select()
    .from(connections)
    .where(and(inArray(connections.userId, userIds), isNull(connections.archivedAt)))).filter(importsTime);
  if (conns.length === 0) return out;
  const streams = await db
    .select({ connectionId: connectionSync.connectionId, stream: connectionSync.stream, lastOkAt: connectionSync.lastOkAt })
    .from(connectionSync)
    .where(and(inArray(connectionSync.connectionId, conns.map((c) => c.id)), inArray(connectionSync.stream, ["worklogs", "entries"])));
  const legacy = await db
    .select({ userId: syncState.userId, at: syncState.lastWorklogSyncAt })
    .from(syncState)
    .where(inArray(syncState.userId, [...new Set(conns.filter((c) => c.legacy === 1).map((c) => c.userId))]));
  // Jira's worklogs are read on their own stream; the connection from before connections were separate keeps the account's.
  const readAt = (c: Connection): number | null => {
    const at = c.legacy === 1
      ? legacy.find((l) => l.userId === c.userId)?.at
      : streams.find((s) => s.connectionId === c.id && s.stream === (c.type === "jira" ? "worklogs" : "entries"))?.lastOkAt;
    return at ? at.getTime() : null;
  };
  for (const id of userIds) {
    const mine = conns.filter((c) => c.userId === id);
    if (mine.length === 0) continue;
    const reads = mine.map(readAt);
    const known = reads.filter((r): r is number => r !== null);
    const oldest = known.length > 0 ? Math.min(...known) : null;
    const state: Freshness["state"] = mine.some((c) => c.status !== "ok")
      ? "reconnect"
      : known.length < reads.length
        ? "never"
        : oldest !== null && now - oldest > STALE_AFTER_MS
          ? "stale"
          : "ok";
    out.set(id, { state, at: oldest });
  }
  return out;
}

/**
 * Each account's schedule versions, oldest first, as its own views see them.
 * One read for all; an account without its first version gets it the way
 * its own views would create it (listScheduleVersions), once.
 */
export async function scheduleVersionsOf(userIds: number[]): Promise<Map<number, ScheduleVersion[]>> {
  const out = new Map<number, ScheduleVersion[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return out;
  const rows = await getDb()
    .select({ userId: workSchedules.userId, validFrom: workSchedules.validFrom, schedule: workSchedules.schedule })
    .from(workSchedules)
    .where(inArray(workSchedules.userId, userIds));
  for (const r of rows) {
    out.get(r.userId)?.push({ validFrom: r.validFrom, schedule: normalizeWorkSchedule(JSON.parse(r.schedule) as unknown) });
  }
  for (const id of userIds) {
    const versions = out.get(id) ?? [];
    if (!versions.some((v) => v.validFrom === EPOCH_DAY)) out.set(id, await listScheduleVersions(id));
    else versions.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }
  return out;
}

/** Each account's hours of single days (a late lunch, a day off), in one read. */
export async function dayOverridesOf(userIds: number[]): Promise<Map<number, DayOverrides>> {
  const out = new Map<number, Record<string, WorkDay>>(userIds.map((id) => [id, {}]));
  if (userIds.length === 0) return out;
  const rows = await getDb()
    .select({ userId: workDayOverrides.userId, day: workDayOverrides.day, workDay: workDayOverrides.workDay })
    .from(workDayOverrides)
    .where(inArray(workDayOverrides.userId, userIds));
  for (const r of rows) {
    const d = parseWorkDay(r.workDay);
    const mine = out.get(r.userId);
    if (d && mine) mine[r.day] = d;
  }
  return out;
}
