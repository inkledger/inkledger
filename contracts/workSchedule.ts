import { addDays, dayKey, findGaps, type TimeSpan } from "./time";
import type { WorkDay } from "./workScheduleSchema";

/**
 * Work schedule: per weekday hours with breaks. Breaks are time when no
 * worklog is expected (lunch…); a disabled day expects nothing (weekend).
 * Versioned by `validFrom`: every day is judged with the schedule in force
 * on that day, so changing it never rewrites past weeks.
 */

/** "13:30" → 810 */
export function minutesOf(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export type { WorkDay } from "./workScheduleSchema";
export type WorkSchedule = WorkDay[];
export type ScheduleVersion = { validFrom: string; schedule: WorkSchedule };

/** First version's date: covers every past day. */
export const EPOCH_DAY = "1970-01-01";

const OFF: WorkDay = { enabled: false, start: "09:00", end: "18:00", breaks: [] };

/** Mon–Fri from 9:00 for `dailySeconds` of work, lunch 13–14; weekend off. */
export function defaultWorkSchedule(dailySeconds = 8 * 3600): WorkSchedule {
  const workMin = Math.round(dailySeconds / 60);
  // Lunch only when the day reaches past it; 9:00 + work + 1h lunch.
  const withLunch = 9 * 60 + workMin > 13 * 60;
  const endMin = Math.min(23 * 60 + 55, 9 * 60 + workMin + (withLunch ? 60 : 0));
  const end = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
  const day: WorkDay = {
    enabled: true,
    start: "09:00",
    end,
    breaks: withLunch ? [{ start: "13:00", end: "14:00" }] : [],
  };
  return [day, day, day, day, day, OFF, OFF].map((d) => ({ ...d, breaks: [...d.breaks] }));
}

/** Monday = 0 … Sunday = 6 */
export function weekdayIndex(day: Date): number {
  return (day.getDay() + 6) % 7;
}

/** Version in force on `day`: the latest `validFrom` not after it. */
export function scheduleFor(day: Date, versions: ScheduleVersion[]): WorkSchedule {
  const key = dayKey(day);
  let best: ScheduleVersion | undefined;
  for (const v of versions) {
    if (v.validFrom <= key && (!best || v.validFrom > best.validFrom)) best = v;
  }
  return best?.schedule ?? defaultWorkSchedule();
}

function at(day: Date, t: string): Date {
  const m = minutesOf(t);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);
}

const span = (a: Date, b: Date): TimeSpan => ({
  start: a,
  seconds: Math.round((b.getTime() - a.getTime()) / 1000),
});

/** Bounds of the working day (first start, last end), or null when off. */
export function workBounds(day: Date, schedule: WorkSchedule): { start: Date; end: Date } | null {
  const d = schedule[weekdayIndex(day)];
  return d?.enabled ? { start: at(day, d.start), end: at(day, d.end) } : null;
}

/** Breaks of the day as spans (empty when off). */
export function breakSpans(day: Date, schedule: WorkSchedule): TimeSpan[] {
  const d = schedule[weekdayIndex(day)];
  if (!d?.enabled) return [];
  return d.breaks.map((b) => span(at(day, b.start), at(day, b.end)));
}

/** Working time of the day: hours minus breaks. */
export function workSpans(day: Date, schedule: WorkSchedule): TimeSpan[] {
  const d = schedule[weekdayIndex(day)];
  if (!d?.enabled) return [];
  const out: TimeSpan[] = [];
  let cursor = at(day, d.start);
  for (const b of d.breaks) {
    const bs = at(day, b.start);
    if (bs > cursor) out.push(span(cursor, bs));
    cursor = at(day, b.end);
  }
  const end = at(day, d.end);
  if (end > cursor) out.push(span(cursor, end));
  return out;
}

/** Seconds of work expected on `day` (its target). */
export function expectedSeconds(day: Date, schedule: WorkSchedule): number {
  return workSpans(day, schedule).reduce((a, s) => a + s.seconds, 0);
}

/** Expected seconds of `days` days from `from`, each with its own version. */
export function expectedSecondsBetween(from: Date, days: number, versions: ScheduleVersion[]): number {
  let total = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    total += expectedSeconds(d, scheduleFor(d, versions));
  }
  return total;
}

/** Working spans left after planned vacation; work and travel never change the target. */
export function effectiveWorkSpans(
  day: Date,
  schedule: WorkSchedule,
  planned: import("./planned").PlannedInterval[] = [],
): TimeSpan[] {
  const vacations = planned.filter((p) => p.kind === "vacation" && p.endsAt > p.startsAt);
  return workSpans(day, schedule).flatMap((work) => {
    const workStart = work.start.getTime();
    const workEnd = workStart + work.seconds * 1000;
    const covered = vacations
      .map((v) => ({
        start: Math.max(workStart, v.startsAt.getTime()),
        end: Math.min(workEnd, v.endsAt.getTime()),
      }))
      .filter((v) => v.end > v.start)
      .sort((a, b) => a.start - b.start);
    const out: TimeSpan[] = [];
    let cursor = workStart;
    for (const absence of covered) {
      if (absence.start > cursor) out.push(span(new Date(cursor), new Date(absence.start)));
      cursor = Math.max(cursor, absence.end);
    }
    if (cursor < workEnd) out.push(span(new Date(cursor), new Date(workEnd)));
    return out;
  });
}

/** Seconds expected after planned vacation, never negative. */
export function effectiveTargetSeconds(
  day: Date,
  schedule: WorkSchedule,
  planned: import("./planned").PlannedInterval[] = [],
): number {
  return Math.max(0, effectiveWorkSpans(day, schedule, planned).reduce((total, s) => total + s.seconds, 0));
}

/** Effective target over local days, each judged with its own schedule version. */
export function effectiveTargetSecondsBetween(
  from: Date,
  days: number,
  versions: ScheduleVersion[],
  planned: import("./planned").PlannedInterval[] = [],
): number {
  let total = 0;
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    total += effectiveTargetSeconds(day, scheduleFor(day, versions), planned);
  }
  return total;
}

/**
 * Working time not covered by `logged` (worklogs and live timers), up to
 * `now` on today: every hole of at least a minute (Jira's minimum).
 */
export function missingSpans(
  day: Date,
  schedule: WorkSchedule,
  logged: TimeSpan[],
  now: Date,
): TimeSpan[] {
  const out: TimeSpan[] = [];
  for (const w of workSpans(day, schedule)) {
    const end = new Date(Math.min(w.start.getTime() + w.seconds * 1000, now.getTime()));
    if (end <= w.start) continue;
    out.push(...findGaps(logged, w.start, end, 1));
  }
  return out;
}

/**
 * The hole still open: the one reaching now (missingSpans ends them at now),
 * at least a minute long, else null. A timer can start from its start.
 */
export function openGap(missing: TimeSpan[], now: Date): TimeSpan | null {
  const last = missing.at(-1);
  if (!last || last.seconds < 60) return null;
  return Math.abs(last.start.getTime() + last.seconds * 1000 - now.getTime()) <= 1000 ? last : null;
}

/** Start of the first hole of the day long enough for `seconds`, else null. */
export function firstFreeStart(
  day: Date,
  schedule: WorkSchedule,
  logged: TimeSpan[],
  seconds: number,
  now: Date,
): Date | null {
  return missingSpans(day, schedule, logged, now).find((g) => g.seconds >= seconds)?.start ?? null;
}
