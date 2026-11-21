import { useEffect, useRef } from "react";
import { useNow } from "@/hooks/useTimers";
import { trpc } from "@/lib/trpc";
import { formatDuration } from "@contracts/time";
import { showBrowserNotification } from "@/lib/browserNotifications";
import { t } from "@/i18n";
import { issueId } from "@/lib/issues";

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

type AlertedTimer = { issueKey: string; connectionId: number; state: string; heldElsewhere?: boolean; elapsedSeconds: number };

/**
 * The running timers past the threshold that haven't alerted yet, marked in `alerted` as they are returned.
 * Tracked per issue identity: two trackers' APP-1 are two timers, one paused and one running included.
 */
export function dueTimerAlerts<T extends AlertedTimer>(list: readonly T[], alerted: Set<string>, sinceFetchSeconds: number, thresholdSeconds: number): { timer: T; id: string; elapsed: number }[] {
  // Forget timers that were stopped/discarded so they can alert again later.
  for (const id of alerted) {
    if (!list.some(t => issueId(t) === id)) alerted.delete(id);
  }
  const due: { timer: T; id: string; elapsed: number }[] = [];
  for (const timer of list) {
    const id = issueId(timer);
    if (timer.state !== "running") {
      alerted.delete(id);
      continue;
    }
    // Its own device alerts for it: one notice, not one per device.
    if (timer.heldElsewhere) continue;
    const elapsed = timer.elapsedSeconds + sinceFetchSeconds;
    if (elapsed >= thresholdSeconds && !alerted.has(id)) {
      alerted.add(id);
      due.push({ timer, id, elapsed });
    }
  }
  return due;
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
  // Read only while a timer runs: a reader of the fetch time re-renders on every poll.
  const fetchedAt = timers.data?.some(t => t.state === "running") ? timers.dataUpdatedAt : 0;

  useEffect(() => {
    const s = settings.data;
    if (!s || s.notifyEnabled !== 1 || s.timerAlertMinutes <= 0) return;
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;

    const due = dueTimerAlerts(timers.data ?? [], alertedFor.current, Math.max(0, now - fetchedAt) / 1000, s.timerAlertMinutes * 60);
    for (const { timer, id, elapsed } of due) {
      const { title, body } = timerAlertText(timer.issueKey, elapsed, s.timerAlertMinutes);
      void showBrowserNotification(title, { body, tag: `timer-${id}` });
    }
  }, [timers.data, settings.data, now, fetchedAt]);
}
