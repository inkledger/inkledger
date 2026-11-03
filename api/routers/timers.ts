import { z } from "zod";
import { and, eq, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import superjson from "superjson";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issues, timerOps, timers, todos, type Timer } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { publish } from "../lib/userEvents";
import { TimerConflictError } from "../lib/timerConflict";
import { TIMER_LEASE_MS } from "@contracts/timerLock";
import { deviceLabel } from "@contracts/device";
import { dayKey, roundToMinute } from "@contracts/time";
import { assertNoOverlap } from "../queries/overlap";
import { withWriteLease } from "../queries/writeLease";
import { endLinkedSessionOf, endSession, openSession, trimSession } from "../queries/todoSessions";
import { closeRun, consumeRuns, discardRuns, openRun, pruneOldRuns, pruneRuns, recordShares, renameRuns, splitInputs, trimRuns, unconsumeRuns, type TimerRef } from "../queries/timerRuns";
import { groupKey, splitOf, stretchesOf, timerId, type SplitRun } from "@contracts/timerSplit";
import { getSettings } from "./settings";
import { t as tr } from "@contracts/i18n";

/** The issue's connection, when a key lives on two. */
const connectionInput = z.number().int().positive().optional();

/**
 * What every timer action may carry: the epoch the page last saw (an action
 * on an older view is refused, `moved`), an id that makes a retry answer the
 * first result (`opId`), and `force` to take over from another device.
 */
const control = {
  epoch: z.number().int().nonnegative().optional(),
  opId: z.string().min(8).max(64).optional(),
  force: z.boolean().optional(),
};

/** Elapsed seconds for a timer at a given instant. */
export function elapsedSeconds(t: Timer, now: Date = new Date()): number {
  const running =
    t.state === "running"
      ? Math.max(0, Math.floor((now.getTime() - t.startedAt.getTime()) / 1000))
      : 0;
  return t.accumulatedSeconds + running;
}

export { roundToMinute };

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Timer writes one at a time per user, under the same lock as `start`: a
 * read-then-write (stop, trim, a log consuming the time) can't interleave
 * with another one and resurrect or lose time. The lock is the database's,
 * so it holds across processes too.
 */
function withTimerLock<T>(userId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
    return fn(tx);
  });
}

/** A timer by its issue, on the issue's connection. */
const timerOf = (userId: number, connectionId: number, issueKey: string) =>
  and(eq(timers.userId, userId), eq(timers.connectionId, connectionId), eq(timers.issueKey, issueKey));

/** A timer as its runs know it. */
const refOf = (t: { userId: number; connectionId: number; issueKey: string }): TimerRef => ({ userId: t.userId, connectionId: t.connectionId, issueKey: t.issueKey });

/** Who acts: the user, the device (x-device-id) and how that device is named. */
export type Who = { userId: number; device: string | undefined; label: string };

export function whoOf(ctx: { user: { id: number }; deviceId?: string; req: Request }, label?: string): Who {
  const named = label?.trim().slice(0, 60);
  return { userId: ctx.user.id, device: ctx.deviceId, label: named || deviceLabel(ctx.req.headers.get("user-agent")) };
}

/** A running timer whose owner still renews its lease. */
const leaseLive = (t: Timer, now: Date) => t.state === "running" && !!t.ownerDevice && !!t.leaseUntil && t.leaseUntil.getTime() > now.getTime();

/** Another device controls this running timer right now. */
export const heldElsewhere = (t: Timer, w: Who, now: Date) => leaseLive(t, now) && t.ownerDevice !== w.device;

/** The timer as owned by `w` from now (no device: nobody owns it, nothing to lock). */
const ownedBy = (w: Who, now: Date) =>
  w.device
    ? { ownerDevice: w.device, ownerLabel: w.label, leaseUntil: new Date(now.getTime() + TIMER_LEASE_MS) }
    : { ownerDevice: null, ownerLabel: "", leaseUntil: null };

const released = { ownerDevice: null, ownerLabel: "", leaseUntil: null };

export function refuse(reason: "held" | "moved", t: Timer): never {
  throw new TRPCError({
    code: "CONFLICT",
    message:
      reason === "held"
        ? tr("server.timers.held", { device: t.ownerLabel || tr("server.timers.anotherDevice"), key: t.issueKey })
        : tr("server.timers.moved", { key: t.issueKey }),
    cause: new TimerConflictError({
      reason,
      issueKey: t.issueKey,
      connectionId: t.connectionId,
      ownerLabel: t.ownerLabel,
      since: t.startedAt.getTime(),
      epoch: t.epoch,
    }),
  });
}

/**
 * The checks every action on a timer passes: another device holding it (unless
 * taking over), and a page acting on an older view of it.
 */
function mayAct(t: Timer, w: Who, now: Date, input: { epoch?: number; force?: boolean }) {
  if (heldElsewhere(t, w, now) && !input.force) refuse("held", t);
  if (input.epoch !== undefined && input.epoch !== t.epoch && t.state === "running" && !input.force) refuse("moved", t);
}

/**
 * Runs an action once per `opId`: a retry (lost answer, double click,
 * automatic retry) gets the first result back instead of acting again.
 */
async function once<T>(tx: Tx, userId: number, opId: string | undefined, run: () => Promise<T>): Promise<T> {
  if (!opId) return run();
  const [done] = await tx
    .select({ result: timerOps.result })
    .from(timerOps)
    .where(and(eq(timerOps.userId, userId), eq(timerOps.opId, opId)));
  if (done) return superjson.parse<T>(done.result);
  const result = await run();
  await tx.insert(timerOps).values({ userId, opId, result: superjson.stringify(result) });
  return result;
}

/** A timer action under the user's lock, then everyone's pages told (the timer's new epoch). */
export async function act<T extends { epoch: number }>(userId: number, opId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const r = await withTimerLock(userId, (tx) => once(tx, userId, opId, () => fn(tx)));
  publish(userId, { type: "timers", epoch: r.epoch });
  return r;
}

/** The highest epoch among the user's timers (what a page last saw of them). */
export async function epochOf(tx: Tx | Db, userId: number): Promise<number> {
  const [r] = await tx
    .select({ e: sql<number>`coalesce(max(${timers.epoch}), 0)`.mapWith(Number) })
    .from(timers)
    .where(eq(timers.userId, userId));
  return r?.e ?? 0;
}

/** Remove the (stopped) timer of an issue once its time has been logged. */
async function clearPausedTimer(db: Db | Tx, userId: number, connectionId: number, issueKey: string) {
  await db.delete(timers).where(and(timerOf(userId, connectionId, issueKey), eq(timers.state, "paused")));
}

/** A log's shares of the time its timer ran with others: by the others it ran with, in basis points. */
export type ClaimSplit = { until: Date; shares: { with: string[]; bp: number }[] };

/** Seconds a timer counted up to `until` (a running one's run cut there). */
const trackedThrough = (t: Timer, until: Date) =>
  t.state === "running" ? t.accumulatedSeconds + Math.max(0, Math.floor((until.getTime() - t.startedAt.getTime()) / 1000)) : t.accumulatedSeconds;

/**
 * Takes `seconds` of a timer for a worklog, before the worklog is written,
 * under the lock: two devices logging the same timer at once can't both get
 * it (the second finds it gone: `null`). A stopped timer goes; one running
 * keeps running with the time removed. `undo` puts it back if the worklog
 * then fails.
 *
 * With `split` (it ran beside other timers), the log takes all the time the
 * timer counted up to `until`, though it logs less: the rest of the time it
 * shared is the others' part. Its shares are recorded, so the others' logs
 * default to what is left.
 */
export async function claimTimerSeconds(
  userId: number,
  issueKey: string,
  seconds: number,
  connectionId?: number,
  now: Date = new Date(),
  split?: ClaimSplit,
): Promise<{ undo: (back?: number) => Promise<void> } | null> {
  const conn = await issueConnection(userId, issueKey, connectionId);
  const claimed = await withTimerLock(userId, async (tx) => {
    const [t] = await tx.select().from(timers).where(timerOf(userId, conn.id, issueKey)).limit(1);
    if (!t) return null;
    const ref = refOf(t);
    // What earlier logs left behind goes first (never what this one may have to put back).
    await pruneRuns(tx, userId, now);
    const until = split && split.until.getTime() < now.getTime() ? split.until : now;
    const taken = split ? trackedThrough(t, until) : seconds;
    if (t.state !== "running") {
      await clearPausedTimer(tx, userId, conn.id, issueKey);
    } else {
      await tx
        .update(timers)
        .set({ accumulatedSeconds: Math.max(0, elapsedSeconds(t, now) - taken), startedAt: now, updatedAt: now, epoch: t.epoch + 1 })
        .where(eq(timers.id, t.id));
    }
    // The shares come from the runs as the database has them, never from the page's seconds.
    let sharesTaken: { start: number; end: number; bp: number }[] = [];
    if (split) {
      const read = await splitInputs(tx, ref, until);
      const runs: SplitRun[] = read.runs.filter((r) => r.start < until.getTime()).map((r) => ({ ...r, end: Math.min(r.end, until.getTime()) }));
      const id = timerId(conn.id, issueKey);
      const given = Object.fromEntries(split.shares.map((x) => [groupKey(x.with), x.bp]));
      sharesTaken = stretchesOf(id, runs, read.shares).stretches.map((x) => ({ start: x.start, end: x.end, bp: given[groupKey(x.others)] ?? x.defaultBp }));
    }
    // A running timer's run is cut at `until`: what it ran since is still to log.
    const consumed = await consumeRuns(tx, ref, until, now);
    consumed.shares = await recordShares(tx, ref, sharesTaken);
    return { t, taken, consumed };
  });
  if (!claimed) return null;
  const { t: was, taken, consumed } = claimed;
  publish(userId, { type: "timers", epoch: was.epoch + 1 });
  return {
    /** Put back `back` seconds (all of them by default; less when part of the time was logged). */
    undo: async (back: number = seconds) => {
      // A split log takes more than it logs: what goes back is that much of what it took.
      const returned = split ? Math.round((back / Math.max(1, seconds)) * taken) : back;
      const logged = taken - returned;
      await withTimerLock(userId, async (tx) => {
        const [t] = await tx.select().from(timers).where(timerOf(userId, conn.id, issueKey)).limit(1);
        if (!t) {
          await tx.insert(timers).values({
            ...was,
            id: undefined,
            accumulatedSeconds: Math.max(0, was.accumulatedSeconds - logged),
            epoch: was.epoch + 2,
            updatedAt: new Date(),
          });
        } else {
          await tx
            .update(timers)
            .set({ accumulatedSeconds: t.accumulatedSeconds + returned, epoch: t.epoch + 1, updatedAt: new Date() })
            .where(eq(timers.id, t.id));
        }
        // Nothing logged: the runs and shares are as they were.
        if (returned >= taken) await unconsumeRuns(tx, consumed);
      });
      publish(userId, { type: "timers", epoch: was.epoch + 2 });
    },
  };
}

/**
 * Pauses a running timer: its owner lets go, everyone's view moves on. The
 * TODO worked on with it (a linked stretch) stops there too, and its run ends.
 */
export async function pauseTimer(db: Db | Tx, t: Timer, now: Date): Promise<number> {
  const epoch = t.epoch + 1;
  if (t.state === "running") {
    await endLinkedSessionOf(db, t.userId, now, t);
    await closeRun(db, refOf(t), now);
  }
  await db
    .update(timers)
    .set({ state: "paused", accumulatedSeconds: elapsedSeconds(t, now), pausedAt: now, updatedAt: now, epoch, ...released })
    .where(eq(timers.id, t.id));
  return epoch;
}

/** Timer ops are answered again on a retry for a day, then forgotten; runs and shares a month after their log. */
export async function purgeTimerOps(now = Date.now()) {
  await getDb().delete(timerOps).where(lt(timerOps.createdAt, new Date(now - 86_400_000)));
  await pruneOldRuns(getDb(), new Date(now));
}

const issueInput = { issueKey: issueKeyInput, connectionId: connectionInput };

/** One timer of the user, under the lock: its row, or nothing. */
async function rowOf(tx: Tx, userId: number, connectionId: number, issueKey: string) {
  return (await tx.select().from(timers).where(timerOf(userId, connectionId, issueKey)).limit(1))[0];
}

/**
 * Starts (or resumes) an issue's timer inside the user's lock: the body of
 * `start`, shared with a TODO's start (which opens its stretch in the same
 * transaction). See `start` for what it does to the others.
 */
/**
 * How a timer starts while others run: `switch` pauses them (their time asked
 * to be logged), `alongside` leaves them running (timers side by side, their
 * time together shared out at their logs).
 */
export type StartMode = "switch" | "alongside";

/** A timer a start paused: its time is asked to be logged. */
export type SwitchedFrom = { issueKey: string; connectionId: number; seconds: number; note: string; stoppedAt: Date };

export async function startTimerIn(
  tx: Tx,
  w: Who,
  userId: number,
  connectionId: number,
  issueKey: string,
  opts: { force?: boolean; from: Date | null; mode?: StartMode; parallelOff?: boolean },
  now: Date,
) {
  const from = opts.from;
  const mode = opts.mode ?? "switch";
  const running = await tx
    .select()
    .from(timers)
    .where(and(eq(timers.userId, userId), eq(timers.state, "running")));
  const isTarget = (o: Timer) => o.issueKey === issueKey && o.connectionId === connectionId;
  // Overlapping time refused: nothing starts beside another running timer (a take-over of a lone one still does).
  if (mode === "alongside" && opts.parallelOff && running.some((o) => !isTarget(o))) {
    throw new TRPCError({ code: "CONFLICT", message: tr("server.timers.parallelBlocked") });
  }
  // Alongside, the others are left alone: only the one started is checked.
  for (const r of running) if ((mode === "switch" || isTarget(r)) && heldElsewhere(r, w, now) && !opts.force) refuse("held", r);
  if (from) {
    // Another timer's time covers it: one running (it would be paused now, its time
    // counted twice), or one paused after it.
    if (running.length > 0) throw new TRPCError({ code: "CONFLICT", message: tr("server.timers.fromWhileRunning") });
    const paused = await tx
      .select({ pausedAt: timers.pausedAt })
      .from(timers)
      .where(and(eq(timers.userId, userId), eq(timers.state, "paused")));
    if (paused.some((p) => p.pausedAt && p.pausedAt.getTime() > from.getTime())) {
      throw new TRPCError({ code: "CONFLICT", message: tr("server.timers.fromBeforePause") });
    }
  }
  const startedAt = from ?? now;
  // An issue timer takes the focus: a TODO worked on without one stops where this starts.
  await endSession(tx, userId, startedAt, false);
  // A switch pauses every other running timer; alongside they run on.
  const others = mode === "switch" ? running.filter((o) => !isTarget(o)) : [];
  const switchedFromAll: SwitchedFrom[] = [];
  let tookOver = false;
  for (const o of others) {
    switchedFromAll.push({ issueKey: o.issueKey, connectionId: o.connectionId, seconds: roundToMinute(elapsedSeconds(o, now)), note: o.note, stoppedAt: now });
    tookOver ||= heldElsewhere(o, w, now);
    await pauseTimer(tx, o, now);
  }
  const switchedFrom = switchedFromAll.at(-1) ?? null;
  const existing = await rowOf(tx, userId, connectionId, issueKey);
  if (existing?.state === "running") {
    // Already running: this device takes control (or renews it); the time is untouched.
    tookOver ||= heldElsewhere(existing, w, now);
    const moves = existing.ownerDevice !== (w.device ?? null);
    const epoch = moves ? existing.epoch + 1 : existing.epoch;
    await tx.update(timers).set({ ...ownedBy(w, now), epoch, updatedAt: now }).where(eq(timers.id, existing.id));
    return { ok: true, switchedFrom, switchedFromAll, tookOver, epoch: Math.max(epoch, await epochOf(tx, userId)) };
  }
  await openRun(tx, { userId, connectionId, issueKey }, startedAt);
  if (existing) {
    await tx
      .update(timers)
      .set({ state: "running", startedAt, pausedAt: null, updatedAt: now, epoch: existing.epoch + 1, ...ownedBy(w, now) })
      .where(eq(timers.id, existing.id));
  } else {
    await tx.insert(timers).values({
      userId,
      connectionId,
      issueKey,
      state: "running",
      startedAt,
      accumulatedSeconds: 0,
      epoch: (await epochOf(tx, userId)) + 1,
      ...ownedBy(w, now),
    });
  }
  return { ok: true, switchedFrom, switchedFromAll, tookOver, epoch: await epochOf(tx, userId) };
}

export const timersRouter = createRouter({
  /**
   * All timers of the user, with elapsed computed at request time and who
   * controls each: this device, another one (with its lease live), or nobody
   * any more (orphaned: free to take).
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb().select().from(timers).where(eq(timers.userId, ctx.user.id));
    const now = new Date();
    const split = new Map<number, { overlap: number; byDefault: number }>();
    for (const t of rows) {
      const read = await splitInputs(getDb(), refOf(t), now);
      if (read.runs.length === 0) continue;
      const id = timerId(t.connectionId, t.issueKey);
      const s = splitOf(id, stretchesOf(id, read.runs, read.shares), {}, elapsedSeconds(t, now));
      if (s.groups.length === 0) continue;
      split.set(t.id, {
        overlap: Math.round(s.groups.reduce((a, g) => a + g.seconds, 0)),
        byDefault: Math.round(s.aloneSeconds + s.groups.reduce((a, g) => a + g.shareSeconds, 0)),
      });
    }
    return rows.map((t) => {
      const ownedHere = !!t.ownerDevice && t.ownerDevice === ctx.deviceId;
      const live = leaseLive(t, now);
      return {
        issueKey: t.issueKey,
        connectionId: t.connectionId,
        state: t.state,
        note: t.note,
        elapsedSeconds: elapsedSeconds(t, now),
        /** Paused/stopped: when (its worklog ends there); null while running */
        pausedAt: t.state === "running" ? null : (t.pausedAt ?? t.updatedAt),
        serverNow: now,
        epoch: t.epoch,
        /** Running: when this run began (server clock) */
        runningSince: t.state === "running" ? t.startedAt : null,
        /**
         * Paused/stopped after a single run (never paused before): its time ran
         * without a break, so it is placed in one piece, over a lunch break too.
         */
        unbroken:
          t.state !== "running" &&
          Math.abs(((t.pausedAt ?? t.updatedAt).getTime() - t.startedAt.getTime()) / 1000 - t.accumulatedSeconds) < 60,
        ownerLabel: t.ownerLabel,
        /** This device controls it */
        ownedHere,
        /** Another device controls it now: act only by taking over */
        heldElsewhere: live && !ownedHere,
        /** Its owner went silent (slept, closed, offline): running, and free to take */
        orphaned: t.state === "running" && !!t.ownerDevice && !live && !ownedHere,
        /** Last heartbeat's lease end (the owner was last heard a lease before) */
        leaseUntil: t.leaseUntil,
        /** Of its time, how much ran together with other timers (shared out at the log) */
        overlapSeconds: split.get(t.id)?.overlap ?? 0,
        /** What its log takes with the default shares (its whole time when it ran alone) */
        defaultSeconds: split.get(t.id)?.byDefault ?? elapsedSeconds(t, now),
      };
    });
  }),

  /**
   * Start (or resume) the timer on an issue. With `mode: "switch"` (the
   * default) the timers running on other issues are stopped (paused) and
   * returned as `switchedFromAll` (`switchedFrom`: the last of them) so the
   * client asks to log their time; they stay paused until logged or
   * discarded. With `alongside` they run on, side by side with it: refused
   * while overlapping time is refused (overlap policy "block"). While another
   * device holds a timer this would pause, only `force` (a take-over) acts;
   * taking over the same issue moves control only: the time runs on, once.
   */
  start: protectedProcedure
    .input(
      z.object({
        ...issueInput,
        ...control,
        device: z.string().max(60).optional(),
        /** Counted from this moment of today (the start of the gap it fills), not from now. */
        from: z.iso.datetime({ offset: true }).optional(),
        /** What happens to the timers already running: paused (switch) or left running beside it */
        mode: z.enum(["switch", "alongside"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const w = whoOf(ctx, input.device);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const from = input.from === undefined ? null : new Date(input.from);
      const mode = input.mode ?? "switch";
      if (mode === "alongside" && from) throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.timers.alongsideFrom") });
      const parallelOff = mode === "alongside" && (await getSettings(ctx.user.id)).overlapPolicy === "block";
      // One transaction under the user's lock: two concurrent starts (two tabs,
      // two devices) can't both see "nothing running" and leave two timers going.
      const start = () => act(ctx.user.id, input.opId, (tx) => startTimerIn(tx, w, ctx.user.id, conn.id, input.issueKey, { force: input.force, from, mode, parallelOff }, now));
      if (!from) return start();
      if (from.getTime() > now.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.timers.fromFuture") });
      if (dayKey(from) !== dayKey(now)) throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.timers.fromToday") });
      // From a gap's start: the time must be free, whatever the overlap policy (it would count
      // twice), checked and started under the write lease, so no worklog lands in it meanwhile.
      return withWriteLease(ctx.user.id, async () => {
        await assertNoOverlap(ctx.user.id, { start: from, seconds: Math.max(1, Math.floor((now.getTime() - from.getTime()) / 1000)) }, undefined, true);
        return start();
      });
    }),

  /**
   * The owner's heartbeat: renews its lease on every timer it runs. A device
   * that lost control (taken over, paused elsewhere) learns it here: `owned`
   * false. One back from sleep or offline whose timers nobody took gets its
   * lease again.
   */
  heartbeat: protectedProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    if (!ctx.deviceId) return { owned: false, epoch: 0 };
    return withTimerLock(ctx.user.id, async (tx) => {
      const mine = await tx
        .update(timers)
        .set({ leaseUntil: new Date(now.getTime() + TIMER_LEASE_MS) })
        .where(and(eq(timers.userId, ctx.user.id), eq(timers.state, "running"), eq(timers.ownerDevice, ctx.deviceId ?? "")))
        .returning({ epoch: timers.epoch });
      if (mine.length === 0) return { owned: false, epoch: await epochOf(tx, ctx.user.id) };
      return { owned: true, epoch: Math.max(...mine.map((m) => m.epoch)) };
    });
  }),

  pause: protectedProcedure.input(z.object({ ...issueInput, ...control })).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const w = whoOf(ctx);
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    return act(ctx.user.id, input.opId, async (tx) => {
      const t = await rowOf(tx, ctx.user.id, conn.id, input.issueKey);
      if (!t || t.state !== "running") return { ok: true, epoch: await epochOf(tx, ctx.user.id) };
      mayAct(t, w, now, input);
      return { ok: true, epoch: await pauseTimer(tx, t, now) };
    });
  }),

  /**
   * Stop the timer: it is paused and the tracked time returned (rounded to
   * minutes). The timer is cleared only when the time is actually logged
   * (worklogs.create with fromTimer), so cancelling the log loses nothing.
   */
  stop: protectedProcedure.input(z.object({ ...issueInput, ...control })).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const w = whoOf(ctx);
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    return act(ctx.user.id, input.opId, async (tx) => {
      const t = await rowOf(tx, ctx.user.id, conn.id, input.issueKey);
      if (!t) return { found: false as const, seconds: 0, note: "", stoppedAt: null, epoch: await epochOf(tx, ctx.user.id) };
      if (t.state === "running") mayAct(t, w, now, input);
      const seconds = roundToMinute(elapsedSeconds(t, now));
      const epoch = t.state === "running" ? await pauseTimer(tx, t, now) : t.epoch;
      // Already paused: its time ended at the pause, not now.
      const stoppedAt = t.state === "running" ? now : (t.pausedAt ?? t.updatedAt);
      return { found: true as const, seconds, note: t.note, stoppedAt, epoch };
    });
  }),

  /** What the user is doing on this timer (becomes the worklog comment): any device may write it. */
  setNote: protectedProcedure
    .input(z.object({ ...issueInput, note: z.string().max(500) }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      return act(ctx.user.id, undefined, async (tx) => {
        await tx.update(timers).set({ note: input.note, updatedAt: new Date() }).where(timerOf(ctx.user.id, conn.id, input.issueKey));
        return { ok: true, epoch: await epochOf(tx, ctx.user.id) };
      });
    }),

  /**
   * Remove away time (idle detection). Never goes below zero; a running
   * timer keeps running from now with the reduced total.
   */
  trim: protectedProcedure
    .input(z.object({ ...issueInput, ...control, seconds: z.number().int().min(1).max(7 * 24 * 3600) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const w = whoOf(ctx);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      return act(ctx.user.id, input.opId, async (tx) => {
        const t = await rowOf(tx, ctx.user.id, conn.id, input.issueKey);
        if (!t) return { found: false as const, elapsedSeconds: 0, epoch: await epochOf(tx, ctx.user.id) };
        mayAct(t, w, now, input);
        const remaining = Math.max(0, elapsedSeconds(t, now) - input.seconds);
        if (t.state === "running") await trimSession(tx, ctx.user.id, input.seconds, now, t);
        // The away time leaves its runs too: the last of them, up to now (or its pause).
        await trimRuns(tx, refOf(t), input.seconds, t.state === "running" ? now : (t.pausedAt ?? now));
        if (t.state === "running") await openRun(tx, refOf(t), now);
        await tx
          .update(timers)
          .set({ accumulatedSeconds: remaining, startedAt: now, updatedAt: now, epoch: t.epoch + 1 })
          .where(eq(timers.id, t.id));
        return { found: true as const, elapsedSeconds: remaining, epoch: t.epoch + 1 };
      });
    }),

  /**
   * The timer moved to another issue with its count (started on the wrong
   * one): running it runs on there, paused it waits there. When that issue
   * has a timer already, its time and this one's add up (notes joined). The
   * TODO worked on with it follows to the new issue, its time running on.
   */
  move: protectedProcedure
    .input(z.object({ ...issueInput, ...control, toIssueKey: issueKeyInput, toConnectionId: connectionInput }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const w = whoOf(ctx);
      const from = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const to = await issueConnection(ctx.user.id, input.toIssueKey, input.toConnectionId);
      if (from.id === to.id && input.issueKey === input.toIssueKey) {
        throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.timers.moveSame") });
      }
      return act(ctx.user.id, input.opId, async (tx) => {
        const a = await rowOf(tx, ctx.user.id, from.id, input.issueKey);
        if (!a) throw new TRPCError({ code: "NOT_FOUND", message: tr("server.timers.moveNone", { key: input.issueKey }) });
        mayAct(a, w, now, input);
        const b = await rowOf(tx, ctx.user.id, to.id, input.toIssueKey);
        const seconds = elapsedSeconds(a, now);
        const running = a.state === "running" || b?.state === "running";
        const epoch = Math.max(a.epoch, b?.epoch ?? 0, await epochOf(tx, ctx.user.id)) + 1;
        // The new issue's row (set here: a key unchanged on another tracker fires no link trigger).
        const [item] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, to.id), eq(issues.key, input.toIssueKey)))
          .limit(1);
        const itemId = item?.id ?? null;
        const note = [b?.note, a.note].filter((n): n is string => !!n && n.trim() !== "").join(" · ").slice(0, 500);
        // Its runs go along: closed here, one run from now if it runs on.
        const target = { userId: ctx.user.id, connectionId: to.id, issueKey: input.toIssueKey };
        await closeRun(tx, refOf(a), now);
        if (b) await closeRun(tx, refOf(b), now);
        await renameRuns(tx, ctx.user.id, { connectionId: from.id, issueKey: input.issueKey }, { connectionId: to.id, issueKey: input.toIssueKey });
        if (running) await openRun(tx, target, now);
        if (!b) {
          await tx
            .update(timers)
            .set({
              connectionId: to.id,
              issueKey: input.toIssueKey,
              itemId,
              epoch,
              updatedAt: now,
              ...(a.state === "running" ? ownedBy(w, now) : {}),
            })
            .where(eq(timers.id, a.id));
        } else {
          // Two counts on one issue: added up, running if either ran.
          const base = elapsedSeconds(b, now) + seconds;
          const pausedAt = [a.pausedAt, b.pausedAt].filter((d): d is Date => d !== null).sort((x, y) => y.getTime() - x.getTime())[0] ?? now;
          await tx.delete(timers).where(eq(timers.id, a.id));
          await tx
            .update(timers)
            .set({
              accumulatedSeconds: base,
              startedAt: now,
              state: running ? "running" : "paused",
              pausedAt: running ? null : pausedAt,
              note,
              epoch,
              updatedAt: now,
              ...(running ? ownedBy(w, now) : released),
            })
            .where(eq(timers.id, b.id));
        }
        // The TODO worked on with it: tied to the new issue now (its comment or note stays on the old one).
        const working = await openSession(tx, ctx.user.id);
        if (working?.linked === 1 && working.todoId !== null) {
          await tx
            .update(todos)
            .set({ connectionId: to.id, issueKey: input.toIssueKey, itemId, commentId: null, commentExcerpt: null, issueNoteId: null, updatedAt: now })
            .where(and(eq(todos.id, working.todoId), eq(todos.userId, ctx.user.id)));
        }
        const total = b ? elapsedSeconds(b, now) + seconds : seconds;
        // Stopped (paused) there: what its log asks for, rounded as a stop's.
        return { ok: true, seconds, total, toLog: roundToMinute(total), running, note, merged: !!b, epoch };
      });
    }),

  /**
   * What a log of the timer splits: its time (`trackedSeconds`, up to `until`)
   * and every run and share it ran beside, for contracts/timerSplit.ts to share
   * out as the Log time dialog's percentages are edited. No other run beside
   * it: nothing to split.
   */
  split: protectedProcedure
    .input(z.object({ ...issueInput, until: z.iso.datetime({ offset: true }).optional() }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const until = input.until && new Date(input.until).getTime() < now.getTime() ? new Date(input.until) : now;
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const [t] = await getDb().select().from(timers).where(timerOf(ctx.user.id, conn.id, input.issueKey)).limit(1);
      const target = timerId(conn.id, input.issueKey);
      if (!t) return { target, until, trackedSeconds: 0, runs: [] as SplitRun[], shares: [] as { timer: string; start: number; end: number; bp: number }[] };
      const read = await splitInputs(getDb(), refOf(t), until);
      return {
        target,
        until,
        trackedSeconds: trackedThrough(t, until),
        runs: read.runs.filter((r) => r.start < until.getTime()).map((r) => ({ ...r, end: Math.min(r.end, until.getTime()) })),
        shares: read.shares,
      };
    }),

  /** Discard the timer without logging time. */
  discard: protectedProcedure.input(z.object({ ...issueInput, ...control })).mutation(async ({ ctx, input }) => {
    const now = new Date();
    const w = whoOf(ctx);
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    return act(ctx.user.id, input.opId, async (tx) => {
      const t = await rowOf(tx, ctx.user.id, conn.id, input.issueKey);
      if (!t) return { ok: true, epoch: await epochOf(tx, ctx.user.id) };
      mayAct(t, w, now, input);
      if (t.state === "running") await endLinkedSessionOf(tx, ctx.user.id, now, t);
      await tx.delete(timers).where(eq(timers.id, t.id));
      // Its time never happened: the time it ran with others is theirs alone.
      await discardRuns(tx, refOf(t));
      await pruneRuns(tx, ctx.user.id, now);
      // Gone rows can't carry an epoch: the next one starts above it.
      return { ok: true, epoch: t.epoch + 1 };
    });
  }),
});
