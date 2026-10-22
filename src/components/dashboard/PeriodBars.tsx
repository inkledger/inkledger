import { usePendingSeconds } from "@/hooks/useTimers";
import { useToday } from "@/hooks/useToday";
import { dayKey, formatDurationLong } from "@contracts/time";
import type { ProjectColor } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { t, dateFormat } from "@/i18n";
import { surface } from "@/components/app/surface";

export type DayStack = {
  day: Date;
  /** Seconds per project, any order */
  parts: { project: string; seconds: number }[];
  /** The day's hours worked when work ran in parallel (less than the parts' sum): the bar's height, its parts in proportion */
  worked?: number;
};

/**
 * Stacked vertical bars, one per day, each with a dashed tick at its own
 * target (the schedule in force that day; none on days off).
 * Pure CSS (no chart library): readable in both themes.
 */
export function PeriodBars({
  stacks,
  colorOf,
  targetFor,
  dense = false,
  compact = false,
  pending,
}: {
  stacks: DayStack[];
  colorOf: (project: string) => ProjectColor;
  /** Expected seconds of a day (0 = day off) */
  targetFor: (day: Date) => number;
  /** Month view: thinner bars, numeric labels */
  dense?: boolean;
  /** Short variant for secondary charts */
  compact?: boolean;
  /** Timers not yet logged: hatched, live, stacked on today's bar. */
  /** Today's bar shows the time tracked and not yet logged, live. */
  pending?: boolean;
}) {
  const today = dayKey(useToday());
  const live = usePendingSeconds(pending === true);
  const pendingSeconds = live?.pending ?? 0;
  const sums = stacks.map(s => s.parts.reduce((a, p) => a + p.seconds, 0));
  const totals = stacks.map((s, i) => s.worked ?? sums[i]);
  const targets = stacks.map(s => targetFor(s.day));
  const max = Math.max(
    Math.max(0, ...targets) * 1.15,
    ...totals.map((t, i) =>
      dayKey(stacks[i].day) === today ? t + pendingSeconds : t
    ),
    3600
  );

  return (
    <figure className="m-0">
      <div
        {...surface("ground")}
        className={cn(
          "rounded-lg bg-muted/30 px-2 pb-2",
          compact ? "h-24 pt-3" : "h-52 pt-6"
        )}
      >
        <div className="relative flex h-full items-end gap-1 sm:gap-1.5">
          {stacks.map((s, i) => {
            const total = totals[i];
            const isToday = dayKey(s.day) === today;
            const target = targets[i];
            return (
              <div
                key={dayKey(s.day)}
                title={`${dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(s.day)}: ${formatDurationLong(total)}${isToday && pendingSeconds >= 60 ? t("views.dashboard.bars.toLog", { duration: formatDurationLong(pendingSeconds) }) : ""}`}
                // A day with no goal is see-through: glass, no shadow.
                {...(target > 0 ? surface("bar") : surface("glass"))}
                className={cn(
                  "relative h-full flex-1 rounded-md",
                  target > 0 ? "bg-muted" : "bg-muted/60"
                )}
              >
                <div className="absolute inset-0 flex flex-col-reverse overflow-hidden rounded-md">
                  {target > 0 && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/30"
                      style={{ bottom: `${(target / max) * 100}%` }}
                    />
                  )}
                  {isToday && pendingSeconds > 0 && (
                    <span
                      className={cn(
                        "order-last w-full border-t border-background/70 transition-[height] duration-1000 ease-linear stripes-pending",
                        live?.running && "stripes-live"
                      )}
                      style={{ height: `${(pendingSeconds / max) * 100}%` }}
                    />
                  )}
                  {s.parts
                    .filter(p => p.seconds > 0)
                    .sort((a, b) => b.seconds - a.seconds)
                    .map(p => (
                      <span
                        key={p.project}
                        className={cn(
                          "w-full border-t border-background/70 first:border-t-0",
                          colorOf(p.project).fill
                        )}
                        style={{ height: `${((sums[i] > total ? (p.seconds * total) / sums[i] : p.seconds) / max) * 100}%` }}
                      />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div
        aria-hidden
        className="mt-2 flex gap-1 px-2 text-center text-caption text-muted-foreground sm:gap-1.5"
      >
        {stacks.map(s => {
          const key = dayKey(s.day);
          const label = dense ? (
            String(s.day.getDate())
          ) : (
            <>
              <span className="max-sm:hidden">
                {dateFormat({ weekday: "short" }).format(s.day)}{" "}
              </span>
              {s.day.getDate()}
            </>
          );
          return (
            <span
              key={key}
              className={cn(
                "flex-1 truncate tabular",
                key === today && "font-semibold text-foreground",
                dense && s.day.getDate() % 2 === 0 && "max-sm:invisible"
              )}
            >
              {label}
            </span>
          );
        })}
      </div>
      <figcaption className="sr-only">
        {stacks
          .map(
            (s, i) =>
              `${dateFormat({}).format(s.day)}: ${formatDurationLong(totals[i])}`
          )
          .join("; ")}
      </figcaption>
    </figure>
  );
}
