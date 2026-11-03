/**
 * Timers run side by side: the ones running, newest first, and the one a
 * single-timer place shows (the header, the title, focus mode, the tray): the
 * one started last, else the one stopped last.
 */
type TimerLike = { state: string; runningSince: Date | null; pausedAt: Date | null };

const time = (d: Date | null) => (d ? new Date(d).getTime() : 0);

export function runningTimers<T extends TimerLike>(timers: readonly T[]): T[] {
  return timers.filter(t => t.state === "running").sort((a, b) => time(b.runningSince) - time(a.runningSince));
}

export function focusTimer<T extends TimerLike>(timers: readonly T[]): T | undefined {
  return runningTimers(timers)[0] ?? [...timers].sort((a, b) => time(b.pausedAt) - time(a.pausedAt))[0];
}
