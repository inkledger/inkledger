import { useRef, useState } from "react";
import { formatDuration, formatSeconds } from "@contracts/time";
import { cn } from "@/lib/utils";
import type { TimesheetLog } from "./WeekView";
import { Meter } from "@/components/app/Meter";
import { surface } from "@/components/app/surface";
import { goalTone } from "@/lib/goalTone";
import { t, dateFormat } from "@/i18n";
import { workedSeconds } from "@/lib/worked";
import { capitalize } from "@/lib/dates";

/** Monday-first short weekday names, in the current language. */
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) => capitalize(dateFormat({ weekday: "short" }).format(new Date(2024, 0, 1 + i))));
const long = () => dateFormat({ weekday: "short", day: "numeric", month: "short" });

type Cell = { date: Date; key: string; inMonth: boolean };

type Props = {
  cells: Cell[];
  byDay: Map<string, TimesheetLog[]>;
  /** Expected seconds of a day (its schedule version) */
  targetFor: (day: Date) => number;
  todayKey: string;
  onOpenDay: (date: Date) => void;
};

function Fill({ seconds, target }: { seconds: number; target: number }) {
  const pct = target > 0 ? (seconds / target) * 100 : 0;
  return <Meter value={seconds} max={target} tone={goalTone(pct)} size="xs" lit />;
}

/**
 * The month as one calendar, whatever the width (docs/design-system.md §7.1): seven columns, each day its
 * hours and a fill against its goal; by its own width (a region) a narrow one shows the day number and
 * the short hours ("5h 10m") in 44 px cells, a wide one the full card. It was 30 stacked day cards on a
 * phone (about 1,750 px); now about 300. One Tab stop: the arrows move day to day, a week with up/down
 * (the ARIA grid pattern); Enter opens the day.
 */
export function MonthView({
  cells,
  byDay,
  targetFor,
  todayKey,
  onOpenDay,
}: Props) {
  // The hours worked that day: parallel work once.
  const totalOf = (key: string) => workedSeconds(byDay.get(key) ?? []);
  const grid = useRef<HTMLDivElement>(null);
  const todayAt = cells.findIndex(c => c.key === todayKey);
  const [active, setActive] = useState(todayAt >= 0 ? todayAt : Math.max(0, cells.findIndex(c => c.inMonth)));
  const at = Math.min(active, cells.length - 1);
  const move = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
    const to = step !== undefined ? at + step : event.key === "Home" ? at - (at % 7) : event.key === "End" ? at - (at % 7) + 6 : null;
    if (to === null || to < 0 || to >= cells.length) return;
    event.preventDefault();
    setActive(to);
    grid.current?.querySelectorAll<HTMLButtonElement>("[role=gridcell]")[to]?.focus();
  };

  return (
    <div className="region">
      <div className="mb-2 grid grid-cols-7 gap-1 @m:gap-2" aria-hidden>
        {weekdays().map(n => (
          <div key={n} className="px-1 text-center text-overline uppercase text-muted-foreground @m:text-left">
            {n}
          </div>
        ))}
      </div>
      <div ref={grid} role="grid" aria-label={t("views.timesheet.month.label")} onKeyDown={move} className="grid grid-cols-7 gap-1 @m:gap-2">
        {cells.map((c, index) => {
          const total = totalOf(c.key);
          const isToday = c.key === todayKey;
          return (
            <button
              key={c.key}
              type="button"
              role="gridcell"
              tabIndex={index === at ? 0 : -1}
              onFocus={() => setActive(index)}
              onClick={() => onOpenDay(c.date)}
              {...surface("control", { on: c.inMonth })}
              aria-label={`${long().format(c.date)}: ${total > 0 ? formatDuration(total) : t("views.timesheet.month.noEntries")}`}
              aria-current={isToday ? "date" : undefined}
              className={cn(
                "flex min-h-touch flex-col justify-between rounded-lg border p-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @m:min-h-20 @m:rounded-xl @m:p-2",
                !c.inMonth && "bg-canvas text-muted-foreground",
                isToday && "border-primary-strong/40 bg-primary-soft"
              )}
            >
              <span className={cn("text-caption tabular", isToday ? "font-semibold" : "text-muted-foreground")}>{c.date.getDate()}</span>
              <span className="grid gap-1">
                {/* Narrow: the short hours; wide: the full ones. */}
                <span className={cn("whitespace-nowrap text-2xs font-semibold tabular @m:hidden", total === 0 && "font-normal text-muted-foreground")}>
                  {total > 0 ? formatSeconds(total, { days: false }) : ""}
                </span>
                <span className={cn("hidden text-body-sm font-semibold tabular @m:inline", total === 0 && "font-normal text-muted-foreground")}>
                  {formatDuration(total)}
                </span>
                <Fill seconds={total} target={targetFor(c.date)} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
