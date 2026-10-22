import { useEffect, useRef } from "react";
import { useNow } from "@/hooks/useTimers";
import { trpc } from "@/lib/trpc";
import { formatDuration } from "@contracts/time";
import { showBrowserNotification } from "@/lib/browserNotifications";
import { t } from "@/i18n";

/** Browser notification text for a timer running past the threshold. */
export function timerAlertText(
  issueKey: string,
  elapsedSeconds: number,
  thresholdMinutes: number,
): { title: string; body: string } {
  return {
    title: t("ui.alert.title", { duration: formatDuration(elapsedSeconds) }),
    body: t("ui.alert.body", { key: issueKey, minutes: thresholdMinutes }),
  };
}

/**
 * Watches running timers and fires a browser notification when one exceeds
 * the configured threshold (anti "forgotten timer"). Checks every minute,
 * also in a hidden tab: elapsed time is extrapolated locally from the last
 * fetch, so a throttled or paused refetch can't hold the alert back.
 */
export function useTimerAlerts() {
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  // The same query as everywhere (events refresh it); polled in the background too, slowly.
  const timers = trpc.timers.list.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
  const alertedFor = useRef<Set<string>>(new Set());
  const now = useNow(true, 30_000);
  const fetchedAt = timers.dataUpdatedAt;

  useEffect(() => {
    const s = settings.data;
    if (!s || s.notifyEnabled !== 1 || s.timerAlertMinutes <= 0) return;
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;

    const threshold = s.timerAlertMinutes * 60;
    const list = timers.data ?? [];
    // Forget timers that were stopped/discarded so they can alert again later.
    for (const key of alertedFor.current) {
      if (!list.some(t => t.issueKey === key)) alertedFor.current.delete(key);
    }
    for (const t of list) {
      if (t.state !== "running") {
        alertedFor.current.delete(t.issueKey);
        continue;
      }
      // Its own device alerts for it: one notice, not one per device.
      if (t.heldElsewhere) continue;
      const elapsed = t.elapsedSeconds + Math.max(0, now - fetchedAt) / 1000;
      if (elapsed >= threshold && !alertedFor.current.has(t.issueKey)) {
        alertedFor.current.add(t.issueKey);
        const { title, body } = timerAlertText(t.issueKey, elapsed, s.timerAlertMinutes);
        void showBrowserNotification(title, { body, tag: `timer-${t.issueKey}` });
      }
    }
  }, [timers.data, settings.data, now, fetchedAt]);
}
