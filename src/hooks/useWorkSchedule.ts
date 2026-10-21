import { useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import {
  defaultWorkSchedule,
  expectedSeconds,
  expectedSecondsBetween,
  scheduleFor,
  EPOCH_DAY,
  type ScheduleVersion,
  type WorkSchedule,
} from "@contracts/workSchedule";

const FALLBACK: ScheduleVersion[] = [
  { validFrom: EPOCH_DAY, schedule: defaultWorkSchedule() },
];

/**
 * The work schedule versions and the targets they imply. Every day is judged
 * with the version in force on that day (past weeks keep their hours).
 */
export function useWorkSchedule() {
  const query = trpc.workSchedule.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
  const versions = query.data ?? FALLBACK;

  const forDay = useCallback(
    (day: Date): WorkSchedule => scheduleFor(day, versions),
    [versions]
  );
  const targetFor = useCallback(
    (day: Date) => expectedSeconds(day, scheduleFor(day, versions)),
    [versions]
  );
  /** Expected seconds of `days` days from `from` (week, month…). */
  const targetBetween = useCallback(
    (from: Date, days: number) => expectedSecondsBetween(from, days, versions),
    [versions]
  );

  return useMemo(
    () => ({ versions, forDay, targetFor, targetBetween, isPending: query.isPending }),
    [versions, forDay, targetFor, targetBetween, query.isPending]
  );
}
