import { readStored, writeStored } from "@/lib/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { idleGap } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useTimers } from "@/hooks/useTimers";
import { isNative, onNativeEvent, showNativeWindow } from "@/lib/native";

export type AwayPeriod = { issueKey: string; connectionId?: number; seconds: number; since: Date };

const HEARTBEAT_MS = 30_000;
/**
 * Away time already handled (epoch ms), shared by tabs and both detectors:
 * the same stretch is never asked about (and trimmed) twice.
 */
const COVERED_KEY = "ikl-away-covered";

type IdleState = {
  userState: "active" | "idle";
  screenState: "locked" | "unlocked";
};
type IdleDetectorLike = EventTarget &
  IdleState & {
    start(opts: { threshold: number; signal: AbortSignal }): Promise<void>;
  };
type IdleDetectorCtor = {
  new (): IdleDetectorLike;
  requestPermission(): Promise<"granted" | "denied">;
};

function idleDetectorCtor(): IdleDetectorCtor | null {
  const ctor = (globalThis as { IdleDetector?: IdleDetectorCtor }).IdleDetector;
  return ctor ?? null;
}

export const idleDetectionSupported = (): boolean =>
  idleDetectorCtor() !== null;

/** Ask (from a click) for system-wide idle detection; true when granted. */
export async function requestIdlePermission(): Promise<boolean> {
  const ctor = idleDetectorCtor();
  if (!ctor) return false;
  try {
    return (await ctor.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

function readCovered(): number {
  return Number(readStored(COVERED_KEY) ?? 0) || 0;
}

function writeCovered(ms: number) {
  // Storage unavailable: the in-memory value still protects this tab.
  writeStored(COVERED_KEY, String(ms));
}

/**
 * Detects time away from the computer while a timer runs, Toggl-style:
 * - sleep / lid closed: the heartbeat stops, the gap shows on wake;
 * - system idle or screen locked: the Idle Detection API (when granted).
 * Activity inside the tab is NOT used: working in another app is not away.
 */
export function useIdleDetection(): {
  away: AwayPeriod | null;
  dismiss: () => void;
} {
  const settings = trpc.settings.get.useQuery();
  const threshold = settings.data?.idleMinutes ?? 10;
  const { timers } = useTimers();
  // Away from this device says nothing of a timer another device runs.
  const running = timers.find(t => t.state === "running" && !t.heldElsewhere);
  const runningKey = running?.issueKey ?? null;
  const runningConnection = running?.connectionId;
  const [away, setAway] = useState<AwayPeriod | null>(null);
  const keyRef = useRef(runningKey);
  const connectionRef = useRef(runningConnection);
  useEffect(() => {
    keyRef.current = runningKey;
    connectionRef.current = runningConnection;
  }, [runningKey, runningConnection]);
  const covered = useRef(0);
  /**
   * A real away stretch noticed while this tab was in the background, kept as
   * is (since → until) to be asked about once the tab is visible again. Time
   * merely spent in another app is never a stretch.
   */
  const deferred = useRef<{ since: number; until: number } | null>(null);
  const [permission, setPermission] = useState(0);

  const report = useCallback(
    (sinceMs: number, untilMs: number) => {
      const key = keyRef.current;
      const from = Math.max(sinceMs, covered.current, readCovered());
      const seconds = idleGap(from, untilMs, threshold);
      if (!key || seconds === 0) return;
      // Only the visible tab asks; a hidden one keeps the stretch for later.
      if (document.visibilityState !== "visible") {
        const prev = deferred.current;
        deferred.current = prev
          ? {
              since: Math.min(prev.since, from),
              until: Math.max(prev.until, untilMs),
            }
          : { since: from, until: untilMs };
        return;
      }
      covered.current = untilMs;
      writeCovered(untilMs);
      // Covered from now on: a second stretch while the prompt is still open
      // joins it, or that time would stay on the timer, never asked about.
      setAway(prev =>
        !prev
          ? { issueKey: key, connectionId: connectionRef.current, seconds, since: new Date(from) }
          : prev.issueKey === key
            ? { ...prev, seconds: prev.seconds + seconds }
            : prev
      );
    },
    [threshold]
  );

  // Heartbeat: a long gap between beats means the machine was asleep. In the
  // native app the system reports sleep and idle itself (a hidden window's
  // timers are throttled, a gap there means nothing): only the deferred
  // stretch is asked about here, once the window is visible.
  useEffect(() => {
    if (threshold <= 0) return;
    const native = isNative();
    let last = Date.now();
    const beat = () => {
      const now = Date.now();
      const pending = deferred.current;
      if (pending !== null && document.visibilityState === "visible") {
        deferred.current = null;
        report(pending.since, pending.until);
      }
      if (!native) report(last, now);
      last = now;
    };
    const i = setInterval(beat, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", beat);
    };
  }, [threshold, report]);

  // Native app: idle, screen lock and sleep from the system, always on. A
  // stretch long enough brings the window forward to ask about it.
  useEffect(() => {
    if (!isNative() || threshold <= 0) return;
    return onNativeEvent<{ since: number; until: number }>("system-away", ({ since, until }) => {
      if (keyRef.current && idleGap(since, until, threshold) > 0) void showNativeWindow();
      report(since, until);
    });
  }, [threshold, report]);

  // System idle / screen lock, only if the user granted the permission.
  useEffect(() => {
    const ctor = idleDetectorCtor();
    if (!ctor || threshold <= 0) return;
    const abort = new AbortController();
    let idleSince: number | null = null;
    void (async () => {
      try {
        const status = await navigator.permissions.query({
          name: "idle-detection" as PermissionName,
        });
        // Granting the permission later (Settings) restarts this effect.
        status.onchange = () => setPermission(p => p + 1);
        if (status.state !== "granted") return;
        const detector = new ctor();
        detector.addEventListener("change", () => {
          const idle =
            detector.userState === "idle" || detector.screenState === "locked";
          if (idle && idleSince === null) idleSince = Date.now() - 60_000;
          if (!idle && idleSince !== null) {
            report(idleSince, Date.now());
            idleSince = null;
          }
        });
        await detector.start({ threshold: 60_000, signal: abort.signal });
      } catch {
        // unsupported or revoked: the heartbeat still covers sleep
      }
    })();
    return () => abort.abort();
  }, [threshold, report, permission]);

  return { away, dismiss: () => setAway(null) };
}
