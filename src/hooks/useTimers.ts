import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useLiveState } from "@/lib/liveEvents";

/** Current time, refreshed every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

/**
 * Timers of the user; `fetchedAt` anchors the live ticking. Events bring
 * changes at once (useLiveSync); the poll is the fallback, quicker while the
 * event stream is down.
 */
export function useTimers() {
  const live = useLiveState();
  const q = trpc.timers.list.useQuery(undefined, { refetchInterval: live === "live" ? 15_000 : 5_000, refetchOnWindowFocus: true });
  return { timers: q.data ?? [], fetchedAt: q.dataUpdatedAt, query: q };
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

/**
 * Tracked time not yet logged to Jira (running + paused timers), ticking
 * live while a timer runs. Feeds the hatched "pending" segments of the bars.
 */
export function usePendingSeconds(): { pending: number; running: boolean } {
  const { timers, fetchedAt } = useTimers();
  const running = timers.some(t => t.state === "running");
  const now = useNow(running);
  const pending = timers.reduce(
    (sum, t) =>
      sum +
      t.elapsedSeconds +
      (t.state === "running" ? Math.max(0, now - fetchedAt) / 1000 : 0),
    0
  );
  return { pending, running };
}
