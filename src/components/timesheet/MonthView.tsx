import { formatDuration } from "@contracts/time";
import { cn } from "@/lib/utils";
import type { TimesheetLog } from "./WeekView";
import { Meter } from "@/components/app/Meter";
import { goalTone } from "@/lib/goalTone";
import { t, dateFormat } from "@/i18n";
import { workedSeconds } from "@/lib/worked";

/** Monday-first short weekday names, in the current language. */
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) => {
    const name = dateFormat({ weekday: "short" }).format(new Date(2024, 0, 1 + i));
    return name.charAt(0).toUpperCase() + name.slice(1);
  });
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
  return <Meter value={seconds} max={target} tone={goalTone(pct)} size="xs" />;
}

export function MonthView({
  cells,
  byDay,
  targetFor,
  todayKey,
  onOpenDay,
}: Props) {
  // The hours worked that day: parallel work once.
  const totalOf = (key: string) => workedSeconds(byDay.get(key) ?? []);

  return (
    <>
      {/* Mobile: simple list of the month's days */}
      <ul className="grid gap-1.5 sm:hidden">
        {cells
          .filter(c => c.inMonth)
          .map(c => {
            const total = totalOf(c.key);
            return (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => onOpenDay(c.date)}
                  className={cn(
                    "flex w-full flex-col gap-1.5 rounded-xl border bg-card p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    c.key === todayKey &&
                      "border-primary-strong/40 bg-primary-soft"
                  )}
                >
                  <span className="flex items-center justify-between text-body-sm">
                    <span className="capitalize">{long().format(c.date)}</span>
                    <span
                      className={cn(
                        "font-semibold tabular",
                        total === 0 && "font-normal text-muted-foreground"
                      )}
                    >
                      {formatDuration(total)}
                    </span>
                  </span>
                  <Fill seconds={total} target={targetFor(c.date)} />
                </button>
              </li>
            );
          })}
      </ul>

      {/* sm+: calendar grid */}
      <div className="hidden sm:block">
        <div className="mb-2 grid grid-cols-7 gap-2" aria-hidden>
          {weekdays().map(n => (
            <div
              key={n}
              className="px-1 text-overline uppercase text-muted-foreground"
            >
              {n}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-2">
          {cells.map(c => {
            const total = totalOf(c.key);
            const isToday = c.key === todayKey;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => onOpenDay(c.date)}
                aria-label={`${long().format(c.date)}: ${
                  total > 0 ? formatDuration(total) : t("views.timesheet.month.noEntries")
                }`}
                aria-current={isToday ? "date" : undefined}
                className={cn(
                  "flex min-h-20 flex-col justify-between rounded-xl border p-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  !c.inMonth && "bg-canvas text-muted-foreground",
                  isToday && "border-primary-strong/40 bg-primary-soft"
                )}
              >
                <span
                  className={cn(
                    "text-caption tabular",
                    isToday ? "font-semibold" : "text-muted-foreground"
                  )}
                >
                  {c.date.getDate()}
                </span>
                <span className="grid gap-1">
                  <span
                    className={cn(
                      "text-body-sm font-semibold tabular",
                      total === 0 && "font-normal text-muted-foreground"
                    )}
                  >
                    {formatDuration(total)}
                  </span>
                  <Fill seconds={total} target={targetFor(c.date)} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
