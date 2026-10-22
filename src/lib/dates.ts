import { dateFormat, numberFormat } from "@contracts/i18n";
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

// Civil times, in the user's language (en-GB, it-IT): a moment on the clock, never a duration.

/** The time of day: "09:30". */
export function timeOfDay(at: Date | number): string {
  return dateFormat({ hour: "2-digit", minute: "2-digit" }).format(at);
}

/** A moment with its day: "Thu 22 Oct, 09:30" / "gio 22 ott, 09:30". */
export function dayAndTime(at: Date | number): string {
  return dateFormat({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
}

/** A date in the locale's medium style: "22 Oct 2026" / "22 ott 2026". An invalid date throws (RangeError), as Intl does. */
export function mediumDate(at: Date | number): string {
  return dateFormat({ dateStyle: "medium" }).format(at);
}
