import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useTimers } from "@/hooks/useTimers";
import { useStartTimer } from "@/hooks/useStartTimer";
import { quickStart } from "@/lib/quickStart";
import { timerLog } from "@/lib/timerLog";
import { issueId } from "@/lib/issues";
import {
  isNative,
  onNativeEvent,
  setProfileInfo,
  setTrayTimer,
  type NativeCommand,
  type TrayTimer,
} from "@/lib/native";
import { useAuth } from "@/hooks/useAuth";
import { useTrackerSites } from "@/hooks/useConnections";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * The native app's menu bar and global shortcuts, wired to the same timer
 * logic as the page: the running timer (else the last paused one) is shown
 * in the menu bar; its commands come back here and run the app's mutations,
 * so stopping still opens the log dialog with the right placement.
 */
export function useNativeBridge() {
  const native = isNative();
  const utils = trpc.useUtils();
  const timerState = useTimers();
  const { timers } = timerState;
  const issues = trpc.issues.all.useQuery(undefined, {
    staleTime: 60_000,
    enabled: native,
  });

  const current =
    timers.find(t => t.state === "running") ??
    [...timers]
      .filter(t => t.state === "paused")
      .sort((a, b) => (b.pausedAt?.getTime() ?? 0) - (a.pausedAt?.getTime() ?? 0))[0];

  const summary = current
    ? // By identity: the same key may be on two trackers.
      (issues.data?.find(i => issueId(i) === issueId(current))?.summary ?? null)
    : null;
  const trayKey = current
    ? `${current.issueKey}|${current.state}|${current.elapsedSeconds}|${current.state === "running" ? timerState.fetchedAt : 0}|${summary}`
    : "none";

  useEffect(() => {
    if (!native) return;
    const tray: TrayTimer | null = current
      ? {
          issueKey: current.issueKey,
          summary,
          // As of now, not of the last fetch: the menu bar ticks from here.
          elapsedSeconds:
            current.elapsedSeconds +
            (current.state === "running" ? Math.max(0, Date.now() - timerState.fetchedAt) / 1000 : 0),
          running: current.state === "running",
        }
      : null;
    void setTrayTimer(tray);
    // Only when what the menu bar shows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, trayKey]);

  // Who is signed in on this server: the profiles list shows it.
  const { user } = useAuth();
  const site = useTrackerSites()[0]?.host;
  useEffect(() => {
    if (native && user) void setProfileInfo(user.displayName, site ?? user.username ?? "");
  }, [native, user, site]);

  const start = useStartTimer({ announce: true });
  const invalidate = () => utils.timers.list.invalidate();
  const pause = trpc.timers.pause.useMutation({
    onSuccess: (_r, { issueKey }) => {
      void invalidate();
      toast.success(t("ui.nativeBridge.paused", { key: issueKey }));
    },
    onError: e => toast.error(e.message),
  });
  const stop = trpc.timers.stop.useMutation({
    onSuccess: (r, { issueKey, connectionId }) => {
      void invalidate();
      if (r.found)
        timerLog.push({ issueKey, connectionId, seconds: r.seconds, note: r.note, end: r.stoppedAt ?? undefined });
    },
    onError: e => toast.error(e.message),
  });

  // The handler sees the latest timer without re-subscribing.
  const latest = useRef({ current, start, pause, stop });
  useEffect(() => {
    latest.current = { current, start, pause, stop };
  });

  useEffect(() => {
    if (!native) return;
    return onNativeEvent<NativeCommand>("native-command", cmd => {
      const { current, start, pause, stop } = latest.current;
      if (cmd === "quick-start") quickStart.set(true);
      else if (!current) {
        if (cmd === "toggle") quickStart.set(true);
      } else if (cmd === "toggle") {
        const on = { issueKey: current.issueKey, connectionId: current.connectionId };
        if (current.state === "running") pause.mutate(on);
        else start.mutate(on);
      } else if (cmd === "stop") stop.mutate({ issueKey: current.issueKey, connectionId: current.connectionId });
    });
  }, [native]);
}
