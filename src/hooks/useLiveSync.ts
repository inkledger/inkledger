import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { liveEvents } from "@/lib/liveEvents";
import { useTimers } from "@/hooks/useTimers";
import { TIMER_HEARTBEAT_MS } from "@contracts/timerLock";
import { deviceId } from "@/lib/device";
import { isNoteDirty, publishServerNote } from "@/components/notes/noteSync";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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
      liveEvents.open((type, data) => {
        // "hello" too: a reconnect may have missed changes.
        // The TODO worked on follows its timer.
        if (type === "timers" || type === "hello") void Promise.all([utils.timers.list.invalidate(), utils.todos.working.invalidate()]);
        // Another tab of this device switched the bucket: everything here follows, as there.
        if (type === "bucket" && isRecord(data) && data.deviceId === deviceId()) void utils.invalidate();
        if (type === "notes" || type === "hello") {
          void utils.notes.tree.invalidate();
          void utils.notes.trash.invalidate();
          void utils.notes.search.invalidate();
        }
        if (type === "notes" && isRecord(data) && typeof data.id === "string") {
          const id = data.id;
          if (isNoteDirty(id)) {
            void utils.client.notes.get.query({ id }).then(publishServerNote).catch(() => undefined);
          } else {
            void utils.notes.get.invalidate({ id });
          }
        }
        if (type === "hello") void utils.notes.get.invalidate();
      }),
    [utils]
  );

  useEffect(() => {
    const refresh = () => {
      void utils.notes.tree.invalidate();
      void utils.notes.trash.invalidate();
      void utils.notes.search.invalidate();
      void utils.notes.get.invalidate();
    };
    const focus = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [utils]);

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
