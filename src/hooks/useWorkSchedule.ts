import { useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { dayKey } from "@contracts/time";
import {
  defaultWorkSchedule,
  expectedSeconds,
  expectedSecondsBetween,
  scheduleFor,
  weekdayIndex,
  EPOCH_DAY,
  type DayOverrides,
  type ScheduleVersion,
  type WorkDay,
  type WorkSchedule,
} from "@contracts/workSchedule";

const FALLBACK: ScheduleVersion[] = [
  { validFrom: EPOCH_DAY, schedule: defaultWorkSchedule() },
];
const NO_DAYS: DayOverrides = {};

/**
 * The work schedule versions, the hours of single days, and the targets they
 * imply. Every day is judged with the version in force on that day (past
 * weeks keep their hours), its own hours replacing its weekday's.
 * `isPending` until both are read: nothing may be computed on guesses.
 */
export function useWorkSchedule() {
  const query = trpc.workSchedule.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const days = trpc.workSchedule.days.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const versions = query.data ?? FALLBACK;
  const overrides = days.data ?? NO_DAYS;

  const forDay = useCallback(
    (day: Date): WorkSchedule => scheduleFor(day, versions, overrides),
    [versions, overrides]
  );
  /** The weekly hours of `day` alone (what "back to the week" restores). */
  const baseForDay = useCallback(
    (day: Date): WorkDay => scheduleFor(day, versions)[weekdayIndex(day)],
    [versions]
  );
  const isOverridden = useCallback((day: Date) => dayKey(day) in overrides, [overrides]);
  const targetFor = useCallback(
    (day: Date) => expectedSeconds(day, scheduleFor(day, versions, overrides)),
    [versions, overrides]
  );
  /** Expected seconds of `days` days from `from` (week, month…). */
  const targetBetween = useCallback(
    (from: Date, n: number) => expectedSecondsBetween(from, n, versions, overrides),
    [versions, overrides]
  );
  const isPending = query.isPending || days.isPending;

  return useMemo(
    () => ({ versions, overrides, forDay, baseForDay, isOverridden, targetFor, targetBetween, isPending }),
    [versions, overrides, forDay, baseForDay, isOverridden, targetFor, targetBetween, isPending]
  );
}
