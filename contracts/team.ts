// The team report's rules, shared by the server and the page: when someone
// is below target, how a cell's coverage is drawn, and how a range is cut
// into columns (days, weeks or months).
import { addDays, dayKey, isoWeek, startOfWeek } from "./time";

/** Below this share of the elapsed target, someone is "below target". */
export const BELOW = 0.9;

/** How a cell is drawn, from its hours and its target. */
export type CoverageStep = "full" | "high" | "mid" | "low" | "none" | "off" | "absent" | "future";

/**
 * A bucket's step: "future" when it hasn't started, "absent" when vacation
 * took all of its expected time, "off" when nothing was expected, "none"
 * when time was expected and nothing logged, else by share of the target.
 */
export function coverageStep(c: { loggedSeconds: number; targetSeconds: number; absentSeconds: number; future: boolean }): CoverageStep {
  if (c.future) return "future";
  if (c.targetSeconds <= 0) return c.absentSeconds > 0 && c.loggedSeconds === 0 ? "absent" : "off";
  if (c.loggedSeconds <= 0) return "none";
  const share = c.loggedSeconds / c.targetSeconds;
  return share >= 1 ? "full" : share >= 0.75 ? "high" : share >= 0.5 ? "mid" : "low";
}

/** Coverage change in points (+6 = six points better), or null when either side has no target. */
export function coverageDelta(now: number | null, before: number | null): number | null {
  return now === null || before === null ? null : Math.round((now - before) * 100);
}

export type Granularity = "day" | "week" | "month";

/** Columns that fit a range: days up to six weeks, weeks up to about six months, then months. */
export function autoGranularity(days: number): Granularity {
  return days <= 42 ? "day" : days <= 183 ? "week" : "month";
}

/** A column: its days (local day keys, inside the range) and what names it. */
export type Bucket = {
  key: string;
  from: Date;
  /** Last day included */
  to: Date;
  days: string[];
  kind: Granularity;
  /** ISO week number (weeks), month index 0–11 (months), day of month (days) */
  n: number;
};

/** The range [from, to] (inclusive local days) cut into columns; weeks and months are cut at its edges. */
export function bucketsOf(from: Date, to: Date, kind: Granularity): Bucket[] {
  const out: Bucket[] = [];
  let d = from;
  while (d <= to) {
    const start = d;
    const days: string[] = [];
    const sameBucket = (x: Date) =>
      kind === "day"
        ? dayKey(x) === dayKey(start)
        : kind === "week"
          ? dayKey(startOfWeek(x)) === dayKey(startOfWeek(start))
          : x.getFullYear() === start.getFullYear() && x.getMonth() === start.getMonth();
    while (d <= to && sameBucket(d)) {
      days.push(dayKey(d));
      d = addDays(d, 1);
    }
    out.push({
      key: days[0],
      from: start,
      to: addDays(d, -1),
      days,
      kind,
      n: kind === "day" ? start.getDate() : kind === "week" ? isoWeek(start) : start.getMonth(),
    });
  }
  return out;
}
