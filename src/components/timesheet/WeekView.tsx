import { Link } from "react-router";
import { CopyPlus, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { formatDuration } from "@contracts/time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip } from "@/components/app/Chip";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { projectOf } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { Meter } from "@/components/app/Meter";
import { surface } from "@/components/app/surface";
import { goalTone } from "@/lib/goalTone";
import { usePendingSeconds } from "@/hooks/useTimers";
import { t, dateFormat } from "@/i18n";
import { issuePath, issueId } from "@/lib/issues";
import { workedSeconds } from "@/lib/worked";

export type TimesheetLog = {
  id: number;
  issueKey: string;
  connectionId?: number | null;
  remoteId: string;
  timeSpentSeconds: number;
  started: Date | string;
  comment: string;
  /** Where it stands on its tracker (locked there, in conflict) */
  sink?: { state: string | null; locked: { cause: string; message?: string } | null } | null;
};

const weekday = () => dateFormat({ weekday: "short" });
const dayMonth = () => dateFormat({ day: "numeric", month: "short" });

function isPending(w: TimesheetLog): boolean {
  return w.remoteId.startsWith("pending-");
}

export function DayProgress({
  seconds,
  target,
  label,
  pending,
}: {
  seconds: number;
  target: number;
  label: string;
  /** Timers not yet logged: hatched, live. */
  /** Shows the time tracked and not yet logged, live. */
  pending?: boolean;
}) {
  const pct = target > 0 ? Math.round((seconds / target) * 100) : 0;
  const live = usePendingSeconds(pending === true);
  const pendingSeconds = live?.pending ?? 0;
  const scale = Math.max(target, seconds + pendingSeconds, 1);
  return (
    <Meter
      value={seconds}
      max={scale}
      pending={pendingSeconds}
      running={live?.running}
      tone={goalTone(pct)}
      lit
      label={label}
      valueNow={pct}
    />
  );
}

type Props = {
  days: { date: Date; key: string }[];
  byDay: Map<string, TimesheetLog[]>;
  /** Per issueId: summary and remote id (for the link) */
  summaries: Map<string, { summary: string; remoteId: string | null }>;
  /** Expected seconds of a day (its schedule version) */
  targetFor: (day: Date) => number;
  todayKey: string;
  /** Unlogged timer time, shown on today's progress. */
  /** Shows the time tracked and not yet logged, live. */
  pending?: boolean;
  locked: boolean;
  selected: Set<number>;
  busy: boolean;
  onToggle: (id: number) => void;
  onEdit: (w: TimesheetLog) => void;
  onDelete: (w: TimesheetLog) => void;
  onDuplicate: (day: { date: Date; key: string }) => void;
  /** Log time on an empty day ("+"). */
  onAdd?: (date: Date) => void;
};

export function WeekView({
  days,
  byDay,
  summaries,
  targetFor,
  todayKey,
  pending,
  locked,
  selected,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
  onAdd,
}: Props) {
  return (
    <ol className="stagger grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-7">
      {days.map(day => {
        const entries = byDay.get(day.key) ?? [];
        // The hours worked that day: parallel work once.
        const total = workedSeconds(entries);
        const isToday = day.key === todayKey;
        const label = `${weekday().format(day.date)} ${dayMonth().format(day.date)}`;
        return (
          <li
            key={day.key}
            {...(entries.length === 0 && !isToday ? surface("glass") : surface("card"))}
            className={cn(
              "flex min-w-0 flex-col rounded-xl border p-2.5",
              isToday
                ? "border-primary-strong/40 bg-primary-soft"
                : entries.length === 0
                  ? "border-dashed bg-transparent"
                  : "bg-canvas"
            )}
            aria-current={isToday ? "date" : undefined}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-body-sm font-semibold capitalize">
                  {weekday().format(day.date)}
                </h3>
                <p className="text-caption text-muted-foreground">
                  {dayMonth().format(day.date)}
                  {isToday && t("views.timesheet.week.todaySuffix")}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {/* One more on a day that has entries already (an empty day has its own big "+"). */}
                {!locked && entries.length > 0 && onAdd && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("views.timesheet.week.logOn", { label })}
                    title={t("views.timesheet.week.logOn", { label })}
                    onClick={() => onAdd(day.date)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
                {!isToday && !locked && entries.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("views.timesheet.week.duplicateLabel", { label })}
                    title={t("views.timesheet.week.duplicate")}
                    disabled={busy}
                    onClick={() => onDuplicate(day)}
                  >
                    <CopyPlus className="h-4 w-4" />
                  </Button>
                )}
                <span className="text-body-sm font-semibold tabular">
                  {formatDuration(total)}
                </span>
              </div>
            </div>
            <div className="mt-2">
              <DayProgress
                seconds={total}
                target={targetFor(day.date)}
                label={t("views.timesheet.week.goalOf", { label })}
                pending={isToday && pending}
              />
            </div>

            <ul className="mt-3 grid min-w-0 grid-cols-1 gap-2">
              {entries.length === 0 && !locked && onAdd && (
                <li>
                  <button
                    type="button"
                    onClick={() => onAdd(day.date)}
                    aria-label={t("views.timesheet.week.logOn", { label })}
                    {...surface("glass")}
                    className="flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-transparent text-muted-foreground/60 transition-colors hover:border-border hover:bg-card/60 hover:text-foreground focus-visible:border-border"
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              )}
              {entries.map(w => {
                const info = summaries.get(issueId(w));
                const summary = info?.summary;
                return (
                  <li
                    key={w.id}
                    {...surface("card")}
                    className="min-w-0 rounded-xl border bg-card p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      {!locked && (
                        <Checkbox
                          aria-label={t("views.timesheet.week.select", { key: w.issueKey })}
                          checked={selected.has(w.id)}
                          onCheckedChange={() => onToggle(w.id)}
                        />
                      )}
                      <ProjectAvatar
                        project={projectOf(w.issueKey)}
                        size="xs"
                      />
                      <span className="ml-auto text-body-sm tabular">
                        {formatDuration(w.timeSpentSeconds)}
                      </span>
                    </div>
                    <Link
                      to={issuePath({ key: w.issueKey, connectionId: w.connectionId, remoteId: info?.remoteId })}
                      className="mt-1 block truncate text-body-sm font-medium underline-offset-4 hover:underline"
                    >
                      {w.issueKey}
                    </Link>
                    {summary && (
                      <p className="truncate text-caption text-muted-foreground">
                        {summary}
                      </p>
                    )}
                    {w.comment && (
                      <p className="mt-0.5 line-clamp-2 text-caption">{w.comment}</p>
                    )}
                    {(isPending(w) || !locked || w.sink?.locked || w.sink?.state === "conflict") && (
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <span className="flex flex-wrap gap-1">
                          {isPending(w) && <Chip tone="warning">{t("views.timesheet.week.queued")}</Chip>}
                          {w.sink?.locked && (
                            <Chip tone="neutral">
                              <Lock className="h-3 w-3" aria-hidden /> {t("views.timesheet.week.lockedThere")}
                            </Chip>
                          )}
                          {w.sink?.state === "conflict" && (
                            <Link to={issuePath({ key: w.issueKey, connectionId: w.connectionId, remoteId: info?.remoteId })}>
                              <Chip tone="warning">{t("views.timesheet.week.conflict")}</Chip>
                            </Link>
                          )}
                        </span>
                        {!locked && !w.sink?.locked && (
                          <span className="flex">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t("views.timesheet.week.edit", { key: w.issueKey })}
                              onClick={() => onEdit(w)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-danger"
                              aria-label={t("views.timesheet.week.delete", { key: w.issueKey })}
                              onClick={() => onDelete(w)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <span className="sr-only">
              {t("views.timesheet.week.total", { label, duration: formatDuration(total) })}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
