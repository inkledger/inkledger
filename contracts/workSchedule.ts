import { z } from "zod";
import { addDays, dayKey, findGaps, type TimeSpan } from "./time";
import { t } from "./i18n";

/**
 * Work schedule: per weekday hours with breaks. Breaks are time when no
 * worklog is expected (lunch…); a disabled day expects nothing (weekend).
 * Versioned by `validFrom`: every day is judged with the schedule in force
 * on that day, so changing it never rewrites past weeks.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, { error: () => t("server.workSchedule.invalidTime") });

/** "13:30" → 810 */
export function minutesOf(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

const breakSchema = z.object({ start: hhmm, end: hhmm });

export const workDaySchema = z
  .object({
    enabled: z.boolean(),
    start: hhmm,
    end: hhmm,
    breaks: z.array(breakSchema).max(4),
  })
  .superRefine((d, ctx) => {
    if (!d.enabled) return;
    const start = minutesOf(d.start);
    const end = minutesOf(d.end);
    if (start >= end) {
      ctx.addIssue({ code: "custom", message: t("server.workSchedule.endAfterStart"), path: ["end"] });
      return;
    }
    let cursor = start;
    d.breaks.forEach((b, i) => {
      const bs = minutesOf(b.start);
      const be = minutesOf(b.end);
      if (bs >= be) {
        ctx.addIssue({ code: "custom", message: t("server.workSchedule.invalidBreak"), path: ["breaks", i] });
      } else if (bs < cursor || be > end) {
        ctx.addIssue({
          code: "custom",
          message: t("server.workSchedule.breaksOrder"),
          path: ["breaks", i],
        });
      }
      cursor = Math.max(cursor, be);
    });
  });

/** Monday first, like `startOfWeek`. */
export const workScheduleSchema = z.array(workDaySchema).length(7);

export type WorkDay = z.infer<typeof workDaySchema>;
export type WorkSchedule = WorkDay[];
export type ScheduleVersion = { validFrom: string; schedule: WorkSchedule };

export const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"] as const;

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

/** A stored schedule, or the defaults when missing/invalid. */
export function normalizeWorkSchedule(raw: unknown): WorkSchedule {
  const parsed = workScheduleSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultWorkSchedule();
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
