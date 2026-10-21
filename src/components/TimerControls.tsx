import { useState } from "react";
import { Link } from "react-router";
import { Pause, Play, Square, X } from "lucide-react";
import { useElapsed, useTimers } from "@/hooks/useTimers";
import { useTimerActions } from "@/hooks/useTimerActions";
import { TimerNote } from "@/components/TimerNote";
import { formatHMS } from "@contracts/time";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";

/** Live ticking elapsed time, "h:mm:ss". */
export function TickingElapsed({
  state,
  elapsedSeconds,
  fetchedAt,
  className,
}: {
  state: string;
  elapsedSeconds: number;
  fetchedAt: number;
  className?: string;
}) {
  const shown = useElapsed(state, elapsedSeconds, fetchedAt);
  return <span className={cn("tabular", className)}>{formatHMS(shown)}</span>;
}

/** Play / pause / stop / discard for one issue's timer. */
export function TimerControls({
  issueKey,
  connectionId,
}: {
  issueKey: string;
  connectionId?: number | null;
}) {
  const provider = useProviderName();
  const { timer, fetchedAt, running, paused, pending, ...act } =
    useTimerActions(issueKey, connectionId);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  return (
    <div
      className="flex items-center gap-0.5"
      onClick={e => e.stopPropagation()}
    >
      {timer && (
        <span className="mr-1.5 flex items-center gap-1.5 text-caption font-medium">
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              running ? "animate-pulse-dot bg-chart-focus" : "bg-warning"
            )}
          />
          <span className="sr-only">
            {running ? t("ui.timer.active") : t("ui.timer.paused")}
          </span>
          <TickingElapsed
            state={timer.state}
            elapsedSeconds={timer.elapsedSeconds}
            fetchedAt={fetchedAt}
            className={running ? "text-foreground" : "text-warning"}
          />
        </span>
      )}
      {!running ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            paused
              ? t("ui.timer.resumeFor", { key: issueKey })
              : t("ui.timer.startFor", { key: issueKey })
          }
          title={paused ? t("ui.timer.resume") : t("ui.timer.start")}
          disabled={pending}
          onClick={act.start}
        >
          <Play className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("ui.timer.pauseFor", { key: issueKey })}
          title={t("ui.timer.pause")}
          disabled={pending}
          onClick={act.pause}
        >
          <Pause className="h-4 w-4" />
        </Button>
      )}
      {timer && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("ui.timer.stopAndLogFor", { key: issueKey })}
            title={t("ui.timer.stopAndLog")}
            disabled={pending}
            onClick={act.stop}
          >
            <Square className="h-4 w-4" />
          </Button>
          {paused && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("ui.timer.discardFor", { key: issueKey })}
              title={t("ui.timer.discardTip")}
              disabled={pending}
              onClick={() => setConfirmingDiscard(true)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </>
      )}
      <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.timer.discardTitle", { key: issueKey })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ui.timer.discardBody", { provider })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={act.discard}>
              {t("ui.timer.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Compact link to the tracked issue (running first, else most recent paused). */
export function ActiveTimerChip({ className }: { className?: string }) {
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(t => t.state === "running") ?? timers[0];
  if (!timer) return null;
  const running = timer.state === "running";
  return (
    <Link
      to={issuePath({ key: timer.issueKey, connectionId: timer.connectionId })}
      data-lit="1"
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-body-sm font-medium transition-colors hover:bg-accent",
        className
      )}
    >
      <TimerRing running={running} />
      <span className="sr-only">
        {running ? t("ui.timer.activeOn") : t("ui.timer.pausedOn")}
      </span>
      <span className="truncate text-muted-foreground">{timer.issueKey}</span>
      <TickingElapsed
        state={timer.state}
        elapsedSeconds={timer.elapsedSeconds}
        fetchedAt={fetchedAt}
      />
    </Link>
  );
}

/** Note of the timer shown in the chip (running first, else latest paused). */
export function ActiveTimerNote({ className }: { className?: string }) {
  const { timers } = useTimers();
  const timer = timers.find(t => t.state === "running") ?? timers[0];
  if (!timer) return null;
  return (
    <TimerNote
      key={issueId(timer)}
      issueKey={timer.issueKey}
      connectionId={timer.connectionId}
      note={timer.note}
      className={className}
    />
  );
}

/** Small ring: spinning apricot arc while running, static when paused. */
export function TimerRing({
  running,
  className,
}: {
  running: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn("h-4 w-4 shrink-0", className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="hsl(var(--border))"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke={running ? "hsl(var(--chart-focus))" : "hsl(var(--warning))"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="12 26"
        className={
          running
            ? "origin-center motion-safe:animate-spin [animation-duration:2s]"
            : undefined
        }
      />
    </svg>
  );
}

/** Collapsed-sidebar version: ring + short elapsed time, links to the tracked issue. */
export function ActiveTimerRailButton() {
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(t => t.state === "running") ?? timers[0];
  const elapsed = useElapsed(
    timer?.state ?? "paused",
    timer?.elapsedSeconds ?? 0,
    fetchedAt
  );
  if (!timer) return null;
  const running = timer.state === "running";
  const hms = formatHMS(elapsed);
  const label = t(running ? "ui.timer.activeOnLabel" : "ui.timer.pausedOnLabel", {
    key: timer.issueKey,
    time: hms,
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={issuePath({ key: timer.issueKey, connectionId: timer.connectionId })}
          aria-label={label}
          data-lit="1"
          className="mx-auto flex w-12 flex-col items-center gap-1 rounded-md border bg-background py-1.5 transition-colors hover:bg-accent"
        >
          <TimerRing running={running} />
          <span className="text-2xs font-medium text-muted-foreground tabular">
            {hms.slice(0, -3)}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
