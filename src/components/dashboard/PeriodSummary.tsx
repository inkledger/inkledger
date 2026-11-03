import { readStored, writeStored } from "@/lib/storage";
import { Link } from "react-router";
import { useEffect, useState } from "react";
import { dayKey, formatDuration, formatDurationLong } from "@contracts/time";
import { toast } from "sonner";
import { useCountUp } from "@/hooks/useCountUp";
import { usePendingSeconds } from "@/hooks/useTimers";
import { projectOf, type ProjectColor } from "@/lib/projectColors";
import { SectionLabel } from "@/components/app/PageHeader";
import { cn } from "@/lib/utils";
import { Meter } from "@/components/app/Meter";
import { goalTone } from "@/lib/goalTone";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";
import { surface } from "@/components/app/surface";

export type IssueTotal = {
  issueKey: string;
  connectionId?: number | null;
  /** Remote id on its connection (for the link) */
  remoteId?: string | null;
  summary?: string;
  seconds: number;
};

/**
 * Big total, progress towards the target, split by project and the
 * per-issue details (reference: "Summary Today").
 */
export function PeriodSummary({
  label,
  totalSeconds,
  targetSeconds,
  legend,
  issues,
  pending,
  celebrate = false,
  loggedSeconds,
}: {
  label: string;
  /** The hours worked: parallel work once (what counts towards the goal) */
  totalSeconds: number;
  /** The entries' sum, when parallel work makes it more than the hours worked */
  loggedSeconds?: number;
  targetSeconds: number;
  legend: { project: string; seconds: number; color: ProjectColor }[];
  issues: IssueTotal[];
  /** Kept for callers; the bands take their colours from the legend. */
  colorOf?: (project: string) => ProjectColor;
  /** Timers not yet logged (only when the period includes now): hatched, live. */
  /** Shows the time tracked and not yet logged, live. */
  pending?: boolean;
  /** Today's view: celebrate (once a day) when the goal is reached. */
  celebrate?: boolean;
}) {
  return (
    <div>
      <p className="text-body-sm text-muted-foreground">{label}</p>
      <p className="mt-2 font-display text-display tabular">
        <CountUpDuration seconds={totalSeconds} />
      </p>
      {loggedSeconds !== undefined && loggedSeconds > totalSeconds && (
        <p className="mt-1 text-body-sm text-muted-foreground">
          {t("views.dashboard.timeline.parallel", { logged: formatDurationLong(loggedSeconds), clock: formatDurationLong(totalSeconds) })}
        </p>
      )}

      <GoalProgress
        className="mt-4"
        totalSeconds={totalSeconds}
        targetSeconds={targetSeconds}
        pending={pending}
        celebrate={celebrate}
      />

      {/* By project, once (docs/design-system.md §7.1): a band each, its bar the share of the period's logged
          time, its issues under it with their own share. The legend, the segmented bar and the details
          said the project three times; now once. "Other" holds the projects past the top ones. */}
      <SectionLabel as="h3" className="mt-6 px-0">
        {t("views.dashboard.summary.details")}
      </SectionLabel>
      {issues.length === 0 && legend.length === 0 ? (
        <p className="mt-3 text-body-sm text-muted-foreground">
          {t("views.dashboard.summary.empty")}
        </p>
      ) : (
        <ul className="stagger mt-2 grid gap-3">
          {(() => {
            const logged = Math.max(1, legend.reduce((sum, l) => sum + l.seconds, 0));
            const named = new Set(legend.map(l => l.project));
            const other = legend.find(l => l.color.fill.includes("/"));
            return legend.map(l => {
              const own = issues.filter(i => {
                const project = projectOf(i.issueKey);
                return project === l.project || (l === other && !named.has(project));
              });
              const share = Math.round((l.seconds / logged) * 100);
              return (
                <li key={l.project}>
                  <section aria-label={`${l.project}: ${formatDurationLong(l.seconds)}, ${share}%`}>
                    <div className="flex min-w-0 items-center gap-2 text-body-sm">
                      <span aria-hidden {...(l.color.fill.includes("/") ? surface("glass") : surface("chip"))} className={cn("h-3 w-3 shrink-0 rounded-xs", l.color.fill)} />
                      <span className="min-w-0 truncate font-medium">{l.project}</span>
                      <span className="ml-auto shrink-0 tabular text-muted-foreground">
                        {formatDurationLong(l.seconds)} · {share}%
                      </span>
                    </div>
                    <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className={cn("block h-full rounded-full", l.color.fill)} style={{ width: `${Math.max(2, share)}%` }} />
                    </div>
                    {own.length > 0 && (
                      <ul className="mt-1">
                        {own.map(i => (
                          <li key={issueId(i)}>
                            <Link
                              to={issuePath({ key: i.issueKey, connectionId: i.connectionId, remoteId: i.remoteId })}
                              className="-mx-2 grid min-h-target grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-1 text-body-sm transition-colors hover:bg-accent/60 coarse:min-h-touch"
                            >
                              <span className="font-medium">{i.issueKey}</span>
                              <span className="truncate text-muted-foreground">{i.summary ?? "—"}</span>
                              <span className="tabular text-muted-foreground">{formatDurationLong(i.seconds)}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </li>
              );
            });
          })()}
        </ul>
      )}
    </div>
  );
}

/**
 * Progress towards a target: logged time solid, unlogged timers hatched and
 * live, a hairline marking the target when the total goes past it.
 */
export function GoalProgress({
  totalSeconds,
  targetSeconds,
  pending,
  className,
  celebrate = false,
}: {
  totalSeconds: number;
  targetSeconds: number;
  /** Shows the time tracked and not yet logged, live. */
  pending?: boolean;
  className?: string;
  celebrate?: boolean;
}) {
  const reached = targetSeconds > 0 && totalSeconds >= targetSeconds;
  const glowing = useGoalCelebration(celebrate && reached);
  const pct =
    targetSeconds > 0 ? Math.round((totalSeconds / targetSeconds) * 100) : 0;
  const live = usePendingSeconds(pending === true);
  const pendingSeconds = live?.pending ?? 0;
  // The bar scale grows past the target when logged + pending exceed it.
  const scale = Math.max(targetSeconds, totalSeconds + pendingSeconds, 1);
  return (
    <div className={className}>
      <Meter
        value={totalSeconds}
        max={scale}
        pending={pendingSeconds}
        running={live?.running}
        marker={targetSeconds}
        tone={goalTone(pct)}
        size="lg"
        label={t("views.dashboard.summary.progress")}
        valueNow={pct}
        animate
        lit
        className={cn(glowing && "goal-glow")}
      />
      <div className="mt-1.5 flex justify-between gap-3 text-body-sm text-muted-foreground tabular">
        <span>
          {pct}%
          {pendingSeconds >= 60 && (
            <span className="text-foreground/80">
              {" "}
              {t("views.dashboard.summary.pendingToLog", { duration: formatDurationLong(pendingSeconds) })}
            </span>
          )}
        </span>
        <span>{t("views.dashboard.summary.goal", { duration: formatDuration(targetSeconds) })}</span>
      </div>
    </div>
  );
}

/** A duration that counts to its new value when it changes. */
export function CountUpDuration({ seconds }: { seconds: number }) {
  return <>{formatDuration(useCountUp(seconds))}</>;
}

const CELEBRATED_KEY = "ikl-goal-celebrated";

/**
 * Once a day, when today's logged time reaches the goal: a short tone-on-tone
 * shimmer on the bar and a toast. Returns whether the bar is glowing.
 */
function useGoalCelebration(reached: boolean): boolean {
  const [glowing, setGlowing] = useState(false);
  useEffect(() => {
    if (!reached || celebratedToday()) return;
    toast.success(t("views.dashboard.summary.goalReached"), {
      id: "goal-reached",
      description: t("views.dashboard.summary.goalReachedHint"),
    });
    // Not cleared on cleanup: a dev double-run must not cancel the glow.
    setTimeout(() => setGlowing(true), 0);
    setTimeout(() => setGlowing(false), 2200);
  }, [reached]);
  return glowing;
}

/** Marks today as celebrated; true if it already was. */
function celebratedToday(): boolean {
  const today = dayKey(new Date());
  if (readStored(CELEBRATED_KEY) === today) return true;
  // Storage unavailable: once per page load.
  writeStored(CELEBRATED_KEY, today);
  return false;
}
