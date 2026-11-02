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
  parallel,
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
  /**
   * TODO time per day (dayKey): a slim mark beside each bar, never part of
   * it. Solid: worked with an issue timer; dashed: with none (no issue covers it).
   */
  parallel?: Map<string, { linked: number; gap: number }>;
}) {
  const today = dayKey(useToday());
  const live = usePendingSeconds(pending === true);
  const pendingSeconds = live?.pending ?? 0;
  const sums = stacks.map(s => s.parts.reduce((a, p) => a + p.seconds, 0));
  const totals = stacks.map((s, i) => s.worked ?? sums[i]);
  const targets = stacks.map(s => targetFor(s.day));
  const besides = stacks.map(s => parallel?.get(dayKey(s.day)) ?? null);
  const max = Math.max(
    Math.max(0, ...targets) * 1.15,
    ...totals.map((t, i) =>
      dayKey(stacks[i].day) === today ? t + pendingSeconds : t
    ),
    ...besides.map(b => (b ? b.linked + b.gap : 0)),
    3600
  );
  const anyBeside = besides.some(b => b && b.linked + b.gap >= 60);

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
            const beside = besides[i];
            const besideText =
              beside && beside.linked + beside.gap >= 60
                ? t("views.dashboard.bars.todoTime", { duration: formatDurationLong(beside.linked + beside.gap), gap: formatDurationLong(beside.gap) })
                : "";
            return (
              <div
                key={dayKey(s.day)}
                title={`${dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(s.day)}: ${formatDurationLong(total)}${isToday && pendingSeconds >= 60 ? t("views.dashboard.bars.toLog", { duration: formatDurationLong(pendingSeconds) }) : ""}${besideText}`}
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
                {beside && beside.linked + beside.gap >= 60 && (
                  // Beside the bar, never in it: the TODO time is not logged time.
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 -right-0.5 flex w-1 flex-col-reverse sm:-right-1">
                    {beside.linked > 0 && <span className="w-full rounded-sm bg-foreground/35" style={{ height: `${(beside.linked / max) * 100}%` }} />}
                    {beside.gap > 0 && <span className="w-full rounded-sm border border-dashed border-primary-strong/70" style={{ height: `${(beside.gap / max) * 100}%` }} />}
                  </span>
                )}
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
      {anyBeside && (
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-3 w-1 rounded-sm bg-foreground/35" />
            {t("views.dashboard.bars.todoLinked")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-3 w-1 rounded-sm border border-dashed border-primary-strong/70" />
            {t("views.dashboard.bars.todoGap")}
          </span>
        </p>
      )}
      <figcaption className="sr-only">
        {stacks
          .map(
            (s, i) =>
              `${dateFormat({}).format(s.day)}: ${formatDurationLong(totals[i])}${
                besides[i] && (besides[i]?.linked ?? 0) + (besides[i]?.gap ?? 0) >= 60
                  ? t("views.dashboard.bars.todoTime", { duration: formatDurationLong((besides[i]?.linked ?? 0) + (besides[i]?.gap ?? 0)), gap: formatDurationLong(besides[i]?.gap ?? 0) })
                  : ""
              }`
          )
          .join("; ")}
      </figcaption>
      {/* What the bars draw, as a table for a screen reader: projects, target and pending per day. */}
      <table className="sr-only">
        <caption>{t("views.dashboard.bars.tableCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("views.dashboard.bars.day")}</th>
            <th scope="col">{t("views.dashboard.bars.logged")}</th>
            <th scope="col">{t("views.dashboard.bars.target")}</th>
            {pending && <th scope="col">{t("views.dashboard.bars.pending")}</th>}
            <th scope="col">{t("views.dashboard.bars.projects")}</th>
            {parallel && <th scope="col">{t("views.dashboard.bars.todo")}</th>}
          </tr>
        </thead>
        <tbody>
          {stacks.map((s, i) => (
            <tr key={dayKey(s.day)}>
              <th scope="row">{dateFormat({}).format(s.day)}</th>
              <td>{formatDurationLong(totals[i])}</td>
              <td>{targets[i] > 0 ? formatDurationLong(targets[i]) : "—"}</td>
              {pending && <td>{dayKey(s.day) === today && pendingSeconds > 0 ? formatDurationLong(pendingSeconds) : "—"}</td>}
              <td>
                {s.parts
                  .filter(p => p.seconds > 0)
                  .sort((a, b) => b.seconds - a.seconds)
                  .map(p => `${p.project} ${formatDurationLong(p.seconds)}`)
                  .join(", ") || "—"}
              </td>
              {parallel && <td>{besides[i] && besides[i].linked + besides[i].gap >= 60 ? formatDurationLong(besides[i].linked + besides[i].gap) : "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
