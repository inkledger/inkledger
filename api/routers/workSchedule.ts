import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { weekLocks, workDayOverrides, workSchedules } from "@db/schema";
import { addDays, dayKey, parseDayKey, weekStartKey } from "@contracts/time";
import {
  defaultWorkSchedule,
  EPOCH_DAY,
  sameWorkDay,
  scheduleFor,
  weekdayIndex,
  type DayOverrides,
  type ScheduleVersion,
} from "@contracts/workSchedule";
import { normalizeWorkSchedule, workDaySchema, workScheduleSchema, type WorkDay } from "@contracts/workScheduleSchema";
import { getSettings } from "./settings";
import { withWriteLease } from "../queries/writeLease";
import { publish } from "../lib/userEvents";
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

/** A stored day's hours, or null when not valid (then the weekly hours apply). */
export function parseWorkDay(raw: string): WorkDay | null {
  try {
    const parsed = workDaySchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The user's hours of single days, by day. */
export async function listDayOverrides(userId: number): Promise<DayOverrides> {
  const rows = await getDb()
    .select({ day: workDayOverrides.day, workDay: workDayOverrides.workDay })
    .from(workDayOverrides)
    .where(eq(workDayOverrides.userId, userId))
    .orderBy(asc(workDayOverrides.day));
  const out: Record<string, WorkDay> = {};
  for (const r of rows) {
    const d = parseWorkDay(r.workDay);
    if (d) out[r.day] = d;
  }
  return out;
}

/** The day after a valid day key: a day's hours touch only [day, next day). */
const dayAfter = (day: string) => dayKey(addDays(parseDayKey(day)!, 1));

/** The user's other pages refetch their hours (versions and days). */
const changed = (userId: number) => publish(userId, { type: "schedule" });

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

  /**
   * Save the schedule in force from `validFrom` (replaces a version on that day).
   * `overrides: "drop"`: the days with hours of their own it covers (up to the
   * next version) follow it too; "keep" (default) leaves them as they are.
   */
  save: protectedProcedure
    .input(
      z.object({
        validFrom: dayKeyInput,
        schedule: workScheduleSchema,
        overrides: z.enum(["keep", "drop"]).default("keep"),
      }),
    )
    .mutation(({ ctx, input }) =>
      withWriteLease(ctx.user.id, async () => {
        const versions = await listScheduleVersions(ctx.user.id);
        const until = nextAfter(versions, input.validFrom);
        await assertRangeOpen(ctx.user.id, input.validFrom, until);
        const schedule = JSON.stringify(input.schedule);
        await getDb()
          .insert(workSchedules)
          .values({ userId: ctx.user.id, validFrom: input.validFrom, schedule })
          .onConflictDoUpdate({
            target: [workSchedules.userId, workSchedules.validFrom],
            set: { schedule, createdAt: new Date() },
          });
        if (input.overrides === "drop") {
          const conds = [eq(workDayOverrides.userId, ctx.user.id), gte(workDayOverrides.day, input.validFrom)];
          if (until) conds.push(lt(workDayOverrides.day, until));
          await getDb().delete(workDayOverrides).where(and(...conds));
        }
        changed(ctx.user.id);
        return listScheduleVersions(ctx.user.id);
      }),
    ),

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
      changed(ctx.user.id);
      return listScheduleVersions(ctx.user.id);
    }),

  /** Hours of single days, by day ("YYYY-MM-DD"). */
  days: protectedProcedure.query(({ ctx }) => listDayOverrides(ctx.user.id)),

  /**
   * Give `day` hours of its own (past or future; not in a closed week).
   * The same as the weekly hours of that day: it simply follows them again.
   */
  saveDay: protectedProcedure
    .input(z.object({ day: dayKeyInput, workDay: workDaySchema }))
    .mutation(({ ctx, input }) =>
      withWriteLease(ctx.user.id, async () => {
        const date = parseDayKey(input.day)!;
        await assertRangeOpen(ctx.user.id, input.day, dayAfter(input.day));
        const base = scheduleFor(date, await listScheduleVersions(ctx.user.id))[weekdayIndex(date)];
        const where = and(eq(workDayOverrides.userId, ctx.user.id), eq(workDayOverrides.day, input.day));
        if (base && sameWorkDay(base, input.workDay)) {
          await getDb().delete(workDayOverrides).where(where);
        } else {
          const workDay = JSON.stringify(input.workDay);
          await getDb()
            .insert(workDayOverrides)
            .values({ userId: ctx.user.id, day: input.day, workDay })
            .onConflictDoUpdate({
              target: [workDayOverrides.userId, workDayOverrides.day],
              set: { workDay, createdAt: new Date() },
            });
        }
        changed(ctx.user.id);
        return listDayOverrides(ctx.user.id);
      }),
    ),

  /** `day` follows the weekly hours again. */
  removeDay: protectedProcedure
    .input(z.object({ day: dayKeyInput }))
    .mutation(({ ctx, input }) =>
      withWriteLease(ctx.user.id, async () => {
        await assertRangeOpen(ctx.user.id, input.day, dayAfter(input.day));
        await getDb()
          .delete(workDayOverrides)
          .where(and(eq(workDayOverrides.userId, ctx.user.id), eq(workDayOverrides.day, input.day)));
        changed(ctx.user.id);
        return listDayOverrides(ctx.user.id);
      }),
    ),
});
