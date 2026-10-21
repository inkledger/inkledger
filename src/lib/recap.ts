import { addDays, dayKey, startOfWeek } from "@contracts/time";
import { projectOf } from "@/lib/projectColors";
import { issueId } from "@/lib/issues";
import { workedByDay, workedSeconds } from "@/lib/worked";

export type RecapLog = {
  issueKey: string;
  connectionId?: number | null;
  started: Date | string;
  timeSpentSeconds: number;
};

export type WeekRecap = {
  total: number;
  prevTotal: number;
  /** Change vs the same days of last week, null when last week is empty. */
  deltaPct: number | null;
  daysAtGoal: number;
  /** Working days (Mon–Fri) elapsed this week, today included. */
  workdays: number;
  avgPerWorkedDay: number;
  topIssue: { key: string; connectionId?: number | null; seconds: number } | null;
  topProject: { key: string; seconds: number } | null;
  perDay: { day: Date; seconds: number }[];
};

function top(
  map: Map<string, number>
): { key: string; seconds: number } | null {
  let best: { key: string; seconds: number } | null = null;
  for (const [key, seconds] of map) {
    if (!best || seconds > best.seconds) best = { key, seconds };
  }
  return best;
}

/**
 * This week so far vs the same stretch of last week (Mon → today's weekday),
 * so mid-week numbers compare like with like.
 */
export function weekRecap(
  logs: RecapLog[],
  now: Date,
  /** Expected seconds of a day: 0 on days off */
  targetFor: (day: Date) => number
): WeekRecap {
  const weekStart = startOfWeek(now);
  const prevStart = addDays(weekStart, -7);
  // Monday = 1 … Sunday = 7
  const elapsedDays = ((now.getDay() + 6) % 7) + 1;
  const prevEnd = addDays(prevStart, elapsedDays);
  const weekEnd = addDays(weekStart, 7);

  const byIssue = new Map<string, { key: string; connectionId?: number | null; seconds: number }>();
  const byProject = new Map<string, number>();
  const week: RecapLog[] = [];
  const prev: RecapLog[] = [];

  for (const w of logs) {
    const at = new Date(w.started);
    if (at >= weekStart && at < weekEnd) {
      week.push(w);
      const id = issueId(w);
      const entry = byIssue.get(id) ?? { key: w.issueKey, connectionId: w.connectionId, seconds: 0 };
      entry.seconds += w.timeSpentSeconds;
      byIssue.set(id, entry);
      const p = projectOf(w.issueKey);
      byProject.set(p, (byProject.get(p) ?? 0) + w.timeSpentSeconds);
    } else if (at >= prevStart && at < prevEnd) {
      prev.push(w);
    }
  }
  // The hours worked, day by day: parallel work once (issues and projects keep their own).
  const perDay = workedByDay(week);
  const total = [...perDay.values()].reduce((a, s) => a + s, 0);
  const prevTotal = workedSeconds(prev);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const seconds = days.map(d => perDay.get(dayKey(d)) ?? 0);
  const worked = seconds.filter(s => s > 0).length;

  return {
    total,
    prevTotal,
    deltaPct:
      prevTotal > 0
        ? Math.round(((total - prevTotal) / prevTotal) * 100)
        : null,
    // Working days only, so it reads "n su 5" even when the weekend was worked.
    daysAtGoal: days.filter((d, i) => {
      const t = targetFor(d);
      return t > 0 && seconds[i] >= t;
    }).length,
    workdays: days
      .slice(0, elapsedDays)
      .filter(d => targetFor(d) > 0).length,
    avgPerWorkedDay: worked > 0 ? total / worked : 0,
    topIssue: [...byIssue.values()].reduce<WeekRecap["topIssue"]>(
      (best, e) => (!best || e.seconds > best.seconds ? e : best),
      null
    ),
    topProject: top(byProject),
    perDay: days.map((day, i) => ({ day, seconds: seconds[i] })),
  };
}
