/**
 * Shared clocks: one interval per period however many components read it, and all of them
 * told in the same tick, so a second that changes ten clocks on screen is one commit. A
 * clock runs only while someone reads it.
 */
type Clock = { now: number; listeners: Set<() => void>; timer?: ReturnType<typeof setInterval> };

const clocks = new Map<number, Clock>();

function clockOf(periodMs: number): Clock {
  let c = clocks.get(periodMs);
  if (!c) {
    c = { now: Date.now(), listeners: new Set() };
    clocks.set(periodMs, c);
  }
  return c;
}

/** The time of the clock's last tick (or of its start). */
export function clockNow(periodMs: number): number {
  return clockOf(periodMs).now;
}

/** Listen to the clock of `periodMs`; it starts with its first listener (reading the time afresh) and stops with its last. */
export function subscribeClock(periodMs: number, listener: () => void): () => void {
  const c = clockOf(periodMs);
  c.listeners.add(listener);
  if (c.timer === undefined) {
    c.now = Date.now();
    c.timer = setInterval(() => {
      c.now = Date.now();
      for (const l of [...c.listeners]) l();
    }, periodMs);
  }
  return () => {
    c.listeners.delete(listener);
    if (c.listeners.size === 0 && c.timer !== undefined) {
      clearInterval(c.timer);
      c.timer = undefined;
    }
  };
}
