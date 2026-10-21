import { Link } from "react-router";
import { formatDuration, parseDayKey } from "@contracts/time";
import { rowLabel, splitLabel, type ReportRow } from "@/lib/reportLabel";
import { projectOf } from "@/lib/projectColors";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Meter } from "@/components/app/Meter";
import { ReportRows } from "@/components/reports/ReportRows";
import { t } from "@/i18n";
import { issuePath } from "@/lib/issues";

export type ReportDay = {
  day: string;
  seconds: number;
  entries: number;
  issues: ReportRow[];
};

function IssueLine({ row }: { row: ReportRow }) {
  const { head, tail } = splitLabel(row.label);
  return (
    <li className="flex items-center gap-3 py-2">
      <ProjectAvatar project={projectOf(row.key)} />
      <div className="min-w-0 flex-1">
        <Link
          to={issuePath({ key: row.key, connectionId: row.connectionId, remoteId: row.remoteId })}
          className="font-semibold underline-offset-4 hover:underline"
        >
          {head}
        </Link>
        {tail && (
          <span className="ml-2 truncate text-body-sm text-muted-foreground max-sm:block max-sm:ml-0">
            {tail}
          </span>
        )}
      </div>
      <span className="shrink-0 text-body-sm tabular">
        <span className="font-medium">{formatDuration(row.seconds)}</span>
        <span className="text-muted-foreground"> · {row.entries}</span>
      </span>
    </li>
  );
}

function DayCard({
  day,
  targetFor,
}: {
  day: ReportDay;
  targetFor: (d: Date) => number;
}) {
  const date = parseDayKey(day.day);
  const target = date ? targetFor(date) : 0;
  const label = rowLabel("day", { key: day.day, label: day.day, seconds: 0, entries: 0 });
  return (
    <section
      aria-label={label}
      className="rounded-xl border bg-card px-4 py-3"
    >
      <header className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-semibold capitalize">{label}</h3>
          <span className="text-body-sm tabular">
            <span className="font-semibold">{formatDuration(day.seconds)}</span>
            {target > 0 && (
              <span className="text-muted-foreground">
                {" "}
                {t("views.reports.days.ofTarget", { target: formatDuration(target) })}
              </span>
            )}
          </span>
        </div>
        <Meter
          value={day.seconds}
          max={Math.max(day.seconds, target)}
          marker={target > 0 ? target : undefined}
          tone="bg-chart-focus"
          size="sm"
        />
      </header>
      <ul className="mt-1 divide-y">
        {day.issues.map(r => (
          <IssueLine key={r.id ?? r.key} row={r} />
        ))}
      </ul>
    </section>
  );
}

/** Day-by-day breakdown (issues merged per day) and the range totals by issue. */
export function ReportDays({
  days,
  issues,
  targetFor,
}: {
  days: ReportDay[];
  issues: ReportRow[];
  targetFor: (d: Date) => number;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <h3 className="text-body-sm font-medium text-muted-foreground">
          {t("views.reports.days.perDay")}
        </h3>
        <div className="grid gap-3 lg:grid-cols-2">
          {days.map(d => (
            <DayCard key={d.day} day={d} targetFor={targetFor} />
          ))}
        </div>
      </div>
      <div className="grid gap-3">
        <h3 className="text-body-sm font-medium text-muted-foreground">
          {t("views.reports.days.rangeTotal")}
        </h3>
        <ReportRows rows={issues} groupBy="issue" />
      </div>
    </div>
  );
}
