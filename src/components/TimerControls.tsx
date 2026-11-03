import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeftRight, MoveRight, Pause, Play, Square, X } from "lucide-react";
import { useElapsed, useTimers } from "@/hooks/useTimers";
import { useTimerActions } from "@/hooks/useTimerActions";
import { useTodoWorking } from "@/hooks/useTodoWork";
import { TimerNote } from "@/components/TimerNote";
import { formatHMS } from "@contracts/time";
import { timeOfDay } from "@/lib/dates";
import { useLiveState } from "@/lib/liveEvents";
import { TIMER_LEASE_MS } from "@contracts/timerLock";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";
import { surface } from "@/components/app/surface";
import { useFlowControlProps } from "@/lib/workspace/instrumentation";
import { focusTimer, runningTimers } from "@/lib/timerFocus";
import { quickStart } from "@/lib/quickStart";

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
  const { timer, fetchedAt, running, paused, pending, heldElsewhere, ...act } =
    useTimerActions(issueKey, connectionId);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [confirmingTakeOver, setConfirmingTakeOver] = useState(false);
  const owner = timer?.ownerLabel || t("ui.timer.anotherDevice");

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
      {heldElsewhere ? (
        // Another device controls it: here it can only be taken over, on purpose.
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("ui.timer.takeOverFor", { key: issueKey })}
              disabled={pending}
              onClick={() => setConfirmingTakeOver(true)}
            >
              <ArrowLeftRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("ui.timer.elsewhere", { device: owner, time: timer?.runningSince ? timeOfDay(timer.runningSince) : "" })}
          </TooltipContent>
        </Tooltip>
      ) : !running ? (
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
      {timer && !heldElsewhere && (
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("ui.timer.moveToFor", { key: issueKey })}
            title={t("ui.timer.moveTo")}
            disabled={pending}
            onClick={act.move}
          >
            <MoveRight className="h-4 w-4" />
          </Button>
          {/* Running or paused: a timer started by mistake goes without stopping it first. */}
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
        </>
      )}
      <AlertDialog open={confirmingTakeOver} onOpenChange={setConfirmingTakeOver}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.timer.takeOverTitle", { key: issueKey })}</AlertDialogTitle>
            <AlertDialogDescription>{t("ui.timer.takeOverBody", { device: owner })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={act.takeOver}>{t("ui.timer.takeOver")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Mounted only while asked: these controls redraw with the timer, the closed dialog would too. */}
      {confirmingDiscard && (
        <DiscardTimerDialog
          issueKey={issueKey}
          connectionId={connectionId}
          open
          onOpenChange={setConfirmingDiscard}
          onConfirm={() => act.discard()}
        />
      )}
    </div>
  );
}

/** "Discard the timer on KEY?": what is lost, said before it goes. */
export function DiscardTimerDialog({
  issueKey,
  connectionId,
  open,
  onOpenChange,
  onConfirm,
}: {
  issueKey: string;
  connectionId?: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const provider = useProviderName(connectionId ?? undefined);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("ui.timer.discardTitle", { key: issueKey })}</AlertDialogTitle>
          <AlertDialogDescription>{t("ui.timer.discardBody", { provider })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction destructive onClick={onConfirm}>
            {t("ui.timer.discard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Where a running timer is controlled from, said plainly: another device
 * (since when, what taking over does), or a device gone silent (free to
 * take), and whether this page is in sync. Nothing when it runs here.
 */
export function TimerWhere({ issueKey, connectionId, className }: { issueKey: string; connectionId?: number | null; className?: string }) {
  const { timers } = useTimers();
  const live = useLiveState();
  const timer = timers.find(x => x.issueKey === issueKey && (connectionId == null || x.connectionId === connectionId));
  if (!timer || timer.state !== "running" || (!timer.heldElsewhere && !timer.orphaned)) return null;
  const device = timer.ownerLabel || t("ui.timer.anotherDevice");
  return (
    <div role="status" {...surface("glass")} className={cn("grid gap-0.5 rounded-md border bg-muted/50 px-3 py-2 text-body-sm", className)}>
      {timer.heldElsewhere ? (
        <>
          <p className="font-medium">
            {t("ui.timer.elsewhere", { device, time: timer.runningSince ? timeOfDay(timer.runningSince) : "" })}
          </p>
          <p className="text-muted-foreground">{t("ui.timer.elsewhereHint")}</p>
        </>
      ) : (
        <p>
          {t("ui.timer.orphaned", {
            device,
            time: timer.leaseUntil ? timeOfDay(timer.leaseUntil.getTime() - TIMER_LEASE_MS) : "",
          })}
        </p>
      )}
      <p className={cn("text-caption", live === "live" ? "text-muted-foreground" : "text-warning")}>
        {live === "live" ? t("ui.timer.syncLive") : live === "offline" ? t("ui.timer.syncOffline") : t("ui.timer.syncConnecting")}
      </p>
    </div>
  );
}

/** Compact link to the tracked issue (running first, else most recent paused), or to the TODO worked on with no timer. */
export function ActiveTimerChip({ className }: { className?: string }) {
  const { timers, fetchedAt } = useTimers();
  const working = useTodoWorking();
  const timer = focusTimer(timers);
  const shadow = working.data && !working.data.linked && timer?.state !== "running" ? working.data : null;
  if (shadow)
    return (
      <Link
        to="/todos"
        {...surface("control")}
        className={cn("flex items-center gap-2 rounded-lg border border-dashed bg-background px-2.5 py-1.5 text-body-sm font-medium transition-colors hover:bg-accent", className)}
      >
        <TimerRing running />
        <span className="sr-only">{t("views.todos.workingOn", { text: shadow.text })}</span>
        <span className="truncate text-muted-foreground" aria-hidden>
          {shadow.text}
        </span>
        <TickingElapsed
          state="running"
          elapsedSeconds={Math.max(0, (new Date(shadow.serverNow).getTime() - new Date(shadow.startedAt).getTime()) / 1000)}
          fetchedAt={working.dataUpdatedAt}
        />
      </Link>
    );
  if (!timer) return null;
  const running = timer.state === "running";
  return (
    <Link
      to={issuePath({ key: timer.issueKey, connectionId: timer.connectionId })}
      {...surface("control")}
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

/**
 * Timers side by side: the others running beside the one the chip shows, a
 * row each with its pause and stop (at most `max`; all of them one step
 * away, in Quick start's timers). Nothing when it runs alone.
 */
export function OtherRunningTimers({ max = 2, className }: { max?: number; className?: string }) {
  const { timers, fetchedAt } = useTimers();
  const focus = focusTimer(timers);
  const others = runningTimers(timers).filter(tm => tm !== focus);
  if (others.length === 0) return null;
  return (
    <ul aria-label={t("ui.timer.alsoRunning")} className={cn("grid grid-cols-[minmax(0,1fr)] border-t pt-0.5", className)}>
      {others.slice(0, max).map(tm => (
        <li key={issueId(tm)} className="flex min-w-0 items-center gap-0.5">
          <Link
            to={issuePath({ key: tm.issueKey, connectionId: tm.connectionId })}
            {...surface("control")}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-body-sm font-medium transition-colors hover:bg-accent"
          >
            <TimerRing running />
            <span className="sr-only">{t("ui.timer.activeOn")}</span>
            <span className="truncate text-muted-foreground">{tm.issueKey}</span>
            <TickingElapsed state={tm.state} elapsedSeconds={tm.elapsedSeconds} fetchedAt={fetchedAt} />
          </Link>
          <QuickControls issueKey={tm.issueKey} connectionId={tm.connectionId} compact part="main" />
        </li>
      ))}
      {others.length > max && (
        <li>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => quickStart.set(true)}>
            {t("ui.timer.showAllRunning", { count: others.length + 1 })}
          </Button>
        </li>
      )}
    </ul>
  );
}

/**
 * Pause (or resume) and stop for the timer the chip shows, from any page: the
 * stop asks to log its time as everywhere. Held by another device, nothing
 * here (its issue's page offers the take-over).
 */
/** Which of the controls: all, the main two (pause, stop) or the others (move, discard). */
export type QuickControlsPart = "all" | "main" | "more";

export function ActiveTimerQuickControls({ compact = false, part = "all" }: { compact?: boolean; part?: QuickControlsPart }) {
  const { timers } = useTimers();
  const shown = focusTimer(timers);
  if (!shown) return null;
  return <QuickControls key={issueId(shown)} issueKey={shown.issueKey} connectionId={shown.connectionId} compact={compact} part={part} />;
}

function QuickControls({ issueKey, connectionId, compact, part }: { issueKey: string; connectionId: number; compact: boolean; part: QuickControlsPart }) {
  // Only what it draws: reading `fetchedAt` would re-render it on every poll.
  const { running, pending, heldElsewhere, pause, start, stop, move, discard } = useTimerActions(issueKey, connectionId);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const pauseTelemetry = useFlowControlProps(running ? "timer.pause" : "timer.resume");
  const stopTelemetry = useFlowControlProps("timer.stop");
  if (heldElsewhere) return null;
  const size = compact ? "h-7 w-7" : "h-8 w-8";
  const main = part !== "more";
  const more = part !== "main";
  return (
    <div className="flex shrink-0 items-center">
      {main && <>
      <Button
        variant="ghost"
        size="icon-sm"
        className={size}
        aria-label={running ? t("ui.timer.pauseFor", { key: issueKey }) : t("ui.timer.resumeFor", { key: issueKey })}
        title={running ? t("ui.timer.pause") : t("ui.timer.resume")}
        disabled={pending}
        onClick={running ? pause : start}
        {...pauseTelemetry}
      >
        {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={size}
        aria-label={t("ui.timer.stopAndLogFor", { key: issueKey })}
        title={t("ui.timer.stopAndLog")}
        disabled={pending}
        onClick={stop}
        {...stopTelemetry}
      >
        <Square className="h-4 w-4" />
      </Button>
      </>}
      {/* Started on the wrong issue: moved with its count (room for it only open). */}
      {more && !compact && (
        <Button
          variant="ghost"
          size="icon-sm"
          className={size}
          aria-label={t("ui.timer.moveToFor", { key: issueKey })}
          title={t("ui.timer.moveTo")}
          disabled={pending}
          onClick={move}
        >
          <MoveRight className="h-4 w-4" />
        </Button>
      )}
      {more && <Button
        variant="ghost"
        size="icon-sm"
        className={size}
        aria-label={t("ui.timer.discardFor", { key: issueKey })}
        title={t("ui.timer.discardTip")}
        disabled={pending}
        onClick={() => setConfirmingDiscard(true)}
      >
        <X className="h-4 w-4" />
      </Button>}
      {confirmingDiscard && (
        <DiscardTimerDialog
          issueKey={issueKey}
          connectionId={connectionId}
          open
          onOpenChange={setConfirmingDiscard}
          onConfirm={() => discard()}
        />
      )}
    </div>
  );
}

/** Note of the timer shown in the chip (running first, else latest paused). */
export function ActiveTimerNote({ className }: { className?: string }) {
  const { timers } = useTimers();
  const timer = focusTimer(timers);
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

/**
 * The closed sidebar's timer: its ring and time, and on a click a small player beside the rail with every
 * control of the open sidebar's card (pause, stop, move, discard), its note and what `extra` adds (focus).
 * The same controls in both states, never squeezed into a 76 px column.
 */
export function ActiveTimerRailPlayer({ extra }: { extra?: React.ReactNode }) {
  const { timers, fetchedAt } = useTimers();
  const timer = focusTimer(timers);
  const elapsed = useElapsed(timer?.state ?? "paused", timer?.elapsedSeconds ?? 0, fetchedAt);
  if (!timer) return null;
  const running = timer.state === "running";
  const hms = formatHMS(elapsed);
  // Timers side by side: how many more run beside it (their rows in the player).
  const more = Math.max(0, runningTimers(timers).length - 1);
  const label = `${t(running ? "ui.timer.activeOnLabel" : "ui.timer.pausedOnLabel", { key: timer.issueKey, time: hms })}${more > 0 ? `, ${t("ui.timer.moreRunning", { count: more })}` : ""}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          {...surface("control")}
          className="mx-auto flex w-12 flex-col items-center gap-1 rounded-md border bg-background py-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TimerRing running={running} />
          <span className="text-2xs font-medium text-muted-foreground tabular">{hms.slice(0, -3)}</span>
          {more > 0 && <span className="text-2xs font-medium text-muted-foreground tabular">{t("ui.timer.moreRunning", { count: more })}</span>}
        </button>
      </PopoverTrigger>
      {/* The open sidebar's card, the same lines: pause and stop by the time, move and discard by the note. */}
      <PopoverContent side="right" align="end" className="grid w-72 grid-cols-[minmax(0,1fr)] gap-0.5 p-1">
        <div className="flex min-w-0 items-center gap-0.5">
          <ActiveTimerChip className="min-w-0 flex-1 border-0 bg-transparent px-2" />
          <ActiveTimerQuickControls compact part="main" />
        </div>
        <OtherRunningTimers />
        <div className="flex min-w-0 items-center gap-0.5 border-t pt-0.5">
          <ActiveTimerNote className="min-w-0 flex-1" />
          <ActiveTimerQuickControls part="more" />
          {extra}
        </div>
      </PopoverContent>
    </Popover>
  );
}
