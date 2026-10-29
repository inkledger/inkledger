import { addDays, parseDayKey } from "./time";

export const PLANNED_KINDS = ["work", "travel", "vacation"] as const;
export type PlannedKind = (typeof PLANNED_KINDS)[number];

export type PlannedInterval = {
  kind: PlannedKind;
  startsAt: Date;
  endsAt: Date;
};

export type PlannedEntry = PlannedInterval & {
  id: string;
  userId: number;
  note: string | null;
  connectionId: number | null;
  itemId: number | null;
  issueKey: string | null;
  convertedWorklogId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Local calendar days to an exclusive instant range, including DST transitions. */
export function plannedDayRange(fromDay: string, throughDay = fromDay): { startsAt: Date; endsAt: Date } | null {
  const startsAt = parseDayKey(fromDay);
  const lastDay = parseDayKey(throughDay);
  if (!startsAt || !lastDay || startsAt > lastDay) return null;
  return { startsAt, endsAt: addDays(lastDay, 1) };
}

export function plannedSeconds(entry: Pick<PlannedInterval, "startsAt" | "endsAt">): number {
  return Math.max(0, Math.round((entry.endsAt.getTime() - entry.startsAt.getTime()) / 1000));
}
