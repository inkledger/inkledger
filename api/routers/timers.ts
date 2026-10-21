import { z } from "zod";
import { and, eq, ne, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { timers, type Timer } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";

/** The issue's connection, when a key lives on two. */
const connectionInput = z.number().int().positive().optional();

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
 * with another one and resurrect or lose time.
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

/** Remove the (stopped) timer of an issue once its time has been logged. */
async function clearPausedTimer(db: Db | Tx, userId: number, connectionId: number, issueKey: string) {
  await db.delete(timers).where(and(timerOf(userId, connectionId, issueKey), eq(timers.state, "paused")));
}

/**
 * Settle a timer after `seconds` of it were logged. A stopped (paused) timer
 * is cleared; one restarted meanwhile keeps running with the logged time
 * removed (like `trim`: elapsed recomputed now, never below zero).
 * `connectionId`: the issue's connection (a key may live on two).
 */
export async function consumeTimerSeconds(
  userId: number,
  issueKey: string,
  seconds: number,
  now: Date = new Date(),
  connectionId?: number,
) {
  const conn = await issueConnection(userId, issueKey, connectionId);
  await withTimerLock(userId, async (tx) => {
    const [t] = await tx
      .select()
      .from(timers)
      .where(timerOf(userId, conn.id, issueKey))
      .limit(1);
    if (!t) return;
    if (t.state !== "running") {
      await clearPausedTimer(tx, userId, conn.id, issueKey);
      return;
    }
    const remaining = Math.max(0, elapsedSeconds(t, now) - seconds);
    await tx
      .update(timers)
      .set({ accumulatedSeconds: remaining, startedAt: now, updatedAt: now })
      .where(eq(timers.id, t.id));
  });
}

async function pauseTimer(db: Db | Tx, t: Timer, now: Date) {
  const accumulated = elapsedSeconds(t, now);
  await db
    .update(timers)
    .set({ state: "paused", accumulatedSeconds: accumulated, pausedAt: now, updatedAt: now })
    .where(eq(timers.id, t.id));
}

export const timersRouter = createRouter({
  /** All timers of the user, with elapsed computed at request time. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(timers)
      .where(eq(timers.userId, ctx.user.id));
    const now = new Date();
    return rows.map((t) => ({
      issueKey: t.issueKey,
      connectionId: t.connectionId,
      state: t.state,
      note: t.note,
      elapsedSeconds: elapsedSeconds(t, now),
      /** Paused/stopped: when (its worklog ends there); null while running */
      pausedAt: t.state === "running" ? null : (t.pausedAt ?? t.updatedAt),
      serverNow: now,
    }));
  }),

  /**
   * Start (or resume) the timer on an issue. A timer running on another
   * issue is stopped (paused) and returned as `switchedFrom` so the client
   * asks to log its time; it stays paused until logged or discarded.
   */
  start: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      // One transaction under the user's lock: two concurrent starts (two tabs,
      // two devices) can't both see "nothing running" and leave two timers going.
      return withTimerLock(ctx.user.id, async (tx) => {
        // Auto-pause any other running timers (single active timer per user)
        const others = await tx
          .select()
          .from(timers)
          .where(
            and(
              eq(timers.userId, ctx.user.id),
              eq(timers.state, "running"),
              // Another issue: the same key on another connection is one too.
              or(ne(timers.issueKey, input.issueKey), ne(timers.connectionId, conn.id)),
            ),
          );
        let switchedFrom: { issueKey: string; connectionId: number; seconds: number; note: string; stoppedAt: Date } | null =
          null;
        for (const o of others) {
          switchedFrom = {
            issueKey: o.issueKey,
            connectionId: o.connectionId,
            seconds: roundToMinute(elapsedSeconds(o, now)),
            note: o.note,
            stoppedAt: now,
          };
          await tx.update(timers)
            .set({
              state: "paused",
              accumulatedSeconds: elapsedSeconds(o, now),
              pausedAt: now,
              updatedAt: now,
            })
            .where(eq(timers.id, o.id));
        }
        const existing = (await tx
          .select()
          .from(timers)
          .where(timerOf(ctx.user.id, conn.id, input.issueKey)).limit(1))[0];
        if (existing) {
          if (existing.state !== "running") {
            await tx.update(timers)
              .set({ state: "running", startedAt: now, pausedAt: null, updatedAt: now })
              .where(eq(timers.id, existing.id));
          }
        } else {
          await tx.insert(timers)
            .values({
              userId: ctx.user.id,
              connectionId: conn.id,
              issueKey: input.issueKey,
              state: "running",
              startedAt: now,
              accumulatedSeconds: 0,
            });
        }
        return { ok: true, switchedFrom };
      });
    }),

  pause: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      return withTimerLock(ctx.user.id, async (tx) => {
        const rows = await tx
          .select()
          .from(timers)
          .where(timerOf(ctx.user.id, conn.id, input.issueKey))
          .limit(1);
        if (rows[0] && rows[0].state === "running") {
          await pauseTimer(tx, rows[0], new Date());
        }
        return { ok: true };
      });
    }),

  /**
   * Stop the timer: it is paused and the tracked time returned (rounded to
   * minutes). The timer is cleared only when the time is actually logged
   * (worklogs.create with fromTimer), so cancelling the log loses nothing.
   */
  stop: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      return withTimerLock(ctx.user.id, async (tx) => {
        const rows = await tx
          .select()
          .from(timers)
          .where(timerOf(ctx.user.id, conn.id, input.issueKey))
          .limit(1);
        const t = rows[0];
        if (!t) return { found: false as const, seconds: 0, note: "", stoppedAt: null };
        const now = new Date();
        const seconds = roundToMinute(elapsedSeconds(t, now));
        if (t.state === "running") await pauseTimer(tx, t, now);
        // Already paused: its time ended at the pause, not now.
        const stoppedAt = t.state === "running" ? now : (t.pausedAt ?? t.updatedAt);
        return { found: true as const, seconds, note: t.note, stoppedAt };
      });
    }),

  /** What the user is doing on this timer (becomes the worklog comment). */
  setNote: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput, note: z.string().max(500) }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      await getDb()
        .update(timers)
        .set({ note: input.note, updatedAt: new Date() })
        .where(timerOf(ctx.user.id, conn.id, input.issueKey));
      return { ok: true };
    }),

  /**
   * Remove away time (idle detection). Never goes below zero; a running
   * timer keeps running from now with the reduced total.
   */
  trim: protectedProcedure
    .input(
      z.object({
        issueKey: issueKeyInput,
        connectionId: connectionInput,
        seconds: z.number().int().min(1).max(7 * 24 * 3600),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      return withTimerLock(ctx.user.id, async (tx) => {
        const rows = await tx
          .select()
          .from(timers)
          .where(timerOf(ctx.user.id, conn.id, input.issueKey))
          .limit(1);
        const t = rows[0];
        if (!t) return { found: false as const, elapsedSeconds: 0 };
        const now = new Date();
        const remaining = Math.max(0, elapsedSeconds(t, now) - input.seconds);
        await tx
          .update(timers)
          .set({ accumulatedSeconds: remaining, startedAt: now, updatedAt: now })
          .where(eq(timers.id, t.id));
        return { found: true as const, elapsedSeconds: remaining };
      });
    }),

  /** Discard the timer without logging time. */
  discard: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      await db.delete(timers).where(timerOf(ctx.user.id, conn.id, input.issueKey));
      return { ok: true };
    }),
});
