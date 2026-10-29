import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MoveRight, Pause, PictureInPicture2, Play, Repeat, Square, X } from "lucide-react";
import { addDays, formatDurationLong, formatHMS, startOfDay } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useToday } from "@/hooks/useToday";
import { focusMode } from "@/lib/flag";
import { quickStart } from "@/lib/quickStart";
import { coverClass } from "@/lib/cover";
import { useElapsed, useTimers } from "@/hooks/useTimers";
import { useTimerActions } from "@/hooks/useTimerActions";
import { TimerNote } from "@/components/TimerNote";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { surface, surfaceFace } from "@/components/app/surface";
import { issueId } from "@/lib/issues";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { t } from "@/i18n";
import { workedSeconds } from "@/lib/worked";

type PipApi = {
  requestWindow(opts: { width: number; height: number }): Promise<Window>;
};
const pipApi = (): PipApi | null =>
  (globalThis as { documentPictureInPicture?: PipApi })
    .documentPictureInPicture ?? null;

/** The timer worth focusing on: the running one, else the latest paused. */
function useFocusTimer() {
  const { timers } = useTimers();
  return timers.find(t => t.state === "running") ?? timers[0] ?? null;
}

/**
 * Full-screen focus view (key "f"): the issue cover, a big ticking clock and
 * a ring towards today's goal (logged solid, unlogged hatched).
 */
export function FocusMode() {
  const open = focusMode.useValue();
  const [pip, setPip] = useState<Window | null>(null);

  // The PiP window follows theme changes and closes with the app (logout).
  useEffect(() => {
    if (!pip) return;
    const sync = () => {
      pip.document.documentElement.className =
        document.documentElement.className;
      pip.document.documentElement.style.cssText =
        document.documentElement.style.cssText;
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => {
      observer.disconnect();
      pip.close();
    };
  }, [pip]);

  const openPip = async () => {
    const api = pipApi();
    if (!api || pip) return;
    try {
      const win = await api.requestWindow({ width: 340, height: 132 });
      copyStyles(document, win.document);
      win.addEventListener("pagehide", () => setPip(null));
      setPip(win);
      focusMode.set(false);
    } catch {
      toast.error(t("ui.focus.noPip"));
    }
  };

  // A real (Radix) dialog: focus trap, Esc that respects dialogs opened on
  // top, and global shortcuts paused while it is open.
  return (
    <>
      <Dialog open={open} onOpenChange={focusMode.set}>
        {/* surface: none — full screen, not a floating box */}
        <DialogContent
          showCloseButton={false}
          cast={false}
          aria-describedby={undefined}
          className="left-0 top-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-canvas p-0 shadow-none sm:max-w-none data-[state=open]:zoom-in-100"
        >
          <DialogTitle className="sr-only">{t("ui.focus.title")}</DialogTitle>
          {open && <FocusOverlay onPip={pipApi() ? openPip : undefined} />}
        </DialogContent>
      </Dialog>
      {pip &&
        createPortal(
          <MiniPlayer onClose={() => pip.close()} />,
          pip.document.body
        )}
    </>
  );
}

function FocusOverlay({ onPip }: { onPip?: () => void }) {
  const timer = useFocusTimer();
  const issues = trpc.issues.all.useQuery(undefined, { staleTime: 60_000 });
  // By identity: the same key may be on two trackers.
  const summary = timer && issues.data?.find(i => issueId(i) === issueId(timer))?.summary;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between p-4">
        <span className="text-overline uppercase text-muted-foreground">
          {t("ui.focus.title")}
        </span>
        <div className="flex items-center gap-1">
          {onPip && timer && (
            <Button variant="ghost" size="sm" onClick={onPip}>
              <PictureInPicture2 className="h-4 w-4" />
              {t("ui.focus.miniPlayer")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("ui.focus.closeLabel")}
            onClick={() => focusMode.set(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-y-auto px-4 pb-10">
        {timer ? (
          <div className="w-full max-w-xl rounded-2xl shadow-sm" {...surface("card", { elevation: 2, role: "wrap" })}>
            <div className="overflow-hidden rounded-2xl border bg-card" {...surfaceFace()}>
            <div className={cn("grain h-28", coverClass(timer.issueKey))} />
            <div className="-mt-10 grid justify-items-center gap-5 px-6 pb-8 text-center">
              <GoalRing timerId={issueId(timer)} />
              <div className="min-w-0">
                <p className="font-medium text-primary-strong">
                  {timer.issueKey}
                </p>
                <p className="mt-1 line-clamp-2 [overflow-wrap:anywhere] text-body text-muted-foreground">
                  {summary ?? "—"}
                </p>
              </div>
              <TimerNote
                key={issueId(timer)}
                issueKey={timer.issueKey}
                connectionId={timer.connectionId}
                note={timer.note}
                className="w-full max-w-sm"
                inputClassName="border py-2 text-center text-body-sm"
              />
              <FocusActions issueKey={timer.issueKey} connectionId={timer.connectionId} />
            </div>
            </div>
          </div>
        ) : (
          <div className="grid justify-items-center gap-3 text-center">
            <p className="font-display text-title">{t("ui.focus.noTimer")}</p>
            <p className="text-muted-foreground">
              {t("ui.focus.noTimerHint")}
            </p>
            <Button
              onClick={() => {
                focusMode.set(false);
                quickStart.set(true);
              }}
            >
              <Play className="h-4 w-4" /> {t("ui.focus.startTimer")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function FocusActions({
  issueKey,
  connectionId,
  compact = false,
}: {
  issueKey: string;
  connectionId?: number;
  compact?: boolean;
}) {
  const { running, pending, start, pause, stop, move } = useTimerActions(issueKey, connectionId);
  const size = compact ? "sm" : "default";
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {running ? (
        <Button
          variant="outline"
          size={size}
          disabled={pending}
          onClick={pause}
        >
          <Pause className="h-4 w-4" /> {t("ui.focus.pause")}
        </Button>
      ) : (
        <Button size={size} disabled={pending} onClick={start}>
          <Play className="h-4 w-4" /> {t("ui.focus.resume")}
        </Button>
      )}
      <Button
        variant={running ? "default" : "outline"}
        size={size}
        disabled={pending}
        onClick={() => {
          focusMode.set(false);
          stop();
        }}
      >
        <Square className="h-4 w-4" /> {compact ? t("ui.focus.stop") : t("ui.focus.stopAndLog")}
      </Button>
      {!compact && (
        <Button
          variant="ghost"
          onClick={() => {
            focusMode.set(false);
            quickStart.set(true);
          }}
        >
          <Repeat className="h-4 w-4" /> {t("ui.focus.switchIssue")}
        </Button>
      )}
      {!compact && (
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            focusMode.set(false);
            move();
          }}
        >
          <MoveRight className="h-4 w-4" /> {t("ui.timer.moveTo")}
        </Button>
      )}
    </div>
  );
}

/** Big clock inside a ring towards today's goal. */
function GoalRing({ timerId }: { timerId: string }) {
  const patternId = useId();
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(t => issueId(t) === timerId);
  const elapsed = useElapsed(
    timer?.state ?? "paused",
    timer?.elapsedSeconds ?? 0,
    fetchedAt
  );
  // Today = logged + this timer only: paused timers left from other days
  // would inflate it.
  const pending = { pending: elapsed, running: timer?.state === "running" };
  // Today's bounds follow midnight: focus mode may stay open across it.
  const today = startOfDay(useToday());
  const from = today.toISOString();
  const logs = trpc.worklogs.list.useQuery({ from, to: addDays(today, 1).toISOString() });
  const { targetFor } = useWorkSchedule();
  const target = targetFor(today);
  const logged = useMemo(
    // The hours worked today: parallel work once.
    () => workedSeconds(logs.data ?? []),
    [logs.data]
  );

  const R = 92;
  const C = 2 * Math.PI * R;
  const scale = Math.max(target, logged + pending.pending, 1);
  const l = logged / scale;
  const p = pending.pending / scale;

  return (
    <div className="relative h-56 w-56 rounded-full bg-card p-2 shadow-sm" {...surface("card")}>
      <svg
        viewBox="0 0 200 200"
        className="h-full w-full -rotate-90"
        aria-hidden
      >
        <defs>
          <pattern
            id={patternId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="3" height="6" className="fill-chart-focus" />
            <rect x="3" width="3" height="6" className="fill-chart-focus/40" />
          </pattern>
        </defs>
        <circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          strokeWidth="10"
          className="stroke-muted"
        />
        <circle
          cx="100"
          cy="100"
          r={R}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          className="stroke-primary transition-[stroke-dasharray] duration-700"
          strokeDasharray={`${C * l} ${C}`}
        />
        {p > 0 && (
          <circle
            cx="100"
            cy="100"
            r={R}
            fill="none"
            strokeWidth="10"
            stroke={`url(#${patternId})`}
            className="transition-[stroke-dasharray] duration-1000 ease-linear"
            strokeDasharray={`${C * p} ${C}`}
            strokeDashoffset={-C * l}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <span className="font-display text-display tabular">
          {formatHMS(elapsed)}
        </span>
        <span className="mt-1 text-caption text-muted-foreground">
          {t("ui.focus.todayOf", {
            logged: formatDurationLong(logged + pending.pending),
            target: formatDurationLong(target),
          })}
        </span>
      </div>
    </div>
  );
}

/** Always-on-top window (Document Picture-in-Picture). */
function MiniPlayer({ onClose }: { onClose: () => void }) {
  const timer = useFocusTimer();
  const { fetchedAt } = useTimers();
  const elapsed = useElapsed(
    timer?.state ?? "paused",
    timer?.elapsedSeconds ?? 0,
    fetchedAt
  );
  if (!timer) {
    return (
      <div className="flex h-screen items-center justify-between gap-3 bg-card p-4 text-foreground">
        <span className="text-body-sm text-muted-foreground">
          {t("ui.focus.noTimer")}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("ui.focus.close")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-screen flex-col justify-center gap-2 bg-card px-4 text-foreground">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-title tabular">
          {formatHMS(elapsed)}
        </span>
        <span className="truncate text-caption font-medium text-primary-strong">
          {timer.issueKey}
        </span>
      </div>
      <FocusActions issueKey={timer.issueKey} connectionId={timer.connectionId} compact />
    </div>
  );
}

/** The PiP window starts empty: bring over styles, theme class and tokens. */
function copyStyles(from: Document, to: Document) {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map(r => r.cssText)
        .join("\n");
      to.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = to.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        to.head.appendChild(link);
      }
    }
  }
  to.documentElement.className = from.documentElement.className;
  to.documentElement.style.cssText = from.documentElement.style.cssText;
  to.title = "inkledger";
}
