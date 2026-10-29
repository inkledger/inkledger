import { addDays, startOfDay } from "@contracts/time";
import type { PlannedEntry, PlannedKind } from "@contracts/planned";
import { t } from "@/i18n";

/** "Work", "Travel", "Vacation", in the app's language. */
export function plannedKindLabel(kind: PlannedKind): string {
  return t(`ui.planned.${kind}`);
}

export type PlannedSlice = {
  entry: PlannedEntry;
  startsAt: Date;
  endsAt: Date;
  seconds: number;
};

export function plannedSlicesForDay(entries: PlannedEntry[], day: Date): PlannedSlice[] {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  return entries.flatMap(entry => {
    const startsAt = new Date(Math.max(from, entry.startsAt.getTime()));
    const endsAt = new Date(Math.min(to, entry.endsAt.getTime()));
    const seconds = Math.max(0, Math.round((endsAt.getTime() - startsAt.getTime()) / 1000));
    return seconds > 0 ? [{ entry, startsAt, endsAt, seconds }] : [];
  });
}
