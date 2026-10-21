import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { weekLocks, workSchedules } from "@db/schema";
import { parseDayKey, weekStartKey } from "@contracts/time";
import {
  defaultWorkSchedule,
  normalizeWorkSchedule,
  workScheduleSchema,
  EPOCH_DAY,
  type ScheduleVersion,
} from "@contracts/workSchedule";
import { getSettings } from "./settings";
import { t } from "@contracts/i18n";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const dayKeyInput = z
  .string()
  .regex(DAY_KEY, { error: () => t("server.workSchedule.invalidDate") })
  .refine((k) => parseDayKey(k) !== null, { error: () => t("server.workSchedule.invalidDate") });

/**
 * The user's versions, oldest first. The first one (from EPOCH_DAY) is
 * created on demand from the old daily target, so past weeks keep the
 * target they were judged with before schedules existed.
 */
export async function listScheduleVersions(userId: number): Promise<ScheduleVersion[]> {
  const db = getDb();
  const read = () =>
    db
      .select({ validFrom: workSchedules.validFrom, schedule: workSchedules.schedule })
      .from(workSchedules)
      .where(eq(workSchedules.userId, userId))
      .orderBy(asc(workSchedules.validFrom));
  let rows = await read();
  if (!rows.some((r) => r.validFrom === EPOCH_DAY)) {
    const { dailyTargetSeconds } = await getSettings(userId);
    await db
      .insert(workSchedules)
      .values({
        userId,
        validFrom: EPOCH_DAY,
        schedule: JSON.stringify(defaultWorkSchedule(dailyTargetSeconds)),
      })
      .onConflictDoNothing();
    rows = await read();
  }
  return rows.map((r) => ({
    validFrom: r.validFrom,
    schedule: normalizeWorkSchedule(JSON.parse(r.schedule) as unknown),
  }));
}

/**
 * A version applies from `from` to the next version (exclusive, or forever):
 * changing it must not touch a closed week in that range.
 */
async function assertRangeOpen(userId: number, from: string, until: string | null) {
  const fromDate = parseDayKey(from);
  if (!fromDate) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workSchedule.invalidDate") });
  const conds = [eq(weekLocks.userId, userId), gte(weekLocks.weekStart, weekStartKey(fromDate))];
  if (until) conds.push(lt(weekLocks.weekStart, until));
  const closed = await getDb()
    .select({ weekStart: weekLocks.weekStart })
    .from(weekLocks)
    .where(and(...conds))
    .limit(1);
  if (closed[0]) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: t("server.workSchedule.weekClosed", { week: closed[0].weekStart }),
    });
  }
}

/** First version after `validFrom`, if any. */
function nextAfter(versions: ScheduleVersion[], validFrom: string): string | null {
  return versions.find((v) => v.validFrom > validFrom)?.validFrom ?? null;
}

export const workScheduleRouter = createRouter({
  /** Every version, oldest first (the first covers all past days). */
  list: protectedProcedure.query(({ ctx }) => listScheduleVersions(ctx.user.id)),

  /** Save the schedule in force from `validFrom` (replaces a version on that day). */
  save: protectedProcedure
    .input(z.object({ validFrom: dayKeyInput, schedule: workScheduleSchema }))
    .mutation(async ({ ctx, input }) => {
      const versions = await listScheduleVersions(ctx.user.id);
      await assertRangeOpen(ctx.user.id, input.validFrom, nextAfter(versions, input.validFrom));
      const schedule = JSON.stringify(input.schedule);
      await getDb()
        .insert(workSchedules)
        .values({ userId: ctx.user.id, validFrom: input.validFrom, schedule })
        .onConflictDoUpdate({
          target: [workSchedules.userId, workSchedules.validFrom],
          set: { schedule, createdAt: new Date() },
        });
      return listScheduleVersions(ctx.user.id);
    }),

  /** Drop a version: its days fall back to the previous one. */
  remove: protectedProcedure
    .input(z.object({ validFrom: dayKeyInput }))
    .mutation(async ({ ctx, input }) => {
      if (input.validFrom === EPOCH_DAY) {
        throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workSchedule.firstCannotDelete") });
      }
      const versions = await listScheduleVersions(ctx.user.id);
      await assertRangeOpen(ctx.user.id, input.validFrom, nextAfter(versions, input.validFrom));
      await getDb()
        .delete(workSchedules)
        .where(
          and(eq(workSchedules.userId, ctx.user.id), eq(workSchedules.validFrom, input.validFrom)),
        );
      return listScheduleVersions(ctx.user.id);
    }),
});
