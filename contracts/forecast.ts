// When I'll finish (docs/work/ideas/estimates.md L2, R-3.17–R-3.20): the pure parts around the
// forecast sidecar. What goes in (days aligned by dayKey), how its answer is made usable, how a
// finish date is walked, and the weekly series the trend is drawn from.
import { addDays, dayKey, parseDayKey, weekStartKey } from "./time";

/** Input or answer that doesn't line up: refused, never guessed (E-3.3, the sidecar's 422). */
export class ForecastShapeError extends Error {}

const HOURS_IN_DAY = 24;
const SECONDS_IN_HOUR = 3600;

const nextDay = (key: string) => {
  const d = parseDayKey(key);
  if (!d) throw new ForecastShapeError(`not a day: ${key}`);
  return dayKey(addDays(d, 1));
};

/** Whether `keys` are consecutive days starting at `first` (when given). */
function consecutive(keys: readonly string[], first?: string): boolean {
  if (keys.length === 0) return false;
  if (first !== undefined && keys[0] !== first) return false;
  if (!parseDayKey(keys[0])) return false;
  for (let i = 1; i < keys.length; i++) if (keys[i] !== nextDay(keys[i - 1])) return false;
  return true;
}

export type CapacityHistory = { days: readonly string[]; hours: readonly number[]; workday: readonly number[]; off: readonly number[] };
export type CapacityFuture = { days: readonly string[]; workday: readonly number[]; off: readonly number[] };
export type CapacityInput = {
  series: number[];
  past_covariates: { workday: number[]; off: number[] };
  future_covariates: { workday: number[]; off: number[] };
};

/**
 * The sidecar's input (R-3.17): my hours per day (capped at a day), and the
 * workday/off flags over the same days and over the horizon that follows them.
 */
export function capacityInput(history: CapacityHistory, future: CapacityFuture): CapacityInput {
  const n = history.days.length;
  if ([history.hours, history.workday, history.off].some(a => a.length !== n)) throw new ForecastShapeError("history arrays differ in length");
  const h = future.days.length;
  if ([future.workday, future.off].some(a => a.length !== h)) throw new ForecastShapeError("future arrays differ in length");
  if (!consecutive(history.days)) throw new ForecastShapeError("history days are not consecutive");
  if (!consecutive(future.days, nextDay(history.days[n - 1]))) throw new ForecastShapeError("the horizon doesn't start the day after the history");
  const flag = (v: number) => (v ? 1 : 0);
  return {
    series: history.hours.map(v => Math.min(HOURS_IN_DAY, Math.max(0, Number.isFinite(v) ? v : 0))),
    past_covariates: { workday: history.workday.map(flag), off: history.off.map(flag) },
    future_covariates: { workday: future.workday.map(flag), off: future.off.map(flag) },
  };
}

export type RawDay = { day: string; p10: number; p50: number; p90: number };
export type ForecastDay = RawDay & { off: boolean };

/**
 * The model's answer made usable (R-3.18): finite (else E-3.3), never negative,
 * ordered p10 ≤ p50 ≤ p90, and 0 on a day off whatever the model said.
 */
export function cleanQuantiles(raw: readonly RawDay[], off: readonly boolean[]): ForecastDay[] {
  if (raw.length !== off.length) throw new ForecastShapeError("one off flag per day");
  return raw.map((d, i) => {
    const qs = [d.p10, d.p50, d.p90];
    if (!qs.every(Number.isFinite)) throw new ForecastShapeError(`not a number on ${d.day}`);
    if (off[i]) return { day: d.day, p10: 0, p50: 0, p90: 0, off: true };
    const [p10, p50, p90] = qs.map(v => Math.max(0, v)).sort((a, b) => a - b);
    return { day: d.day, p10, p50, p90, off: false };
  });
}

export type Finish = {
  /** The day the likely work is done at the likely pace; null beyond the horizon */
  p50: string | null;
  /** The cautious bound: pessimistic work at a pessimistic pace (P10); not an 80th percentile */
  p80: string | null;
  p50Beyond: boolean;
  p80Beyond: boolean;
  /** Hours still left at the horizon's end (0 when the date falls within it) */
  remainingHoursP50: number;
  remainingHoursP80: number;
};

/** The first day the capacity, added up, reaches the work (R-3.19), or how much is left at the end. */
function walk(capacity: readonly ForecastDay[], work: number, pace: (d: ForecastDay) => number): { day: string | null; left: number } {
  if (work <= 0) return { day: capacity[0]?.day ?? null, left: 0 };
  let done = 0;
  for (const d of capacity) {
    done += pace(d);
    if (done >= work - 1e-9) return { day: d.day, left: 0 };
  }
  return { day: null, left: work - done };
}

/** When the work is done: around (P50 work over P50 capacity), at the latest (P80 work over P10 capacity). */
export function finishDate(capacity: readonly ForecastDay[], workP50: number, workP80: number): Finish {
  const likely = walk(capacity, workP50, d => d.p50);
  const bound = walk(capacity, workP80, d => d.p10);
  return {
    p50: likely.day,
    p80: bound.day,
    p50Beyond: likely.day === null,
    p80Beyond: bound.day === null,
    remainingHoursP50: likely.left,
    remainingHoursP80: bound.left,
  };
}

export type WeekPoint = { week: string; value: number; imputed: boolean };
export type Weekly = { weeks: WeekPoint[] };
export type Insufficient = { insufficient: true; have: number; need: 8 };

const MIN_WEEKS_WITH_DATA = 8;
const MIN_SPAN_WEEKS = 12;

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Weeks from the first to the last with data; the empty ones between drawn on a straight line (R-3.20). */
function weekly(byWeek: Map<string, number[]>): Weekly | Insufficient {
  const have = byWeek.size;
  const keys = [...byWeek.keys()].sort();
  if (have === 0) return { insufficient: true, have: 0, need: 8 };
  const all: string[] = [keys[0]];
  while (all[all.length - 1] < keys[keys.length - 1]) all.push(dayKey(addDays(parseDayKey(all[all.length - 1])!, 7)));
  if (have < MIN_WEEKS_WITH_DATA || all.length < MIN_SPAN_WEEKS) return { insufficient: true, have, need: 8 };
  const known = all.map(w => (byWeek.has(w) ? median(byWeek.get(w)!) : null));
  const weeks = all.map((week, i): WeekPoint => {
    const v = known[i];
    if (v !== null) return { week, value: v, imputed: false };
    let a = i - 1;
    while (known[a] === null) a--;
    let b = i + 1;
    while (known[b] === null) b++;
    const value = known[a]! + ((known[b]! - known[a]!) * (i - a)) / (b - a);
    return { week, value, imputed: true };
  });
  return { weeks };
}

export type TrendSample = { lastCountedWorklogAt: number; workSeconds: number; trackerEstimate: number | null };

/**
 * The two weekly series of my closed issues (R-3.20): A, the median work time
 * in hours; B, the median of work over the tracker's estimate. Each sample goes
 * in the week (Monday, local) of its last counted worklog.
 */
export function weeklySeries(samples: readonly TrendSample[], now: number): { work: Weekly | Insufficient; ratio: Weekly | Insufficient } {
  const work = new Map<string, number[]>();
  const ratio = new Map<string, number[]>();
  for (const s of samples) {
    if (s.lastCountedWorklogAt > now || s.workSeconds <= 0) continue;
    const week = weekStartKey(new Date(s.lastCountedWorklogAt));
    work.set(week, [...(work.get(week) ?? []), s.workSeconds / SECONDS_IN_HOUR]);
    if (s.trackerEstimate && s.trackerEstimate > 0) ratio.set(week, [...(ratio.get(week) ?? []), s.workSeconds / s.trackerEstimate]);
  }
  return { work: weekly(work), ratio: weekly(ratio) };
}

/** Where a series is going (R-3.20): lower is better, within ±5% is steady. */
export function direction(lastObserved: number, p50AtHorizon: number): "better" | "worse" | "flat" {
  if (lastObserved <= 0) return p50AtHorizon > 0 ? "worse" : "flat";
  const change = (p50AtHorizon - lastObserved) / lastObserved;
  return change < -0.05 ? "better" : change > 0.05 ? "worse" : "flat";
}
