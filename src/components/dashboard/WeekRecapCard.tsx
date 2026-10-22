import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { formatDuration, formatDurationLong } from "@contracts/time";
import type { WeekRecap } from "@/lib/recap";
import { PeriodBars } from "@/components/dashboard/PeriodBars";
import { CountUpDuration } from "@/components/dashboard/PeriodSummary";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";

const CHART_COLOR = () => ({ fill: "bg-chart-focus", soft: "", solid: "", stroke: "" });

/**
 * "Your week": total vs last week (same days), daily bars and the
 * three facts worth knowing. Tonal arrows, never alarm colours.
 */
export function WeekRecapCard({
  recap,
  targetFor,
  pending,
  summaryOf,
}: {
  recap: WeekRecap;
  targetFor: (day: Date) => number;
  /** Today's bar shows the time tracked and not yet logged, live. */
  pending?: boolean;
  summaryOf: (issue: { key: string; connectionId?: number | null }) => string | undefined;
}) {
  const d = recap.deltaPct;
  const Arrow =
    d === null || d === 0 ? ArrowRight : d > 0 ? ArrowUpRight : ArrowDownRight;
  const facts = [
    t("views.dashboard.recap.daysAtGoal", { count: recap.daysAtGoal, workdays: recap.workdays }),
    recap.avgPerWorkedDay > 0 &&
      t("views.dashboard.recap.average", { duration: formatDurationLong(recap.avgPerWorkedDay) }),
    recap.topIssue &&
      `${t("views.dashboard.recap.topIssue", { key: recap.topIssue.key, duration: formatDuration(recap.topIssue.seconds) })}${
        summaryOf(recap.topIssue)
          ? ` · ${summaryOf(recap.topIssue)}`
          : ""
      }`,
  ].filter((f): f is string => typeof f === "string");

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,18rem)] lg:items-center">
      <div>
        <p className="text-body-sm text-muted-foreground">{t("views.dashboard.recap.thisWeek")}</p>
        <p className="mt-1 font-display text-display tabular">
          <CountUpDuration seconds={recap.total} />
        </p>
        <p
          {...surface("chip")}
          className={cn(
            "mt-2 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-caption font-medium",
            d !== null && d > 0
              ? "bg-primary-soft text-primary-strong"
              : "bg-muted text-muted-foreground"
          )}
        >
          <Arrow className="h-3.5 w-3.5" aria-hidden />
          {d === null
            ? t("views.dashboard.recap.noComparison")
            : t("views.dashboard.recap.vsLastWeek", { delta: `${d > 0 ? "+" : ""}${d}` })}
        </p>
      </div>
      <PeriodBars
        compact
        stacks={recap.perDay.map(p => ({
          day: p.day,
          parts: [{ project: "_", seconds: p.seconds }],
        }))}
        colorOf={CHART_COLOR}
        targetFor={targetFor}
        pending={pending}
      />
      <ul className="grid gap-2.5 text-body-sm">
        {facts.map(f => (
          <li key={f} className="flex gap-2">
            <span
              aria-hidden
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            />
            <span className="line-clamp-2">{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
