import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { dayKey, formatDuration, formatSeconds } from "@contracts/time";
import { matrixDays } from "@/lib/matrixDays";
import { Button } from "@/components/ui/button";
import { Meter } from "@/components/app/Meter";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { projectOf } from "@/lib/projectColors";
import { goalTone } from "@/lib/goalTone";
import { issuePath } from "@/lib/issues";
import { nextIndex } from "@/lib/roving";
import { dayMonth } from "@/lib/dates";
import { splitLabel, type ReportRow } from "@/lib/reportLabel";
import { cn } from "@/lib/utils";
import { t, dateFormat } from "@/i18n";
import type { ReportDay } from "./ReportDays";

/** Rows shown before "Show all": the busiest issues of the range. */
const MATRIX_FIRST = 12;

const weekday = () => dateFormat({ weekday: "narrow" });

/**
 * The range as a read-only grid of issues × days (the Timesheet's week grid, docs/design-system.md §7.1): one
 * Tab stop and arrows between cells, each cell named with its hours; the row's total and entries at its end,
 * the day's total and its goal in the foot. The busiest issues first, then all of them on request.
 */
export function ReportMatrix({ days, issues, targetFor }: { days: ReportDay[]; issues: ReportRow[]; targetFor: (d: Date) => number }) {
  const table = useRef<HTMLTableElement>(null);
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const [all, setAll] = useState(false);
  const dates = matrixDays(days);
  const byDay = new Map(days.map(d => [d.day, d]));
  const secondsOn = (row: ReportRow, key: string) => byDay.get(key)?.issues.find(i => (i.id ?? i.key) === (row.id ?? row.key))?.seconds ?? 0;
  const rows = [...issues].sort((a, b) => b.seconds - a.seconds);
  const shown = all ? rows : rows.slice(0, MATRIX_FIRST);
  const columns = dates.length + 1;
  const at: [number, number] = [Math.min(active[0], Math.max(0, shown.length - 1)), Math.min(active[1], columns - 1)];
  const tab = (r: number, c: number) => (at[0] === r && at[1] === c ? 0 : -1);
  const move = (event: KeyboardEvent<HTMLTableElement>) => {
    const [r, c] = at;
    let next: [number, number] | null = null;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const to = r + (event.key === "ArrowDown" ? 1 : -1);
      if (to >= 0 && to < shown.length) next = [to, c];
    } else {
      const to = nextIndex(c, columns, event);
      if (to !== null) next = [r, to];
    }
    if (!next) return;
    event.preventDefault();
    setActive(next);
    table.current?.querySelector<HTMLElement>(`[data-cell="${next[0]},${next[1]}"]`)?.focus();
  };
  const today = dayKey(new Date());
  return (
    <div className="grid gap-2">
      <div data-overflow-ok className="overflow-x-auto">
        <table ref={table} role="grid" aria-label={t("views.reports.days.matrix")} onKeyDown={move} className="w-full table-fixed border-separate border-spacing-0 text-body-sm" style={{ minWidth: `${14 + dates.length * 3.5 + 6}rem` }}>
          <colgroup>
            {/* The days a fixed width, the issue's column the rest: a short range reads more of each summary. */}
            <col />
            {dates.map(d => <col key={dayKey(d)} className="w-14" />)}
            <col className="w-24" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 border-b bg-card px-2 pb-2 text-left text-caption font-medium text-muted-foreground">{t("views.timesheet.grid.issue")}</th>
              {dates.map(d => {
                const key = dayKey(d);
                const off = targetFor(d) === 0;
                return (
                  <th key={key} scope="col" aria-current={key === today ? "date" : undefined} aria-label={`${dateFormat({ weekday: "long" }).format(d)} ${dayMonth(d)}`} className={cn("border-b px-0.5 pb-2 text-center text-caption font-medium", key === today ? "text-primary-strong" : "text-muted-foreground", off && "bg-muted/40")}>
                    <span aria-hidden className="block capitalize">{weekday().format(d)}</span>
                    <span aria-hidden className="block tabular">{d.getDate()}</span>
                  </th>
                );
              })}
              <th scope="col" className="border-b px-2 pb-2 text-right text-caption font-medium text-muted-foreground">{t("views.timesheet.grid.total")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => {
              const { head, tail } = splitLabel(row.label);
              return (
                <tr key={row.id ?? row.key}>
                  <th scope="row" className="sticky left-0 z-10 min-w-0 border-b bg-card px-2 py-1.5 text-left font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <ProjectAvatar project={projectOf(row.key)} size="xs" />
                      <span className="grid min-w-0">
                        <Link data-cell={`${r},0`} tabIndex={tab(r, 0)} onFocus={() => setActive([r, 0])} to={issuePath({ key: row.key, connectionId: row.connectionId, remoteId: row.remoteId })} className="truncate font-medium underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {head}
                        </Link>
                        {tail && <span className="truncate text-caption text-muted-foreground">{tail}</span>}
                      </span>
                    </span>
                  </th>
                  {dates.map((d, c) => {
                    const key = dayKey(d);
                    const seconds = secondsOn(row, key);
                    return (
                      <td
                        key={key}
                        role="gridcell"
                        data-cell={`${r},${c + 1}`}
                        tabIndex={tab(r, c + 1)}
                        onFocus={() => setActive([r, c + 1])}
                        aria-label={`${head}, ${dateFormat({ weekday: "long" }).format(d)} ${dayMonth(d)}: ${seconds > 0 ? formatDuration(seconds) : t("views.reports.days.none")}`}
                        className={cn("whitespace-nowrap border-b px-0.5 py-1.5 text-center tabular outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", targetFor(d) === 0 && "bg-muted/40", seconds === 0 && "text-muted-foreground/50")}
                      >
                        {seconds > 0 ? formatSeconds(seconds, { days: false }) : "·"}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap border-b px-2 text-right tabular">
                    <span className="font-semibold">{formatDuration(row.seconds)}</span>
                    <span className="block text-caption text-muted-foreground">{t("views.reports.days.entries", { count: row.entries })}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-card px-2 pt-2 text-left align-top text-caption font-medium text-muted-foreground">{t("views.timesheet.grid.dayTotal")}</th>
              {dates.map(d => {
                const key = dayKey(d);
                const seconds = byDay.get(key)?.seconds ?? 0;
                const target = targetFor(d);
                const pct = target > 0 ? Math.round((seconds / target) * 100) : 0;
                return (
                  <td key={key} className="px-0.5 pt-2 align-top">
                    <span className="block whitespace-nowrap text-center font-semibold tabular">{seconds > 0 ? formatSeconds(seconds, { days: false }) : "–"}</span>
                    {target > 0 && <Meter value={seconds} max={Math.max(target, seconds, 1)} size="xs" tone={goalTone(pct)} label={t("views.timesheet.week.goalOf", { label: dayMonth(d) })} valueNow={pct} className="mt-1" />}
                  </td>
                );
              })}
              <td className="whitespace-nowrap px-2 pt-2 text-right align-top font-semibold tabular">{formatDuration(days.reduce((sum, d) => sum + d.seconds, 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {rows.length > MATRIX_FIRST && (
        <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={all} onClick={() => setAll(v => !v)}>
          {all ? t("ui.collection.showFewer") : t("ui.collection.showAll", { count: rows.length })}
        </Button>
      )}
    </div>
  );
}
