// When each timer actually ran (timer_runs) and the shares logs took of the
// time two ran together (timer_shares): what a log of timers run side by side
// splits (contracts/timerSplit.ts). Written inside the timer lock's
// transaction by the timer actions; a run is kept while it shares time with a
// run not logged yet, then pruned.
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { timerRuns, timerShares } from "@db/schema";
import { timerId, type SplitRun, type SplitShare } from "@contracts/timerSplit";
import type { getDb } from "./connection";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A timer by its issue: what its runs are kept by. */
export type TimerRef = { userId: number; connectionId: number; issueKey: string };

const runsOf = (t: TimerRef) => and(eq(timerRuns.userId, t.userId), eq(timerRuns.connectionId, t.connectionId), eq(timerRuns.issueKey, t.issueKey));
const unlogged = isNull(timerRuns.loggedAt);

/** The timer starts running at `at` (one open run per timer: a second open is a no-op). */
export async function openRun(db: Db | Tx, t: TimerRef, at: Date) {
  await db.insert(timerRuns).values({ ...t, startedAt: at }).onConflictDoNothing();
}

/** The timer stops running at `at` (never before its run began). */
export async function closeRun(db: Db | Tx, t: TimerRef, at: Date) {
  await db
    .update(timerRuns)
    .set({ endedAt: sql`greatest(${timerRuns.startedAt}, ${at.getTime()})` })
    .where(and(runsOf(t), isNull(timerRuns.endedAt)));
}

/**
 * Away time out of the timer's runs: its last `seconds` before `end` (now
 * for a running timer, its pause otherwise), the newest runs first. An open
 * run ends there; the caller opens the next one when the timer runs on.
 */
export async function trimRuns(db: Db | Tx, t: TimerRef, seconds: number, end: Date) {
  const runs = await db.select().from(timerRuns).where(and(runsOf(t), unlogged)).orderBy(sql`${timerRuns.startedAt} desc`);
  let left = seconds * 1000;
  for (const r of runs) {
    if (left <= 0) break;
    const until = (r.endedAt ?? end).getTime();
    const length = Math.max(0, until - r.startedAt.getTime());
    if (length <= left) {
      await db.delete(timerRuns).where(eq(timerRuns.id, r.id));
      left -= length;
    } else {
      await db.update(timerRuns).set({ endedAt: new Date(until - left) }).where(eq(timerRuns.id, r.id));
      left = 0;
    }
  }
}

/** The runs and shares of a timer go to another issue (moved, merged, its key changed). Open runs must be closed first. */
export async function renameRuns(db: Db | Tx, userId: number, from: Omit<TimerRef, "userId">, to: Omit<TimerRef, "userId">) {
  const a = { userId, ...from };
  await db.update(timerRuns).set({ connectionId: to.connectionId, issueKey: to.issueKey }).where(runsOf(a));
  await db
    .update(timerShares)
    .set({ connectionId: to.connectionId, issueKey: to.issueKey })
    .where(and(eq(timerShares.userId, userId), eq(timerShares.connectionId, from.connectionId), eq(timerShares.issueKey, from.issueKey)));
}

/** A discarded timer's time never happened: its runs not logged go (the time beside it is then the others' own). */
export async function discardRuns(db: Db | Tx, t: TimerRef) {
  await db.delete(timerRuns).where(and(runsOf(t), unlogged));
}

/** What a log consumed, to put back when its worklog then fails. */
export type Consumed = { restore: { id: number; endedAt: Date | null; loggedAt: Date | null }[]; added: number[]; shares: number[] };

/**
 * A log takes the timer's runs up to `until` (the stop, or when the dialog of
 * a running timer opened): marked logged, a run crossing `until` cut there,
 * its rest still to be logged.
 */
export async function consumeRuns(db: Db | Tx, t: TimerRef, until: Date, now: Date): Promise<Consumed> {
  const runs = await db.select().from(timerRuns).where(and(runsOf(t), unlogged, lt(timerRuns.startedAt, until)));
  const consumed: Consumed = { restore: [], added: [], shares: [] };
  for (const r of runs) {
    consumed.restore.push({ id: r.id, endedAt: r.endedAt, loggedAt: r.loggedAt });
    if (r.endedAt && r.endedAt.getTime() <= until.getTime()) {
      await db.update(timerRuns).set({ loggedAt: now }).where(eq(timerRuns.id, r.id));
      continue;
    }
    await db.update(timerRuns).set({ endedAt: until, loggedAt: now }).where(eq(timerRuns.id, r.id));
    const [rest] = await db
      .insert(timerRuns)
      .values({ ...t, startedAt: until, endedAt: r.endedAt })
      .returning({ id: timerRuns.id });
    consumed.added.push(rest.id);
  }
  return consumed;
}

/** Puts back what `consumeRuns` (and the shares written with it) changed. */
export async function unconsumeRuns(db: Db | Tx, c: Consumed) {
  if (c.added.length) await db.delete(timerRuns).where(inArray(timerRuns.id, c.added));
  if (c.shares.length) await db.delete(timerShares).where(inArray(timerShares.id, c.shares));
  for (const r of c.restore) await db.update(timerRuns).set({ endedAt: r.endedAt, loggedAt: r.loggedAt }).where(eq(timerRuns.id, r.id));
}

/** The shares a log took, one per stretch (bp: basis points). */
export async function recordShares(db: Db | Tx, t: TimerRef, shares: { start: number; end: number; bp: number }[]): Promise<number[]> {
  if (shares.length === 0) return [];
  const rows = await db
    .insert(timerShares)
    .values(shares.map((s) => ({ ...t, startedAt: new Date(s.start), endedAt: new Date(s.end), shareBp: Math.round(s.bp) })))
    .returning({ id: timerShares.id });
  return rows.map((r) => r.id);
}

/**
 * Everything a split of the timer needs: its runs not logged, and every run
 * and share of the user over their span (runs still open end at `now`).
 */
export async function splitInputs(db: Db | Tx, t: TimerRef, now: Date): Promise<{ runs: SplitRun[]; shares: SplitShare[] }> {
  const own = await db.select().from(timerRuns).where(and(runsOf(t), unlogged)).orderBy(asc(timerRuns.startedAt));
  if (own.length === 0) return { runs: [], shares: [] };
  const from = Math.min(...own.map((r) => r.startedAt.getTime()));
  const to = Math.max(...own.map((r) => (r.endedAt ?? now).getTime()));
  const [runs, shares] = await Promise.all([
    db
      .select()
      .from(timerRuns)
      .where(and(eq(timerRuns.userId, t.userId), lt(timerRuns.startedAt, new Date(to)), or(isNull(timerRuns.endedAt), gt(timerRuns.endedAt, new Date(from))))),
    db
      .select()
      .from(timerShares)
      .where(and(eq(timerShares.userId, t.userId), lt(timerShares.startedAt, new Date(to)), gt(timerShares.endedAt, new Date(from)))),
  ]);
  return {
    runs: runs.map((r) => ({
      timer: timerId(r.connectionId, r.issueKey),
      start: r.startedAt.getTime(),
      end: Math.max(r.startedAt.getTime(), (r.endedAt ?? now).getTime()),
      logged: r.loggedAt !== null,
    })),
    shares: shares.map((s) => ({ timer: timerId(s.connectionId, s.issueKey), start: s.startedAt.getTime(), end: s.endedAt.getTime(), bp: s.shareBp })),
  };
}

const KEEP_MS = 30 * 24 * 3600_000;

/** Every user's runs and shares logged a month ago: no log left to share them with (daily). */
export async function pruneOldRuns(db: Db | Tx, now: Date) {
  const old = now.getTime() - KEEP_MS;
  await db.execute(sql`DELETE FROM timer_runs WHERE logged_at < ${old}`);
  await db.execute(sql`DELETE FROM timer_shares WHERE created_at < ${old}`);
}

/**
 * Forgets what no split needs any more: runs of timers that are gone without
 * a log, logged runs and shares no unlogged run of another timer meets, and
 * anything logged a month ago.
 */
export async function pruneRuns(db: Db | Tx, userId: number, now: Date) {
  const at = now.getTime();
  const old = at - KEEP_MS;
  await db.execute(sql`
    DELETE FROM timer_runs r
    WHERE r.user_id = ${userId} AND r.logged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM timers t WHERE t.user_id = r.user_id AND t.connection_id = r.connection_id AND t.issue_key = r.issue_key)`);
  await db.execute(sql`
    DELETE FROM timer_runs r
    WHERE r.user_id = ${userId} AND r.logged_at IS NOT NULL
      AND (r.logged_at < ${old} OR NOT EXISTS (
        SELECT 1 FROM timer_runs o
        WHERE o.user_id = r.user_id AND o.logged_at IS NULL
          AND NOT (o.connection_id = r.connection_id AND o.issue_key = r.issue_key)
          AND o.started_at < coalesce(r.ended_at, ${at}) AND coalesce(o.ended_at, ${at}) > r.started_at))`);
  await db.execute(sql`
    DELETE FROM timer_shares s
    WHERE s.user_id = ${userId}
      AND (s.created_at < ${old} OR NOT EXISTS (
        SELECT 1 FROM timer_runs o
        WHERE o.user_id = s.user_id AND o.logged_at IS NULL
          AND NOT (o.connection_id = s.connection_id AND o.issue_key = s.issue_key)
          AND o.started_at < s.ended_at AND coalesce(o.ended_at, ${at}) > s.started_at))`);
}
