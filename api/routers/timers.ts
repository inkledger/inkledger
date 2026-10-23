import { z } from "zod";
import { and, eq, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import superjson from "superjson";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { timerOps, timers, type Timer } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { publish } from "../lib/userEvents";
import { TimerConflictError } from "../lib/timerConflict";
import { TIMER_LEASE_MS } from "@contracts/timerLock";
import { deviceLabel } from "@contracts/device";
import { dayKey } from "@contracts/time";
import { assertNoOverlap } from "../queries/overlap";
import { endSession, trimSession } from "../queries/todoSessions";
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

/** Round to the nearest whole minute, at least one (Jira logs per minute). */
export function roundToMinute(seconds: number): number {
  return Math.max(60, Math.round(seconds / 60) * 60);
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Timer writes one at a time per user, under the same lock as `start`: a
 * read-then-write (stop, trim, a log consuming the time) can't interleave
 * with another one and resurrect or lose time. The lock is the database's,
 * so it holds across processes too.
 */
export function withTimerLock<T>(userId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${userId})`);
    return fn(tx);
  });
}

/** A timer by its issue, on the issue's connection. */
const timerOf = (userId: number, connectionId: number, issueKey: string) =>
  and(eq(timers.userId, userId), eq(timers.connectionId, connectionId), eq(timers.issueKey, issueKey));

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

/**
 * Takes `seconds` of a timer for a worklog, before the worklog is written,
 * under the lock: two devices logging the same timer at once can't both get
 * it (the second finds it gone: `null`). A stopped timer goes; one running
 * keeps running with the time removed. `undo` puts it back if the worklog
 * then fails.
 */
export async function claimTimerSeconds(
  userId: number,
  issueKey: string,
  seconds: number,
  connectionId?: number,
  now: Date = new Date(),
): Promise<{ undo: () => Promise<void> } | null> {
  const conn = await issueConnection(userId, issueKey, connectionId);
  const claimed = await withTimerLock(userId, async (tx) => {
    const [t] = await tx.select().from(timers).where(timerOf(userId, conn.id, issueKey)).limit(1);
    if (!t) return null;
    if (t.state !== "running") {
      await clearPausedTimer(tx, userId, conn.id, issueKey);
    } else {
      await tx
        .update(timers)
        .set({ accumulatedSeconds: Math.max(0, elapsedSeconds(t, now) - seconds), startedAt: now, updatedAt: now, epoch: t.epoch + 1 })
        .where(eq(timers.id, t.id));
    }
    return t;
  });
  if (!claimed) return null;
  publish(userId, { type: "timers", epoch: claimed.epoch + 1 });
  return {
    undo: async () => {
      await withTimerLock(userId, async (tx) => {
        const [t] = await tx.select().from(timers).where(timerOf(userId, conn.id, issueKey)).limit(1);
        if (!t) {
          await tx.insert(timers).values({ ...claimed, id: undefined, epoch: claimed.epoch + 2, updatedAt: new Date() });
        } else {
          await tx
            .update(timers)
            .set({ accumulatedSeconds: t.accumulatedSeconds + seconds, epoch: t.epoch + 1, updatedAt: new Date() })
            .where(eq(timers.id, t.id));
        }
      });
      publish(userId, { type: "timers", epoch: claimed.epoch + 2 });
    },
  };
}

/**
 * Pauses a running timer: its owner lets go, everyone's view moves on. The
 * TODO worked on with it (a linked stretch) stops there too.
 */
export async function pauseTimer(db: Db | Tx, t: Timer, now: Date): Promise<number> {
  const epoch = t.epoch + 1;
  if (t.state === "running") await endSession(db, t.userId, now, true);
  await db
    .update(timers)
    .set({ state: "paused", accumulatedSeconds: elapsedSeconds(t, now), pausedAt: now, updatedAt: now, epoch, ...released })
    .where(eq(timers.id, t.id));
  return epoch;
}

/** Timer ops are answered again on a retry for a day, then forgotten. */
export async function purgeTimerOps(now = Date.now()) {
  await getDb().delete(timerOps).where(lt(timerOps.createdAt, new Date(now - 86_400_000)));
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
export async function startTimerIn(tx: Tx, w: Who, userId: number, connectionId: number, issueKey: string, opts: { force?: boolean; from: Date | null }, now: Date) {
  const from = opts.from;
  const running = await tx
    .select()
    .from(timers)
    .where(and(eq(timers.userId, userId), eq(timers.state, "running")));
  for (const r of running) if (heldElsewhere(r, w, now) && !opts.force) refuse("held", r);
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
  // Auto-pause any other running timers (single active timer per user).
  const others = running.filter((o) => o.issueKey !== issueKey || o.connectionId !== connectionId);
  let switchedFrom: { issueKey: string; connectionId: number; seconds: number; note: string; stoppedAt: Date } | null = null;
  let tookOver = false;
  for (const o of others) {
    switchedFrom = { issueKey: o.issueKey, connectionId: o.connectionId, seconds: roundToMinute(elapsedSeconds(o, now)), note: o.note, stoppedAt: now };
    tookOver ||= heldElsewhere(o, w, now);
    await pauseTimer(tx, o, now);
  }
  const existing = await rowOf(tx, userId, connectionId, issueKey);
  if (existing?.state === "running") {
    // Already running: this device takes control (or renews it); the time is untouched.
    tookOver ||= heldElsewhere(existing, w, now);
    const moves = existing.ownerDevice !== (w.device ?? null);
    const epoch = moves ? existing.epoch + 1 : existing.epoch;
    await tx.update(timers).set({ ...ownedBy(w, now), epoch, updatedAt: now }).where(eq(timers.id, existing.id));
    return { ok: true, switchedFrom, tookOver, epoch: Math.max(epoch, await epochOf(tx, userId)) };
  }
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
  return { ok: true, switchedFrom, tookOver, epoch: await epochOf(tx, userId) };
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
        ownerLabel: t.ownerLabel,
        /** This device controls it */
        ownedHere,
        /** Another device controls it now: act only by taking over */
        heldElsewhere: live && !ownedHere,
        /** Its owner went silent (slept, closed, offline): running, and free to take */
        orphaned: t.state === "running" && !!t.ownerDevice && !live && !ownedHere,
        /** Last heartbeat's lease end (the owner was last heard a lease before) */
        leaseUntil: t.leaseUntil,
      };
    });
  }),

  /**
   * Start (or resume) the timer on an issue. A timer running on another
   * issue is stopped (paused) and returned as `switchedFrom` so the client
   * asks to log its time; it stays paused until logged or discarded. While
   * another device holds the running timer, only `force` (a take-over) acts;
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const w = whoOf(ctx, input.device);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const from = input.from === undefined ? null : new Date(input.from);
      if (from) {
        if (from.getTime() > now.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.timers.fromFuture") });
        if (dayKey(from) !== dayKey(now)) throw new TRPCError({ code: "BAD_REQUEST", message: tr("server.timers.fromToday") });
        // From a gap's start: the time must be free, whatever the overlap policy (it would count twice).
        await assertNoOverlap(ctx.user.id, { start: from, seconds: Math.max(1, Math.floor((now.getTime() - from.getTime()) / 1000)) }, undefined, true);
      }
      // One transaction under the user's lock: two concurrent starts (two tabs,
      // two devices) can't both see "nothing running" and leave two timers going.
      return act(ctx.user.id, input.opId, (tx) => startTimerIn(tx, w, ctx.user.id, conn.id, input.issueKey, { force: input.force, from }, now));
    }),

  /**
   * The owner's heartbeat: renews its lease on the running timer. A device
   * that lost control (taken over, paused elsewhere) learns it here: `owned`
   * false. One back from sleep or offline whose timer nobody took gets its
   * lease again.
   */
  heartbeat: protectedProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    if (!ctx.deviceId) return { owned: false, epoch: 0 };
    return withTimerLock(ctx.user.id, async (tx) => {
      const [mine] = await tx
        .select()
        .from(timers)
        .where(and(eq(timers.userId, ctx.user.id), eq(timers.state, "running"), eq(timers.ownerDevice, ctx.deviceId ?? "")));
      if (!mine) return { owned: false, epoch: await epochOf(tx, ctx.user.id) };
      await tx
        .update(timers)
        .set({ leaseUntil: new Date(now.getTime() + TIMER_LEASE_MS) })
        .where(eq(timers.id, mine.id));
      return { owned: true, epoch: mine.epoch };
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
        if (t.state === "running") await trimSession(tx, ctx.user.id, input.seconds, now);
        await tx
          .update(timers)
          .set({ accumulatedSeconds: remaining, startedAt: now, updatedAt: now, epoch: t.epoch + 1 })
          .where(eq(timers.id, t.id));
        return { found: true as const, elapsedSeconds: remaining, epoch: t.epoch + 1 };
      });
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
      if (t.state === "running") await endSession(tx, ctx.user.id, now, true);
      await tx.delete(timers).where(eq(timers.id, t.id));
      // Gone rows can't carry an epoch: the next one starts above it.
      return { ok: true, epoch: t.epoch + 1 };
    });
  }),
});
