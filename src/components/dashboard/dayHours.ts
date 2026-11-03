import { clockOf, keepTargetEnd, LAST_MINUTE, minutesOf, workDaySeconds, type WorkDay } from "@contracts/workSchedule";

/**
 * Editing the hours of one day, in minutes of the day ("HH:MM" in, "HH:MM"
 * out, so a DST day keeps its wall clock). Every move is clamped so the draft
 * is always valid: breaks inside the hours, in order, never overlapping, at
 * least MIN_BREAK long.
 */

/** Arrow keys and drags move by this much; Shift by BIG_STEP, Alt by one minute. */
export const STEP = 5;
export const BIG_STEP = 15;
export const MIN_BREAK = 5;
/** A new break: this long, at lunch time when free. */
const NEW_BREAK = 30;
const LUNCH = 13 * 60;
const MAX_BREAKS = 4;

/** What is being moved: the day's bounds, a break's edges, or a whole break. */
export type Handle =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "breakStart"; i: number }
  | { kind: "breakEnd"; i: number }
  | { kind: "break"; i: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const snapTo = (minutes: number, step: number) => Math.round(minutes / step) * step;

/** Where a handle stands now (the start of a whole break). */
export function handleAt(d: WorkDay, h: Handle): number {
  switch (h.kind) {
    case "start":
      return minutesOf(d.start);
    case "end":
      return minutesOf(d.end);
    case "breakStart":
    case "break":
      return minutesOf(d.breaks[h.i].start);
    case "breakEnd":
      return minutesOf(d.breaks[h.i].end);
  }
}

/** `d` with handle `h` moved to `to` (minutes of the day), as far as it can go. */
export function moveHandle(d: WorkDay, h: Handle, to: number): WorkDay {
  const start = minutesOf(d.start);
  const end = minutesOf(d.end);
  const breaks = d.breaks.map((b) => ({ start: minutesOf(b.start), end: minutesOf(b.end) }));
  const before = (i: number) => (i > 0 ? breaks[i - 1].end : start);
  const after = (i: number) => (i < breaks.length - 1 ? breaks[i + 1].start : end);
  const out = { start, end, breaks };
  switch (h.kind) {
    case "start":
      out.start = clamp(to, 0, breaks[0]?.start ?? end - MIN_BREAK);
      break;
    case "end":
      out.end = clamp(to, (breaks.at(-1)?.end ?? start + MIN_BREAK), LAST_MINUTE);
      break;
    case "breakStart":
      breaks[h.i] = { ...breaks[h.i], start: clamp(to, before(h.i), breaks[h.i].end - MIN_BREAK) };
      break;
    case "breakEnd":
      breaks[h.i] = { ...breaks[h.i], end: clamp(to, breaks[h.i].start + MIN_BREAK, after(h.i)) };
      break;
    case "break": {
      const length = breaks[h.i].end - breaks[h.i].start;
      const s = clamp(to, before(h.i), after(h.i) - length);
      breaks[h.i] = { start: s, end: s + length };
      break;
    }
  }
  return {
    ...d,
    start: clockOf(out.start),
    end: clockOf(out.end),
    breaks: out.breaks.map((b) => ({ start: clockOf(b.start), end: clockOf(b.end) })),
  };
}

/** A new break of half an hour: at 13:00 when free, else in the first free stretch; null when none fits. */
export function addBreak(d: WorkDay): WorkDay | null {
  if (!d.enabled || d.breaks.length >= MAX_BREAKS) return null;
  const start = minutesOf(d.start);
  const end = minutesOf(d.end);
  const breaks = d.breaks.map((b) => ({ start: minutesOf(b.start), end: minutesOf(b.end) }));
  const free: [number, number][] = [];
  let cursor = start;
  for (const b of breaks) {
    if (b.start > cursor) free.push([cursor, b.start]);
    cursor = b.end;
  }
  if (end > cursor) free.push([cursor, end]);
  // Never at the very edge of the day: a break there is a shorter day.
  const fits = ([a, b]: [number, number], s: number) => s > start && s >= a && s + NEW_BREAK <= b && s + NEW_BREAK < end;
  // At lunch when free; else at the start of a free stretch (an hour into the day for the first).
  const candidates = [LUNCH, ...free.map(([a]) => (a === start ? a + 60 : a))];
  const at = candidates.find((s) => free.some((f) => fits(f, s)));
  if (at === undefined) return null;
  const next = [...breaks, { start: at, end: at + NEW_BREAK }].sort((x, y) => x.start - y.start);
  return { ...d, breaks: next.map((b) => ({ start: clockOf(b.start), end: clockOf(b.end) })) };
}

export const removeBreak = (d: WorkDay, i: number): WorkDay => ({ ...d, breaks: d.breaks.filter((_, j) => j !== i) });

/**
 * The day's own break that already holds the time away from `from` to `to`
 * (minutes, rounded out to 5 as breakAt does): there is nothing to move, the
 * time only leaves the timer. Null when the day is off or no break holds it.
 */
export function breakHolding(d: WorkDay, from: number, to: number): WorkDay["breaks"][number] | null {
  if (!d.enabled) return null;
  const a = Math.floor(from / STEP) * STEP;
  const b = Math.ceil(to / STEP) * STEP;
  return d.breaks.find((x) => minutesOf(x.start) <= a && b <= minutesOf(x.end)) ?? null;
}

/**
 * "That was my break": the day's hours with the break taken from `from` to
 * `to` (minutes, rounded out to 5): it replaces the break it overlaps, or the
 * closest one, or is added (at most 4); breaks it covers merge into it.
 * Null when the day is off or the span is not within its hours.
 */
export function breakAt(d: WorkDay, from: number, to: number): WorkDay | null {
  if (!d.enabled) return null;
  const start = minutesOf(d.start);
  const end = minutesOf(d.end);
  const a = Math.floor(from / STEP) * STEP;
  const b = Math.ceil(to / STEP) * STEP;
  // Reaching the day's start or end is arriving late or leaving early: work on both sides only.
  if (a <= start || b >= end || b - a < MIN_BREAK) return null;
  const breaks = d.breaks.map((x) => ({ start: minutesOf(x.start), end: minutesOf(x.end) }));
  const overlaps = (x: { start: number; end: number }) => x.start < b && x.end > a;
  let rest = breaks.filter((x) => !overlaps(x));
  if (rest.length === breaks.length && rest.length > 0) {
    // None overlapped: the closest one moves (a day keeps its number of breaks).
    const mid = (a + b) / 2;
    const closest = rest.reduce((c, x) => (Math.abs((x.start + x.end) / 2 - mid) < Math.abs((c.start + c.end) / 2 - mid) ? x : c));
    rest = rest.filter((x) => x !== closest);
  }
  const next = [...rest, { start: a, end: b }].sort((x, y) => x.start - y.start);
  if (next.length > MAX_BREAKS) return null;
  return { ...d, breaks: next.map((x) => ({ start: clockOf(x.start), end: clockOf(x.end) })) };
}

/**
 * Saving `draft` over the day's `current` hours: asked only when the day's
 * work changes from what it holds now (moving a break never asks), with the
 * week's target (`base`) as the one to keep.
 */
export function saveChoice(current: WorkDay, base: WorkDay, draft: WorkDay) {
  return workDaySeconds(draft) !== workDaySeconds(current) ? targetChoice(base, draft) : null;
}

/**
 * Saving `draft` against the weekly hours `base`: when it holds a different
 * amount of work, the two ways to read it (keep the target by moving the end,
 * or keep the hours and change the target); null when the target is the same.
 */
export function targetChoice(base: WorkDay, draft: WorkDay): { keep: WorkDay | null; baseSeconds: number; draftSeconds: number } | null {
  if (!draft.enabled) return null;
  const baseSeconds = workDaySeconds(base);
  const draftSeconds = workDaySeconds(draft);
  if (baseSeconds === draftSeconds) return null;
  return { keep: keepTargetEnd(base, draft), baseSeconds, draftSeconds };
}
