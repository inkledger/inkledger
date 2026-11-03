import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { AlertTriangle, CopyPlus, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { formatDuration, formatSeconds } from "@contracts/time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Chip } from "@/components/app/Chip";
import { Meter } from "@/components/app/Meter";
import { ListRow } from "@/components/app/ListRow";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { projectOf } from "@/lib/projectColors";
import { goalTone } from "@/lib/goalTone";
import { issueId, issuePath } from "@/lib/issues";
import { nextIndex } from "@/lib/roving";
import { workedSeconds } from "@/lib/worked";
import { dayMonth } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { t, dateFormat } from "@/i18n";
import type { TimesheetLog } from "./WeekView";

type Day = { date: Date; key: string };

type Props = {
  days: Day[];
  byDay: Map<string, TimesheetLog[]>;
  summaries: Map<string, { summary: string; remoteId: string | null }>;
  targetFor: (day: Date) => number;
  todayKey: string;
  locked: boolean;
  selected: Set<number>;
  busy: boolean;
  onToggle: (id: number) => void;
  onToggleDay: (ids: number[], on: boolean) => void;
  onEdit: (w: TimesheetLog) => void;
  onDelete: (w: TimesheetLog) => void;
  onDuplicate: (day: Day) => void;
  onAdd?: (date: Date) => void;
};

type Row = { id: string; key: string; connectionId?: number | null; remoteId: string | null; summary?: string; perDay: Map<string, TimesheetLog[]>; total: number };

const weekday = () => dateFormat({ weekday: "short" });
const isPending = (w: TimesheetLog) => w.remoteId.startsWith("pending-");

/**
 * A week as a timesheet (Harvest's and Timely's week grid): one row per issue, the seven days and the
 * row's total; the last row the days' totals against their goal, with the day's own actions. A cell's
 * hours open its entries (select, edit, delete, its state on the tracker). One Tab stop: the arrows move
 * cell to cell (the ARIA grid pattern). It is a data table, so in a narrow region it scrolls inside
 * itself (WCAG 1.4.10's exception). On a phone (the region below 28rem) the same week is a strip of the
 * seven days with their totals, and the chosen day's entries under it. Nothing of the day cards is lost:
 * the "Days" layout stays one choice away.
 */
export function WeekGrid(props: Props) {
  const { days, byDay, summaries, todayKey } = props;
  const rows = useMemo<Row[]>(() => {
    const out = new Map<string, Row>();
    for (const day of days) {
      for (const w of byDay.get(day.key) ?? []) {
        const id = issueId(w);
        const info = summaries.get(id);
        const row: Row = out.get(id) ?? { id, key: w.issueKey, connectionId: w.connectionId, remoteId: info?.remoteId ?? null, summary: info?.summary, perDay: new Map<string, TimesheetLog[]>(), total: 0 };
        row.perDay.set(day.key, [...(row.perDay.get(day.key) ?? []), w]);
        out.set(id, row);
      }
    }
    for (const row of out.values()) row.total = workedSeconds([...row.perDay.values()].flat());
    return [...out.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  }, [days, byDay, summaries]);
  const dayTotals = days.map(day => workedSeconds(byDay.get(day.key) ?? []));
  const todayIndex = days.findIndex(day => day.key === todayKey);
  return (
    <div className="region">
      <div className="hidden @m:block">
        <Grid {...props} rows={rows} dayTotals={dayTotals} />
      </div>
      <div className="@m:hidden">
        <DayStrip {...props} dayTotals={dayTotals} initial={todayIndex >= 0 ? todayIndex : Math.max(0, dayTotals.findIndex(total => total > 0))} />
      </div>
    </div>
  );
}

function Grid({ days, todayKey, targetFor, locked, selected, busy, onToggle, onToggleDay, onEdit, onDelete, onDuplicate, onAdd, rows, dayTotals }: Props & { rows: Row[]; dayTotals: number[] }) {
  const table = useRef<HTMLTableElement>(null);
  // The one cell in the Tab order (row, column; column 0 is the issue's link).
  const [active, setActive] = useState<[number, number]>([0, 1]);
  const columns = days.length + 1;
  const move = (event: KeyboardEvent<HTMLTableElement>) => {
    const [r, c] = at;
    let next: [number, number] | null = null;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const to = r + (event.key === "ArrowDown" ? 1 : -1);
      if (to >= 0 && to < rows.length) next = [to, c];
    } else {
      const to = nextIndex(c, columns, event);
      if (to !== null) next = [r, to];
    }
    if (!next) return;
    event.preventDefault();
    setActive(next);
    table.current?.querySelector<HTMLElement>(`[data-cell="${next[0]},${next[1]}"]`)?.focus();
  };
  // Kept inside the grid when the rows change (another week, a deleted entry).
  const at: [number, number] = [Math.min(active[0], Math.max(0, rows.length - 1)), Math.min(active[1], columns - 1)];
  const tab = (r: number, c: number) => (at[0] === r && at[1] === c ? 0 : -1);
  return (
    <div data-overflow-ok className="overflow-x-auto">
      <table ref={table} role="grid" aria-label={t("views.timesheet.grid.label")} onKeyDown={move} className="w-full min-w-[34rem] table-fixed border-separate border-spacing-0 text-body-sm">
        <colgroup>
          <col className="w-[30%]" />
          {days.map(day => <col key={day.key} />)}
          <col className="w-[6.5rem]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="border-b px-2 pb-2 text-left text-caption font-medium text-muted-foreground">{t("views.timesheet.grid.issue")}</th>
            {days.map(day => {
              const today = day.key === todayKey;
              return (
                // surface: none — today's column tint, not a box (its cells and foot carry the same tint).
                <th key={day.key} scope="col" aria-current={today ? "date" : undefined} className={cn("border-b px-1 pb-2 text-center text-caption font-medium", today ? "rounded-t-lg bg-primary-soft pt-1 text-primary-strong" : "text-muted-foreground", targetFor(day.date) === 0 && !today && "bg-muted/40")}>
                  <span className="block capitalize">{weekday().format(day.date)}</span>
                  <span className="block tabular">{day.date.getDate()}</span>
                </th>
              );
            })}
            <th scope="col" className="border-b px-2 pb-2 text-right text-caption font-medium text-muted-foreground">{t("views.timesheet.grid.total")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.id} className="group/row">
              <th scope="row" className="min-w-0 border-b px-2 py-1.5 text-left font-normal">
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectAvatar project={projectOf(row.key)} size="xs" />
                  <span className="grid min-w-0">
                    <Link data-cell={`${r},0`} tabIndex={tab(r, 0)} onFocus={() => setActive([r, 0])} to={issuePath({ key: row.key, connectionId: row.connectionId, remoteId: row.remoteId })} className="truncate font-medium underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {row.key}
                    </Link>
                    {row.summary && <span className="truncate text-caption text-muted-foreground">{row.summary}</span>}
                  </span>
                </span>
              </th>
              {days.map((day, d) => {
                const entries = row.perDay.get(day.key) ?? [];
                const today = day.key === todayKey;
                return (
                  <td key={day.key} className={cn("border-b p-0.5 text-center", today && "bg-primary-soft/50", targetFor(day.date) === 0 && !today && "bg-muted/40")}>
                    <Cell
                      cell={`${r},${d + 1}`}
                      tabIndex={tab(r, d + 1)}
                      onFocus={() => setActive([r, d + 1])}
                      issueKey={row.key}
                      day={day}
                      entries={entries}
                      locked={locked}
                      selected={selected}
                      onToggle={onToggle}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      onAdd={onAdd}
                    />
                  </td>
                );
              })}
              <td className="whitespace-nowrap border-b px-2 text-right font-semibold tabular">{formatDuration(row.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="px-2 pt-2 text-left align-top text-caption font-medium text-muted-foreground">{t("views.timesheet.grid.dayTotal")}</th>
            {days.map((day, d) => {
              const entries = rows.flatMap(row => row.perDay.get(day.key) ?? []);
              const label = `${weekday().format(day.date)} ${dayMonth(day.date)}`;
              const target = targetFor(day.date);
              const pct = target > 0 ? Math.round((dayTotals[d] / target) * 100) : 0;
              const today = day.key === todayKey;
              return (
                <td key={day.key} className={cn("px-1 pt-2 align-top", today && "rounded-b-lg bg-primary-soft pb-1.5")}>
                  <span className="block whitespace-nowrap text-center font-semibold tabular">{dayTotals[d] > 0 ? formatSeconds(dayTotals[d], { days: false }) : "–"}</span>
                  {target > 0 && <Meter value={dayTotals[d]} max={Math.max(target, dayTotals[d], 1)} size="xs" tone={goalTone(pct)} label={t("views.timesheet.week.goalOf", { label })} valueNow={pct} className="mt-1" />}
                  {!locked && (
                    <span className="mt-1 flex flex-wrap justify-center">
                      {entries.length > 0 && (
                        <Checkbox
                          className="m-1.5"
                          aria-label={t("views.timesheet.week.selectDay", { label })}
                          checked={entries.every(w => selected.has(w.id)) ? true : entries.some(w => selected.has(w.id)) ? "indeterminate" : false}
                          onCheckedChange={() => onToggleDay(entries.map(w => w.id), !entries.every(w => selected.has(w.id)))}
                        />
                      )}
                      {onAdd && (
                        <Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("views.timesheet.week.logOn", { label })} title={t("views.timesheet.week.logOn", { label })} onClick={() => onAdd(day.date)}>
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {!today && entries.length > 0 && (
                        <Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("views.timesheet.week.duplicateLabel", { label })} title={t("views.timesheet.week.duplicate")} disabled={busy} onClick={() => onDuplicate(day)}>
                          <CopyPlus className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </span>
                  )}
                </td>
              );
            })}
            <td className="whitespace-nowrap px-2 pt-2 text-right align-top font-semibold tabular">{formatDuration(dayTotals.reduce((a, b) => a + b, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** One cell: the hours of an issue on a day; its entries in a popover (or, empty, a way to log there). */
function Cell({ cell, tabIndex, onFocus, issueKey, day, entries, locked, selected, onToggle, onEdit, onDelete, onAdd }: {
  cell: string;
  tabIndex: number;
  onFocus: () => void;
  issueKey: string;
  day: Day;
  entries: TimesheetLog[];
  locked: boolean;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onEdit: (w: TimesheetLog) => void;
  onDelete: (w: TimesheetLog) => void;
  onAdd?: (date: Date) => void;
}) {
  const label = `${weekday().format(day.date)} ${dayMonth(day.date)}`;
  const base = "flex h-9 w-full items-center justify-center gap-1 rounded-md tabular outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
  if (entries.length === 0)
    return (
      <button
        type="button"
        data-cell={cell}
        tabIndex={tabIndex}
        onFocus={onFocus}
        aria-label={locked || !onAdd ? t("views.timesheet.grid.emptyCell", { key: issueKey, label }) : t("views.timesheet.week.logOn", { label })}
        aria-disabled={locked || !onAdd || undefined}
        onClick={() => !locked && onAdd?.(day.date)}
        className={cn(base, "text-muted-foreground/50", !locked && onAdd && "hover:bg-accent/70 hover:text-foreground")}
      >
        <span aria-hidden>–</span>
      </button>
    );
  const total = workedSeconds(entries);
  const warn = entries.some(w => isPending(w) || w.sink?.state === "conflict");
  const lockedThere = entries.some(w => w.sink?.locked);
  const picked = entries.some(w => selected.has(w.id));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-cell={cell}
          tabIndex={tabIndex}
          onFocus={onFocus}
          aria-label={t("views.timesheet.grid.cell", { key: issueKey, label, duration: formatDuration(total) })}
          className={cn(base, "font-medium hover:bg-accent/70", picked && "bg-primary-soft text-primary-strong")}
        >
          {/* The short form ("1h 45m") in a cell: a table is scanned for its digits; the label has the long one. */}
          {formatSeconds(total, { days: false })}
          {warn && <AlertTriangle className="h-3 w-3 text-warning" aria-hidden />}
          {lockedThere && <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="grid w-80 gap-1 p-2">
        <p className="px-1 text-caption text-muted-foreground">
          {issueKey} · {label}
        </p>
        <ul className="grid divide-y">
          {entries.map(w => (
            <li key={w.id}>
              <EntryRow w={w} locked={locked} selected={selected} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
            </li>
          ))}
        </ul>
        {!locked && onAdd && (
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => onAdd(day.date)}>
            <Plus className="h-4 w-4" />
            {t("views.timesheet.week.logOn", { label })}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** An entry as one row (the grid's popover, the phone's day): select, its time and note, its state, edit and delete. */
function EntryRow({ w, locked, selected, onToggle, onEdit, onDelete, showKey = false }: { w: TimesheetLog; locked: boolean; selected: Set<number>; onToggle: (id: number) => void; onEdit: (w: TimesheetLog) => void; onDelete: (w: TimesheetLog) => void; showKey?: boolean }) {
  return (
    <ListRow
      lead={
        <span className="flex items-center gap-2">
          {!locked && <Checkbox aria-label={t("views.timesheet.week.select", { key: w.issueKey })} checked={selected.has(w.id)} onCheckedChange={() => onToggle(w.id)} />}
          {showKey && <ProjectAvatar project={projectOf(w.issueKey)} size="xs" />}
        </span>
      }
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="tabular">{formatDuration(w.timeSpentSeconds)}</span>
          {showKey && (
            <Link to={issuePath({ key: w.issueKey, connectionId: w.connectionId })} className="truncate underline-offset-4 hover:underline">
              {w.issueKey}
            </Link>
          )}
          {isPending(w) && <Chip tone="warning">{t("views.timesheet.week.queued")}</Chip>}
          {w.sink?.locked && (
            <Chip tone="neutral">
              <Lock className="h-3 w-3" aria-hidden /> {t("views.timesheet.week.lockedThere")}
            </Chip>
          )}
          {w.sink?.state === "conflict" && <Chip tone="warning">{t("views.timesheet.week.conflict")}</Chip>}
        </span>
      }
      meta={w.comment || undefined}
      trail={
        !locked && !w.sink?.locked ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={t("views.timesheet.week.edit", { key: w.issueKey })} onClick={() => onEdit(w)}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-danger" aria-label={t("views.timesheet.week.delete", { key: w.issueKey })} onClick={() => onDelete(w)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        ) : undefined
      }
    />
  );
}

/** The phone's week: the seven days with their totals (one Tab stop, arrows move), the chosen day's entries under it. */
function DayStrip({ days, byDay, todayKey, targetFor, locked, selected, busy, onToggle, onToggleDay, onEdit, onDelete, onDuplicate, onAdd, dayTotals, initial }: Props & { dayTotals: number[]; initial: number }) {
  const [chosen, setChosen] = useState(initial);
  const group = useRef<HTMLDivElement>(null);
  const day = days[Math.min(chosen, days.length - 1)];
  if (!day) return null;
  const entries = byDay.get(day.key) ?? [];
  const label = `${weekday().format(day.date)} ${dayMonth(day.date)}`;
  const target = targetFor(day.date);
  const total = dayTotals[chosen] ?? 0;
  const pct = target > 0 ? Math.round((total / target) * 100) : 0;
  return (
    <div className="grid gap-3">
      <div
        ref={group}
        role="radiogroup"
        aria-label={t("views.timesheet.grid.days")}
        className="grid grid-cols-7 gap-1"
        onKeyDown={event => {
          const to = nextIndex(chosen, days.length, event);
          if (to === null) return;
          event.preventDefault();
          setChosen(to);
          group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[to]?.focus();
        }}
      >
        {days.map((d, i) => {
          const on = i === chosen;
          const today = d.key === todayKey;
          return (
            <button
              key={d.key}
              type="button"
              role="radio"
              {...surface("control", { on })}
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              aria-label={`${weekday().format(d.date)} ${dayMonth(d.date)}: ${formatDuration(dayTotals[i] ?? 0)}`}
              onClick={() => setChosen(i)}
              className={cn(
                "grid min-h-touch place-items-center rounded-lg border py-1 text-caption outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-primary-strong/50 bg-primary-soft text-primary-strong" : "bg-card text-muted-foreground",
                targetFor(d.date) === 0 && !on && "bg-muted/40"
              )}
            >
              <span className={cn("capitalize", today && "font-semibold text-foreground")}>{weekday().format(d.date)}</span>
              {/* The short form ("5h 10m"): seven days across a phone. */}
              <span className="whitespace-nowrap font-semibold tabular">{(dayTotals[i] ?? 0) > 0 ? formatSeconds(dayTotals[i], { days: false }) : "–"}</span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-sm font-semibold capitalize">{label}</span>
          <span className="flex items-center gap-1">
            {!locked && entries.length > 0 && (
              <Checkbox
                className="m-1.5"
                aria-label={t("views.timesheet.week.selectDay", { label })}
                checked={entries.every(w => selected.has(w.id)) ? true : entries.some(w => selected.has(w.id)) ? "indeterminate" : false}
                onCheckedChange={() => onToggleDay(entries.map(w => w.id), !entries.every(w => selected.has(w.id)))}
              />
            )}
            {!locked && onAdd && (
              <Button variant="ghost" size="icon-sm" aria-label={t("views.timesheet.week.logOn", { label })} onClick={() => onAdd(day.date)}>
                <Plus className="h-4 w-4" />
              </Button>
            )}
            {!locked && day.key !== todayKey && entries.length > 0 && (
              <Button variant="ghost" size="icon-sm" aria-label={t("views.timesheet.week.duplicateLabel", { label })} disabled={busy} onClick={() => onDuplicate(day)}>
                <CopyPlus className="h-4 w-4" />
              </Button>
            )}
            <span className="font-semibold tabular">{formatDuration(total)}</span>
          </span>
        </div>
        {target > 0 && <Meter value={total} max={Math.max(target, total, 1)} size="xs" tone={goalTone(pct)} label={t("views.timesheet.week.goalOf", { label })} valueNow={pct} />}
      </div>
      {entries.length > 0 && (
        <ul className="divide-y border-t">
          {entries.map(w => (
            <li key={w.id}>
              <EntryRow w={w} locked={locked} selected={selected} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} showKey />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
