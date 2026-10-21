import { useEffect } from "react";
import { Link } from "react-router";
import { Maximize2, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useTimers } from "@/hooks/useTimers";
import { useTimerLogQueue } from "@/lib/timerLog";
import { quickStart } from "@/lib/quickStart";
import { focusMode } from "@/lib/flag";
import { TimerControls } from "@/components/TimerControls";
import { TimerNote } from "@/components/TimerNote";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";

/**
 * The timers, from the tab bar: the running one first, then the paused ones
 * (latest first), each with its controls sized for a thumb.
 */
export function MobileTimerSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { timers } = useTimers();
  const issues = trpc.issues.all.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const summaryOf = new Map((issues.data ?? []).map(i => [issueId(i), i.summary]));
  const logQueue = useTimerLogQueue();
  const sorted = [...timers].sort(
    (a, b) =>
      Number(b.state === "running") - Number(a.state === "running") ||
      (b.pausedAt?.getTime() ?? 0) - (a.pausedAt?.getTime() ?? 0)
  );

  // Nothing left to show, or a stopped timer asks to be logged: give way.
  const empty = timers.length === 0;
  const logging = logQueue.length > 0;
  useEffect(() => {
    if (open && (empty || logging)) onOpenChange(false);
  }, [open, empty, logging, onOpenChange]);

  // After the sheet lets go of focus, so the next dialog keeps it.
  const then = (fn: () => void) => {
    onOpenChange(false);
    requestAnimationFrame(fn);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-0 rounded-t-2xl bg-canvas p-0">
        <div className="px-4 pb-2 pt-4">
          <SheetTitle className="font-display text-body font-semibold">{t("ui.layout.timers")}</SheetTitle>
          <SheetDescription className="text-caption text-muted-foreground">
            {t("ui.layout.timersHint")}
          </SheetDescription>
        </div>
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain border-y bg-card">
          {sorted.map((timer, i) => (
            <li key={issueId(timer)} className="grid gap-1.5 px-4 py-3">
              <Link
                to={issuePath({ key: timer.issueKey, connectionId: timer.connectionId })}
                onClick={() => onOpenChange(false)}
                className="flex min-w-0 items-baseline gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="shrink-0 text-body-sm font-semibold tabular">{timer.issueKey}</span>
                <span className="truncate text-body-sm text-muted-foreground">
                  {summaryOf.get(issueId(timer))}
                </span>
              </Link>
              {/* Thumb-sized controls: the same ones as everywhere else. */}
              <div className="[&_button]:h-11 [&_button]:w-11 [&_button_svg]:h-5 [&_button_svg]:w-5 [&_.tabular]:text-body">
                <TimerControls issueKey={timer.issueKey} connectionId={timer.connectionId} />
              </div>
              {i === 0 && (
                <TimerNote key={issueId(timer)} issueKey={timer.issueKey} connectionId={timer.connectionId} note={timer.note} />
              )}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2 p-4">
          <Button
            variant="outline"
            className="h-11"
            disabled={!timers.some(t => t.state === "running")}
            onClick={() => then(() => focusMode.set(true))}
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
            {t("ui.layout.focus")}
          </Button>
          <Button className="h-11" onClick={() => then(() => quickStart.set(true))}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("ui.layout.startOther")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
