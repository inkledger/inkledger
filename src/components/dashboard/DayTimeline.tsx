import { timeOfDay } from "@/lib/dates";
import {
  formatDuration,
  formatDurationLong,
  wallHours,
  type TimeSpan,
} from "@contracts/time";
import {
  breakSpans,
  workBounds,
  type WorkSchedule,
} from "@contracts/workSchedule";
import { projectOf, type ProjectColor } from "@/lib/projectColors";
import { lanesOf, realSeconds } from "@contracts/placement";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { issuePath } from "@/lib/issues";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { surface } from "@/components/app/surface";
import { Play } from "lucide-react";
import { quickStart } from "@/lib/quickStart";

export type TimelineEntry = {
  id: string;
  issueKey: string;
  connectionId?: number | null;
  /** The issue's id on its tracker: the stable link to it. */
  remoteId?: string;
  summary?: string;
  start: Date;
  seconds: number;
  /** In-progress entry (running timer): drawn hatched */
  live?: boolean;
};

/** Gaps shorter than this between two entries are not drawn as pauses. */
const MIN_PAUSE_MS = 10 * 60_000;

type Span = { id: string; left: number; width: number };

const endOf = (s: TimeSpan) => new Date(s.start.getTime() + s.seconds * 1000);

/**
 * One day on an hour axis (reference: Dribbble time tracker): each worklog
 * is a tall soft block with a strong edge, and a thin coloured track runs
 * underneath. With a work schedule, off-hours are dimmed, breaks are grey
 * stripes and the working time not yet logged is drawn as dashed holes to
 * fill (`missing`); without one, pauses between entries are grey stripes.
 */
export function DayTimeline({
  day,
  entries,
  colorOf,
  schedule,
  missing = [],
  onGap,
  openHole,
  floor,
  todoSpans = [],
  liveControls,
}: {
  day: Date;
  entries: TimelineEntry[];
  colorOf: (project: string) => ProjectColor;
  /** Schedule in force on `day` */
  schedule?: WorkSchedule;
  /** Working time not logged yet (holes to fill) */
  missing?: TimeSpan[];
  onGap?: (gap: TimeSpan) => void;
  /** The hole reaching now: a Play on it starts a timer (asked from its start or from now). */
  openHole?: TimeSpan | null;
  /**
   * Standing on the entries' baseline at the bar's left end, in front of them
   * (a module's scene: its shadow falls on them; clicks pass through).
   */
  floor?: ReactNode;
  /** TODO time that day: a thin strip over the blocks, never one of them (it is not logged time). */
  todoSpans?: { start: Date; end: Date; linked: boolean; label: string }[];
  /** Pause and stop, on the running block's end (where "now" is). */
  liveControls?: ReactNode;
}) {
  const dayStart = day.getTime();
  const sorted = [...entries].sort(
    (a, b) => a.start.getTime() - b.start.getTime()
  );
  // Clock hours, not elapsed ones: DST days keep 9:00 at 9. TODO time widens the axis too.
  const hours = [
    ...sorted.flatMap(e => {
      const s = wallHours(e.start.getTime(), dayStart);
      return [s, s + e.seconds / 3600];
    }),
    ...todoSpans.flatMap(s => [wallHours(Math.max(dayStart, s.start.getTime()), dayStart), wallHours(s.end.getTime(), dayStart)]),
  ];
  const work = schedule ? workBounds(day, schedule) : null;
  // The axis spans the working day (8–18 without one), widened to the entries.
  const workFrom = work ? wallHours(work.start.getTime(), dayStart) : 8;
  const workTo = work ? wallHours(work.end.getTime(), dayStart) : 18;
  const first = Math.max(0, Math.floor(Math.min(...hours, workFrom)));
  const last = Math.min(24, Math.ceil(Math.max(...hours, workTo)));
  const span = last - first;
  const ticks = Array.from({ length: span + 1 }, (_, i) => first + i);
  const pos = (ms: number) => ((wallHours(ms, dayStart) - first) / span) * 100;

  // Time logged in parallel shares the height in lanes.
  const blocks = lanesOf(sorted).map(({ item: e, lane, lanes }) => {
    const start = e.start.getTime();
    const left = Math.max(0, pos(start));
    const right = Math.min(100, pos(start + e.seconds * 1000));
    return {
      ...e,
      left,
      width: Math.max(0.8, right - left),
      color: colorOf(projectOf(e.issueKey)),
      lane,
      lanes,
    };
  });

  // A pause is a stretch covered by no entry: compare with the furthest end so
  // far, not just the previous entry (a long block may span several others).
  // With a working day, breaks and holes say it all: no derived pauses.
  const pauses: Span[] = [];
  let coveredUntil = -Infinity;
  sorted.forEach((e, i) => {
    const start = e.start.getTime();
    if (!work && i > 0 && start - coveredUntil >= MIN_PAUSE_MS) {
      pauses.push({
        id: `p${i}`,
        left: pos(coveredUntil),
        width: pos(start) - pos(coveredUntil),
      });
    }
    coveredUntil = Math.max(coveredUntil, start + e.seconds * 1000);
  });

  const spanOf = (s: TimeSpan) => {
    const left = Math.max(0, pos(s.start.getTime()));
    return { left, width: Math.max(0, Math.min(100, pos(endOf(s).getTime())) - left) };
  };
  const breaks = schedule ? breakSpans(day, schedule).map(b => ({ ...b, ...spanOf(b) })) : [];
  const holes = missing.map(g => ({ ...g, ...spanOf(g) }));
  const offHours = work
    ? [
        { id: "before", left: 0, width: Math.max(0, pos(work.start.getTime())) },
        {
          id: "after",
          left: pos(work.end.getTime()),
          width: Math.max(0, 100 - pos(work.end.getTime())),
        },
      ]
    : [];
  const missingTotal = missing.reduce((a, g) => a + g.seconds, 0);
  // Work in parallel: what was logged against how long the day took.
  const logged = entries.reduce((a, e) => a + e.seconds, 0);
  const clock_ = realSeconds(entries);

  return (
    <figure className="m-0">
      {/* isolate: the blocks and a module on the perch stack inside the timeline, so the sticky page header stays over them. */}
      <div {...surface("ground")} className="relative isolate h-56 overflow-hidden rounded-lg bg-muted/30">
        {ticks.slice(1, -1).map(h => (
          <div
            key={h}
            aria-hidden
            className="absolute inset-y-0 border-l border-border/70"
            style={{ left: `${((h - first) / span) * 100}%` }}
          />
        ))}
        {offHours.map(o => (
          <div
            key={o.id}
            aria-hidden
            className="absolute inset-y-0 bg-muted/70"
            style={{ left: `${o.left}%`, width: `${o.width}%` }}
          />
        ))}
        {[...pauses, ...breaks.map(b => ({ ...b, id: `b${b.start.getTime()}` }))].map(p => (
          <div
            key={p.id}
            aria-hidden
            className="stripes-idle absolute bottom-6 top-3 flex justify-center rounded-md opacity-80"
            style={{ left: `${p.left}%`, width: `${p.width}%` }}
          >
            {p.id.startsWith("b") && p.width > 6 && (
              <span className="pt-1.5 text-caption text-muted-foreground">
                {t("views.dashboard.timeline.break")}
              </span>
            )}
          </div>
        ))}
        {holes.map(g => (
          <button
            key={g.start.getTime()}
            type="button"
            // Dashed and half see-through: no shadow of its own (it would show as a box).
            {...surface("glass")}
            disabled={!onGap}
            onClick={() => onGap?.(g)}
            title={t("views.dashboard.timeline.holeTitle", { from: timeOfDay(g.start), to: timeOfDay(endOf(g)), duration: formatDurationLong(g.seconds) })}
            aria-label={t("views.dashboard.timeline.holeLabel", { from: timeOfDay(g.start), to: timeOfDay(endOf(g)), duration: formatDurationLong(g.seconds) })}
            className="absolute bottom-6 top-3 z-10 flex min-w-1 items-start justify-center overflow-hidden rounded-md border-2 border-dashed border-primary-strong/35 bg-primary-soft/50 outline-none transition-colors hover:border-primary-strong/70 hover:bg-primary-soft focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none"
            style={{ left: `${g.left}%`, width: `${g.width}%` }}
          >
            {g.width > 7 && (
              <span className="truncate px-1.5 pt-1.5 text-caption font-medium text-primary-strong">
                {formatDuration(g.seconds)}
              </span>
            )}
          </button>
        ))}
        {openHole && (() => {
          const h = spanOf(openHole);
          return (
            <button
              type="button"
              {...surface("control")}
              onClick={() => quickStart.set(true)}
              aria-label={t("views.dashboard.timeline.playHole", { from: timeOfDay(openHole.start) })}
              title={t("views.dashboard.timeline.playHole", { from: timeOfDay(openHole.start) })}
              className="absolute bottom-7 z-20 flex h-6 w-6 -translate-x-full items-center justify-center rounded-full border bg-card text-primary-strong outline-none transition-colors hover:bg-primary-soft focus-visible:ring-2 focus-visible:ring-ring/40"
              style={{ left: `calc(${h.left + h.width}% - 2px)` }}
            >
              <Play className="h-3 w-3 fill-current" aria-hidden />
            </button>
          );
        })()}
        {blocks.map(b => {
          const style: CSSProperties = {
            left: `${b.left}%`,
            width: `${b.width}%`,
            // Lanes split the band between top-3 (0.75rem) and bottom-6 (1.5rem).
            ...(b.lanes > 1
              ? {
                  top: `calc(0.75rem + (100% - 2.25rem) * ${b.lane / b.lanes})`,
                  height: `calc((100% - 2.25rem) / ${b.lanes} - 2px)`,
                }
              : {}),
          };
          const title = `${b.issueKey} · ${formatDurationLong(b.seconds)}${b.summary ? ` · ${b.summary}` : ""}`;
          const body = (
            <>
              <span
                className={cn(
                  "h-full w-[18%] min-w-1.5 max-w-6 shrink-0 rounded-l-md",
                  b.live ? "bg-chart-focus" : b.color.fill
                )}
              />
              {b.width > 7 && (
                <span className="min-w-0 truncate px-2 pt-1.5 text-caption font-medium text-foreground/80">
                  {b.issueKey}
                </span>
              )}
            </>
          );
          // The running one is see-through stripes: glass, no shadow (it would show through).
          if (b.live)
            return (
              <div
                key={b.id}
                title={title}
                {...surface("glass")}
                className={cn("stripes-pending stripes-live absolute flex rounded-md", b.lanes === 1 && "bottom-6 top-3")}
                style={style}
              >
                {body}
                {liveControls && (
                  <div {...surface("control")} className="absolute bottom-1 right-1 z-30 rounded-md border bg-card">
                    {liveControls}
                  </div>
                )}
              </div>
            );
          // A logged slice opens its issue.
          return (
            <Link
              key={b.id}
              to={issuePath({ key: b.issueKey, connectionId: b.connectionId, remoteId: b.remoteId })}
              title={title}
              aria-label={`${t("views.dashboard.timeline.entry", { key: b.issueKey, time: timeOfDay(b.start), duration: formatDurationLong(b.seconds) })}${b.summary ? ` · ${b.summary}` : ""}`}
              {...surface("bar")}
              className={cn(
                "absolute z-10 flex rounded-md outline-none transition-[filter] hover:brightness-[0.96] focus-visible:ring-2 focus-visible:ring-ring/40",
                b.lanes === 1 && "bottom-6 top-3",
                b.color.solid
              )}
              style={style}
            >
              {body}
            </Link>
          );
        })}
        {todoSpans.length > 0 && (
          <div className="absolute inset-x-0 top-0.5 h-1.5">
            {todoSpans.map(s => {
              const left = Math.max(0, pos(s.start.getTime()));
              const width = Math.max(0.4, Math.min(100, pos(s.end.getTime())) - left);
              return (
                <span
                  key={s.start.getTime()}
                  title={t(s.linked ? "views.dashboard.timeline.todoLinked" : "views.dashboard.timeline.todoGap", { text: s.label, duration: formatDurationLong((s.end.getTime() - s.start.getTime()) / 1000) })}
                  className={cn("absolute inset-y-0 rounded-sm", s.linked ? "bg-foreground/35" : "border border-dashed border-primary-strong/70")}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-2 h-2">
          {[...pauses, ...breaks.map(b => ({ ...b, id: `b${b.start.getTime()}` }))].map(p => (
            <span
              key={p.id}
              aria-hidden
              className="absolute inset-y-0 rounded-sm bg-chart-break/70"
              style={{ left: `${p.left}%`, width: `${p.width}%` }}
            />
          ))}
          {blocks.map(b => (
            <span
              key={b.id}
              aria-hidden
              {...(b.live ? surface("glass") : surface("bar"))}
              className={cn(
                "absolute inset-y-0 rounded-sm",
                b.live ? "stripes-pending stripes-live" : b.color.fill
              )}
              style={{ left: `${b.left}%`, width: `${b.width}%` }}
            />
          ))}
        </div>
        {floor && (
          <div className="pointer-events-none absolute bottom-6 left-0 top-0 z-20 w-64 max-w-[50%]">
            {floor}
          </div>
        )}
        {entries.length === 0 && holes.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-body-sm text-muted-foreground">
            {schedule && !work
              ? t("views.dashboard.timeline.dayOff")
              : t("views.dashboard.timeline.empty")}
          </p>
        )}
      </div>
      <div
        aria-hidden
        className="relative mt-3 h-5 text-body-sm text-muted-foreground tabular"
      >
        {ticks.map((h, i) =>
          i % (span > 12 ? 2 : 1) === 0 ? (
            <span
              key={h}
              className={cn(
                "absolute -translate-x-1/2",
                i === 0 && "translate-x-0",
                i === span && "-translate-x-full",
                i % 3 !== 0 && "max-sm:hidden"
              )}
              style={{ left: `${((h - first) / span) * 100}%` }}
            >
              {h}
              <span className="max-sm:hidden">:00</span>
            </span>
          ) : null
        )}
      </div>
      {clock_ < logged && (
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t("views.dashboard.timeline.parallel", { logged: formatDurationLong(logged), clock: formatDurationLong(clock_) })}
        </p>
      )}
      {missing.length > 0 && (
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t("views.dashboard.timeline.missing")}{" "}
          <span className="font-semibold text-foreground tabular">
            {formatDurationLong(missingTotal)}
          </span>{" "}
          {t("views.dashboard.timeline.inGaps", { count: missing.length })}
          {onGap && t("views.dashboard.timeline.tapGap")}
        </p>
      )}
      <figcaption className="sr-only">
        {entries.length === 0
          ? t("views.dashboard.timeline.noEntries")
          : sorted
              .map(
                e =>
                  `${t("views.dashboard.timeline.entry", { key: e.issueKey, time: timeOfDay(e.start), duration: formatDurationLong(e.seconds) })}${e.live ? t("views.dashboard.timeline.running") : ""}`
              )
              .join("; ")}
        {todoSpans.map(s => `; ${t(s.linked ? "views.dashboard.timeline.todoLinked" : "views.dashboard.timeline.todoGap", { text: s.label, duration: formatDurationLong((s.end.getTime() - s.start.getTime()) / 1000) })}`).join("")}
      </figcaption>
    </figure>
  );
}
