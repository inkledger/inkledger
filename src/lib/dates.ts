import { dateFormat } from "@contracts/i18n";
import { parseDayKey, startOfDay } from "@contracts/time";

const DAY_MS = 86_400_000;

/** Days from today to a "YYYY-MM-DD" due date (negative = overdue). */
export function daysUntil(due: string, today: Date): number | null {
  const d = parseDayKey(due);
  return d
    ? Math.round((d.getTime() - startOfDay(today).getTime()) / DAY_MS)
    : null;
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

/** A date in the locale's medium style: "22 Oct 2026" / "22 ott 2026"; an invalid one says so, as toLocaleDateString did. */
export function mediumDate(at: Date | number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(d) : dateFormat({ dateStyle: "medium" }).format(d);
}
