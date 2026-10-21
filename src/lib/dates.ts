import { numberFormat } from "@contracts/i18n";
import { formatDurationLong, parseDayKey, startOfDay } from "@contracts/time";

const DAY_MS = 86_400_000;

/** Days from today to a "YYYY-MM-DD" due date (negative = overdue). */
export function daysUntil(due: string, today: Date): number | null {
  const d = parseDayKey(due);
  return d
    ? Math.round((d.getTime() - startOfDay(today).getTime()) / DAY_MS)
    : null;
}

/** "12 h 30 min" → shorter "12,5 h" style for tight tiles. */
export function compactHours(seconds: number): string {
  return seconds >= 36_000
    ? `${numberFormat({ maximumFractionDigits: 1 }).format(seconds / 3600)} h`
    : formatDurationLong(seconds);
}
