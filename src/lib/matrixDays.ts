import { parseDayKey } from "@contracts/time";

/** Every day from the first to the last one with time, the empty ones included (a gap reads as a gap). */
export function matrixDays(days: readonly { day: string }[]): Date[] {
  const dates = days.map(d => parseDayKey(d.day)).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return [];
  const out: Date[] = [];
  for (const d = new Date(dates[0]); d <= dates[dates.length - 1]; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}
