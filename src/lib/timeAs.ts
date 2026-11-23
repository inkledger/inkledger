import { formatSeconds, roundToMinute, toLocalInputValue } from "@contracts/time";

/** How a new entry's time is given: a typed duration, or an end time after its start (one or the other, never kept in sync). */
export type TimeAs = "duration" | "end";

/** The block as it stands: its start ("" while being placed), whether placing is done, its length. */
export type Shown = { start: string; placed: boolean; seconds: number };

/** A start and an end, as datetime-local values. */
export type Pin = { start: string; end: string };

/**
 * Seconds as a typed duration, never below one minute (Jira's granularity):
 * hours and minutes only, so a day in the work schedule never changes it.
 */
export function durationInput(seconds: number): string {
  return formatSeconds(roundToMinute(seconds), { days: false });
}

/** Seconds from a start to an end (datetime-local values), zero or less when it comes first; null until both are there. */
export function secondsToEnd(start: string, end: string): number | null {
  if (!start || !end) return null;
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}

const endAfter = (start: string, seconds: number) => toLocalInputValue(new Date(new Date(start).getTime() + seconds * 1000));

/**
 * To an end time: the block as it stands keeps its start, its end is typed
 * from there; asked while the start is still being placed, it waits (`pending`,
 * with the length it had): an empty start pinned would never be placed again.
 * Back to a duration: what the end made of it (`duration`). Null: no change.
 */
export function switchTimeAs(
  from: TimeAs,
  next: TimeAs,
  shown: Shown,
  parsed: number | null
): { mode: TimeAs; pending: number | null; pin?: Pin; duration?: number } | null {
  if (next === from) return null;
  if (next === "end")
    return shown.start && shown.placed
      ? { mode: next, pending: null, pin: { start: shown.start, end: endAfter(shown.start, shown.seconds) } }
      : { mode: next, pending: shown.seconds };
  return { mode: next, pending: null, ...(parsed && parsed > 0 ? { duration: parsed } : {}) };
}

/** An end time asked for while the start was being placed: pinned once it is shown, with the length it had. */
export function settleTimeAs(pending: number | null, byEnd: boolean, shown: Shown): Pin | null {
  return pending !== null && byEnd && shown.placed && shown.start ? { start: shown.start, end: endAfter(shown.start, pending) } : null;
}
