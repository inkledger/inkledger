import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { liveEvents } from "@/lib/liveEvents";
import { useTimers } from "@/hooks/useTimers";
import { TIMER_HEARTBEAT_MS } from "@contracts/timerLock";

/**
 * Keeps this tab in step with the user's other pages and devices: refetches
 * what /api/events names, and, while this device controls the running timer,
 * renews its lease (also in a background tab, and at once on waking or
 * reconnecting). A lost lease or a take-over shows on the next fetch.
 */
export function useLiveSync() {
  const utils = trpc.useUtils();
  useEffect(
    () =>
      liveEvents.open(type => {
        // "hello" too: a reconnect may have missed changes.
        if (type === "timers" || type === "hello") void utils.timers.list.invalidate();
      }),
    [utils]
  );

  const { timers } = useTimers();
  const owned = timers.some(t => t.state === "running" && t.ownedHere);
  const heartbeat = trpc.timers.heartbeat.useMutation({
    onSuccess: r => {
      if (!r.owned) void utils.timers.list.invalidate();
    },
  });
  const beat = heartbeat.mutate;
  useEffect(() => {
    if (!owned) return;
    beat();
    const i = setInterval(() => beat(), TIMER_HEARTBEAT_MS);
    const now = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", now);
    window.addEventListener("online", now);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", now);
      window.removeEventListener("online", now);
    };
  }, [owned, beat]);
}
