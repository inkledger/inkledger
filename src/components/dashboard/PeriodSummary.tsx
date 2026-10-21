import { Link } from "react-router";
import { useEffect, useState } from "react";
import { dayKey, formatDuration, formatDurationLong } from "@contracts/time";
import { toast } from "sonner";
import { useCountUp } from "@/hooks/useCountUp";
import { projectOf, type ProjectColor } from "@/lib/projectColors";
import { Chip } from "@/components/app/Chip";
import { SectionLabel } from "@/components/app/PageHeader";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { cn } from "@/lib/utils";
import { Meter } from "@/components/app/Meter";
import { goalTone } from "@/lib/goalTone";
import { t } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";

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
  colorOf,
  pending,
  celebrate = false,
  goalSeconds,
}: {
  label: string;
  totalSeconds: number;
  /** What counts towards the goal when it isn't the total logged (clock time: parallel work once) */
  goalSeconds?: number;
  targetSeconds: number;
  legend: { project: string; seconds: number; color: ProjectColor }[];
  issues: IssueTotal[];
  colorOf: (project: string) => ProjectColor;
  /** Timers not yet logged (only when the period includes now): hatched, live. */
  pending?: { pending: number; running: boolean };
  /** Today's view: celebrate (once a day) when the goal is reached. */
  celebrate?: boolean;
}) {
  return (
    <div>
      <p className="text-body-sm text-muted-foreground">{label}</p>
      <p className="mt-2 font-display text-display tabular">
        <CountUpDuration seconds={totalSeconds} />
      </p>

      <GoalProgress
        className="mt-4"
        totalSeconds={goalSeconds ?? totalSeconds}
        targetSeconds={targetSeconds}
        pending={pending}
        celebrate={celebrate}
      />

      {legend.length > 0 && (
        <>
          {/* Split by project: a slim segmented bar, same weight as the goal bar. */}
          {/* The bar clips its segments: it stands on a wrapper. */}
          <div data-lit="1" data-lit-wrap className="mt-6 rounded-full">
          <div
            data-lit-face
            className="flex h-2 gap-0.5 overflow-hidden rounded-full"
            aria-hidden
          >
            {legend.map(l => (
              <span
                key={l.project}
                className={cn("min-w-1.5", l.color.fill)}
                style={{ flexGrow: l.seconds }}
              />
            ))}
          </div>
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
            {legend.map(l => (
              <li key={l.project} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  // "Other" is see-through: not lit.
                  data-lit={l.color.fill.includes("/") ? undefined : "1"}
                  className={cn("h-3 w-3 rounded-xs", l.color.fill)}
                />
                {l.project}
                <span className="text-muted-foreground tabular">
                  {formatDurationLong(l.seconds)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionLabel as="h3" className="mt-8 px-0">
        {t("views.dashboard.summary.details")}
      </SectionLabel>
      {issues.length === 0 ? (
        <p className="mt-3 text-body-sm text-muted-foreground">
          {t("views.dashboard.summary.empty")}
        </p>
      ) : (
        <ul className="stagger mt-2 divide-y">
          {issues.map(i => {
            const project = projectOf(i.issueKey);
            return (
              <li key={issueId(i)}>
                <Link
                  to={issuePath({ key: i.issueKey, connectionId: i.connectionId, remoteId: i.remoteId })}
                  className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/60"
                >
                  <span className="relative">
                    <ProjectAvatar project={project} className="h-10 w-10" />
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card",
                        colorOf(project).fill
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{i.issueKey}</span>
                    <span className="block truncate text-body-sm text-muted-foreground">
                      {i.summary ?? "—"}
                    </span>
                  </span>
                  <span className="shrink-0 text-body-sm text-muted-foreground tabular">
                    {formatDurationLong(i.seconds)}
                  </span>
                  <Chip className="hidden shrink-0 sm:inline-flex">
                    {project}
                  </Chip>
                </Link>
              </li>
            );
          })}
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
  pending?: { pending: number; running: boolean };
  className?: string;
  celebrate?: boolean;
}) {
  const reached = targetSeconds > 0 && totalSeconds >= targetSeconds;
  const glowing = useGoalCelebration(celebrate && reached);
  const pct =
    targetSeconds > 0 ? Math.round((totalSeconds / targetSeconds) * 100) : 0;
  const pendingSeconds = pending?.pending ?? 0;
  // The bar scale grows past the target when logged + pending exceed it.
  const scale = Math.max(targetSeconds, totalSeconds + pendingSeconds, 1);
  return (
    <div className={className}>
      <Meter
        value={totalSeconds}
        max={scale}
        pending={pendingSeconds}
        running={pending?.running}
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
  try {
    if (localStorage.getItem(CELEBRATED_KEY) === today) return true;
    localStorage.setItem(CELEBRATED_KEY, today);
  } catch {
    // storage unavailable: once per page load
  }
  return false;
}
