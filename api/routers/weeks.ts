import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { withWriteLease } from "../queries/writeLease";
import { weekLocks } from "@db/schema";
import { parseDayKey, weekStartKey } from "@contracts/time";
import { t } from "@contracts/i18n";

const weekInput = z.object({
  /** Any local day of the target week, "YYYY-MM-DD"; normalized to its Monday */
  week: z.string().min(1),
});

function normalizeWeek(week: string): string {
  const d = parseDayKey(week);
  if (!d) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.weeks.invalidDate") });
  }
  return weekStartKey(d);
}

/** True when the week containing `date` is closed for the user. */
export async function isWeekClosed(userId: number, date: Date): Promise<boolean> {
  const rows = await getDb()
    .select({ id: weekLocks.id })
    .from(weekLocks)
    .where(and(eq(weekLocks.userId, userId), eq(weekLocks.weekStart, weekStartKey(date))));
  return rows.length > 0;
}

/** Reject worklog edits that touch a closed week. */
export async function assertWeekOpen(userId: number, date: Date): Promise<void> {
  if (await isWeekClosed(userId, date)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: t("server.weeks.closed"),
    });
  }
}

export const weeksRouter = createRouter({
  /** Closed weeks, most recent first. */
  list: protectedProcedure.query(async ({ ctx }) =>
    getDb()
      .select()
      .from(weekLocks)
      .where(eq(weekLocks.userId, ctx.user.id))
      .orderBy(desc(weekLocks.weekStart)),
  ),

  /** Lock row of the given week, or null when the week is open. */
  status: protectedProcedure.input(weekInput).query(async ({ ctx, input }) => {
    const rows = await getDb()
      .select()
      .from(weekLocks)
      .where(
        and(
          eq(weekLocks.userId, ctx.user.id),
          eq(weekLocks.weekStart, normalizeWeek(input.week)),
        ),
      );
    return rows[0] ?? null;
  }),

  /** Close a week: its worklogs become read-only. Idempotent. */
  close: protectedProcedure
    .input(weekInput.extend({ note: z.string().max(500).default("") }))
    .mutation(({ ctx, input }) =>
      // Under the write lease: a worklog being written into this week lands before it closes, or not at all.
      withWriteLease(ctx.user.id, async () => {
        const weekStart = normalizeWeek(input.week);
        const db = getDb();
        await db
          .insert(weekLocks)
          .values({ userId: ctx.user.id, weekStart, note: input.note })
          .onConflictDoNothing();
        const rows = await db
          .select()
          .from(weekLocks)
          .where(and(eq(weekLocks.userId, ctx.user.id), eq(weekLocks.weekStart, weekStart)));
        return rows[0];
      }),
    ),

  /** Reopen a closed week. Idempotent. */
  reopen: protectedProcedure.input(weekInput).mutation(({ ctx, input }) =>
    withWriteLease(ctx.user.id, async () => {
      await getDb()
        .delete(weekLocks)
        .where(
          and(
            eq(weekLocks.userId, ctx.user.id),
            eq(weekLocks.weekStart, normalizeWeek(input.week)),
          ),
        );
      return { ok: true };
    }),
  ),
});
