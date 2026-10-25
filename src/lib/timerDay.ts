import { dayKey } from "@contracts/time";

/**
 * Whether a timer's tracked time belongs to `day`: the day it stopped, or today while it runs.
 * A timer left paused since an earlier day is that day's time, never today's.
 */
export function timerOnDay(t: { state: string; pausedAt: string | Date | null }, day: Date, now: Date): boolean {
  const end = t.state === "running" || !t.pausedAt ? now : new Date(t.pausedAt);
  return dayKey(end) === dayKey(day);
}
