import { useCallback, useSyncExternalStore } from "react";
import { timerOnDay } from "@/lib/timerDay";
import { trpc } from "@/lib/trpc";
import { useLiveState } from "@/lib/liveEvents";
import { clockNow, subscribeClock } from "@/lib/clock";
import { useSSRClock } from "@/ssrClock";

/** Current time, refreshed every `periodMs` while `active`, from one clock shared by every reader. */
export function useNow(active: boolean, periodMs = 1000): number {
  const initial = useSSRClock();
  const subscribe = useCallback(
    (listener: () => void) => (active ? subscribeClock(periodMs, listener) : () => {}),
    [active, periodMs]
  );
  const now = () => initial ?? clockNow(periodMs);
  return useSyncExternalStore(subscribe, now, now);
}

/**
 * Timers of the user; `fetchedAt` anchors the live ticking. Events bring
 * changes at once (useLiveSync); the poll is the fallback, quicker while the
 * event stream is down.
 *
 * `fetchedAt` is read on demand: React Query re-renders a reader for the
 * fields it has read, and every poll moves the fetch time even when nothing
 * changed. Read it only where a timer runs (destructuring reads it).
 */
export function useTimers() {
  const live = useLiveState();
  const q = trpc.timers.list.useQuery(undefined, { refetchInterval: live === "live" ? 15_000 : 5_000, refetchOnWindowFocus: true });
  return {
    timers: q.data ?? [],
    get fetchedAt() {
      return q.dataUpdatedAt;
    },
    query: q,
  };
}

/** Live elapsed seconds of a timer entry. */
export function useElapsed(
  state: string,
  elapsedSeconds: number,
  fetchedAt: number
): number {
  const running = state === "running";
  const now = useNow(running);
  return running
    ? elapsedSeconds + Math.max(0, now - fetchedAt) / 1000
    : elapsedSeconds;
}

/** Tracked time not yet logged, and whether a timer runs. */
export type PendingTime = { pending: number; running: boolean };

/**
 * Today's tracked time not yet logged (running timers, and those stopped today), ticking
 * live while a timer runs. Feeds the hatched "pending" segments of the bars;
 * read by the parts that draw it, so only they tick. Undefined unless `shown`.
 */
export function usePendingSeconds(shown: boolean): PendingTime | undefined {
  const { timers, fetchedAt } = useTimers();
  const running = timers.some(t => t.state === "running");
  const now = useNow(shown && running);
  // Today's only: a timer stopped on an earlier day is that day's time.
  const today = new Date(now);
  const pending = timers
    .filter(t => timerOnDay(t, today, today))
    .reduce(
      (sum, t) =>
        sum +
        t.elapsedSeconds +
        (t.state === "running" ? Math.max(0, now - fetchedAt) / 1000 : 0),
      0
    );
  return shown ? { pending, running } : undefined;
}
