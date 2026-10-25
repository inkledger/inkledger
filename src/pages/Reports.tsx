import { errorText } from "@/lib/errorText";
import { keepPreviousData } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { ViewScope } from "@/components/ViewScope";
import { useMemo } from "react";
import { useToday } from "@/hooks/useToday";
import { Briefcase, CalendarDays, CalendarRange, Download, FolderKanban, ListChecks } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { addDays, dayKey, formatDuration, formatDurationLong, parseDayKey, hoursDecimal } from "@contracts/time";
import { downloadCsv } from "@/lib/csv";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelRow, PanelSection } from "@/components/app/Panel";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodBars, type DayStack } from "@/components/dashboard/PeriodBars";
import {
  QuickStatsCard,
  type Stat,
} from "@/components/dashboard/QuickStatsCard";
import { ReportRows } from "@/components/reports/ReportRows";
import { ReportDays } from "@/components/reports/ReportDays";
import { PeriodPicker } from "@/components/reports/PeriodPicker";
import {
  activePreset,
  presetRange,
  rowLabel,
  splitLabel,
  type GroupBy,
  type PresetId,
  type ReportRow,
} from "@/lib/reportLabel";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { useUrlFields } from "@/hooks/useUrlState";
import { flag, oneOf, text, type Fields } from "@/lib/urlCodecs";
import { t } from "@/i18n";

/** Detail views: a grouping, or the day-by-day breakdown by issue. */
type View = GroupBy | "days";

const groupOptions = (): {
  value: View;
  label: string;
  icon: typeof CalendarDays;
}[] => [
  { value: "day", label: t("pages.reports.groupDay"), icon: CalendarDays },
  { value: "issue", label: t("pages.reports.groupIssue"), icon: ListChecks },
  { value: "project", label: t("pages.reports.groupProject"), icon: FolderKanban },
  { value: "client", label: t("pages.reports.groupClient"), icon: Briefcase },
  { value: "days", label: t("pages.reports.groupDays"), icon: CalendarRange },
];

const REPORT_MAX_DAYS = 366;

/** Row count of a grouping, or its loading / failed state. */
function countStat(
  label: string,
  q: { data?: { rows: unknown[] }; error: unknown; refetch: () => unknown }
): Stat {
  if (q.data) return { label, value: String(q.data.rows.length) };
  if (q.error) {
    return { label, value: t("pages.reports.error"), tone: "danger", onRetry: () => q.refetch() };
  }
  return { label, value: "…" };
}

const CHART_COLOR = () => ({ fill: "bg-chart-focus", soft: "", solid: "", stroke: "" });

export default function Reports() {
  const now = useToday();
  // Period and grouping live in the URL (Back from an issue finds them).
  const fields = useMemo(
    (): Fields<{ from: string; to: string; groupBy: View; all: boolean; search: string }> => ({
      // D9: the device's bucket, unless All is on; a search on the worklogs' issues.
      all: { key: "all", fallback: false, codec: flag },
      search: { key: "q", fallback: "", codec: text },
      // This month, the very range its preset picks (so the picker names it).
      from: { key: "from", fallback: dayKey(presetRange("month", now).from), codec: text },
      to: { key: "to", fallback: dayKey(presetRange("month", now).to), codec: text },
      groupBy: { key: "group", fallback: "day", codec: oneOf(["day", "issue", "project", "client", "days"] as const) },
    }),
    [now]
  );
  const [shown, setShown] = useUrlFields(fields);
  const { from, to, groupBy } = shown;
  const search = useDebouncedValue(shown.search.trim(), 300);
  const scope = { scope: shown.all ? ("all" as const) : ("bucket" as const), ...(search ? { search } : {}) };
  const setFrom = (v: string) => setShown({ from: v });
  const setTo = (v: string) => setShown({ to: v });
  const setGroupBy = (v: View) => setShown({ groupBy: v });

  const fromDate = parseDayKey(from);
  const toDate = parseDayKey(to);
  const rangeOrdered = fromDate !== null && toDate !== null && from <= to;
  // Same cap as the server (reports.generate): a leap year.
  const rangeTooLong =
    rangeOrdered && addDays(fromDate, REPORT_MAX_DAYS) <= toDate;
  const rangeValid = rangeOrdered && !rangeTooLong;
  const enabled = { enabled: rangeValid, placeholderData: keepPreviousData };
  // One query per grouping: the selected one feeds the table, "day" the
  // chart, and the row counts of the others give issues / projects.
  const byDay = trpc.reports.generate.useQuery(
    { from, to, groupBy: "day", ...scope },
    enabled
  );
  const byIssue = trpc.reports.generate.useQuery(
    { from, to, groupBy: "issue", ...scope },
    enabled
  );
  const byProject = trpc.reports.generate.useQuery(
    { from, to, groupBy: "project", ...scope },
    enabled
  );
  const byClient = trpc.reports.generate.useQuery(
    { from, to, groupBy: "client", ...scope },
    { ...enabled, enabled: enabled.enabled && groupBy === "client" }
  );
  const daily = trpc.reports.daily.useQuery(
    { from, to, ...scope },
    { enabled: rangeValid && groupBy === "days" }
  );
  // The days view totals by issue, like the issue grouping.
  const report =
    groupBy === "day" ? byDay : groupBy === "project" ? byProject : groupBy === "client" ? byClient : byIssue;
  const { targetFor } = useWorkSchedule();

  const applyPreset = (id: PresetId) => {
    const r = presetRange(id, now);
    setShown({ from: dayKey(r.from), to: dayKey(r.to) });
  };

  const days = useMemo(() => {
    const list: Date[] = [];
    const a = parseDayKey(from);
    const b = parseDayKey(to);
    if (a && b && from <= to) {
      for (let d = a; d <= b; d = addDays(d, 1)) list.push(d);
    }
    return list;
  }, [from, to]);

  const stacks: DayStack[] = useMemo(() => {
    const secs = new Map((byDay.data?.rows ?? []).map(r => [r.key, r.seconds]));
    return days.map(day => ({
      day,
      parts: [{ project: "_", seconds: secs.get(dayKey(day)) ?? 0 }],
    }));
  }, [days, byDay.data]);

  const data = report.data;
  const workedDays = (byDay.data?.rows ?? []).filter(r => r.seconds > 0).length;
  // Same definition as the Timesheet: average over the days actually worked.
  const perWorkingDay =
    data && workedDays > 0 ? data.totalSeconds / workedDays : 0;

  const hours = hoursDecimal;

  // What the export writes must be there: the days themselves for "Days" (not the issues' totals).
  const exportable =
    groupBy === "days"
      ? !!daily.data && daily.data.days.some(d => d.issues.length > 0)
      : !!data && data.rows.length > 0;

  const exportDaysCsv = () => {
    if (!daily.data) return;
    const line = (day: string, r: ReportRow) => [
      day,
      r.key,
      splitLabel(r.label).tail ?? "",
      hours(r.seconds),
      Math.round(r.seconds / 60),
      r.entries,
      // New columns go last (T11): older sheets keep reading the first ones.
      r.tracker ?? "",
      r.container ?? "",
    ];
    downloadCsv(
      `report-days-${from}-${to}.csv`,
      [
        t("pages.reports.csvDay"),
        t("pages.reports.csvIssue"),
        t("pages.reports.csvSummary"),
        t("pages.reports.csvHours"),
        t("pages.reports.csvMinutes"),
        t("pages.reports.csvEntries"),
        t("pages.reports.csvTracker"),
        t("pages.reports.csvContainer"),
      ],
      [
        ...daily.data.days.flatMap(d => d.issues.map(r => line(d.day, r))),
        ...daily.data.issues.map(r => line(t("pages.reports.csvRangeTotal"), r)),
      ]
    );
  };

  const exportCsv = () => {
    if (groupBy === "days") return exportDaysCsv();
    if (!data) return;
    downloadCsv(
      `report-${from}-${to}.csv`,
      [
        t("pages.reports.csvGroup"),
        t("pages.reports.csvHours"),
        t("pages.reports.csvMinutes"),
        t("pages.reports.csvEntries"),
        ...(groupBy === "issue" ? [t("pages.reports.csvTracker"), t("pages.reports.csvContainer")] : []),
      ],
      data.rows.map((r: ReportRow) => [
        // Days as ISO dates: sortable, and unambiguous across years.
        groupBy === "day" ? r.key : rowLabel(groupBy, r),
        hours(r.seconds),
        Math.round(r.seconds / 60),
        r.entries,
        ...(groupBy === "issue" ? [r.tracker ?? "", r.container ?? ""] : []),
      ])
    );
  };

  const preset = activePreset(from, to, now);

  const pageHeader = (
    <PageHeader
      sticky
      title={t("pages.reports.title")}
      description={t("pages.reports.description")}
      actions={
        <>
          <PeriodPicker
            from={from}
            to={to}
            preset={preset}
            valid={rangeValid}
            onPreset={applyPreset}
            onFrom={setFrom}
            onTo={setTo}
          />
          <Button
            variant="outline"
            onClick={exportCsv}
            disabled={!exportable}
          >
            <Download className="h-4 w-4" />
            {t("pages.reports.exportCsv")}
          </Button>
        </>
      }
    />
  );
  const header = (
    <>
      {pageHeader}
      <ViewScope
        all={shown.all}
        onAll={all => setShown({ all })}
        search={shown.search}
        onSearch={s => setShown({ search: s })}
        unsupported={byDay.data?.query.unsupported}
      />
    </>
  );

  if (!rangeValid) {
    return (
      <>
        {header}
        <PanelSection>
          <p role="alert" className="text-body-sm text-danger">
            {rangeTooLong
              ? t("pages.reports.rangeTooLong", { max: REPORT_MAX_DAYS })
              : t("pages.reports.rangeInvalid")}
          </p>
        </PanelSection>
      </>
    );
  }

  const failed = report.error ?? byDay.error ?? (groupBy === "days" ? daily.error : null);
  const loading =
    report.isPending || byDay.isPending || (groupBy === "days" && daily.isPending);

  if (failed) {
    return (
      <>
        {header}
        <PanelSection>
          <ErrorState
            message={errorText(failed)}
            onRetry={() => {
              void report.refetch();
              void byDay.refetch();
              if (groupBy === "days") void daily.refetch();
            }}
          />
        </PanelSection>
      </>
    );
  }

  if (!loading && data?.rows.length === 0) {
    return (
      <>
        {header}
        <PanelSection>
          <EmptyState
            art="chart"
            title={t("pages.reports.emptyTitle")}
            message={t("pages.reports.emptyMessage")}
          />
        </PanelSection>
      </>
    );
  }

  return (
    <>
      {header}
      <PanelRow className="xl:grid-cols-[minmax(0,1fr)_340px]">
        <PanelSection title={t("pages.reports.trend")}>
          {loading ? (
            <Skeleton className="h-52 rounded-xl" />
          ) : (
            <PeriodBars
              stacks={stacks}
              colorOf={CHART_COLOR}
              targetFor={targetFor}
              dense={days.length > 10}
            />
          )}
        </PanelSection>
        <div className="min-w-0 p-5 md:p-6 xl:pl-0">
          {loading || !data ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <QuickStatsCard
              title={t("pages.reports.period")}
              stats={[
                {
                  label: t("pages.reports.total"),
                  value: formatDuration(data.totalSeconds),
                },
                { label: t("pages.reports.entries"), value: String(data.totalEntries) },
              ]}
              extra={[
                {
                  label: t("pages.reports.avgPerDay"),
                  value: formatDurationLong(perWorkingDay),
                },
                { label: t("pages.reports.daysWorked"), value: String(workedDays) },
                countStat(t("pages.reports.issues"), byIssue),
                countStat(t("pages.reports.projects"), byProject),
                // Parallel work: the entries add up to more than the hours worked.
                ...(data.loggedSeconds > data.totalSeconds
                  ? [{ label: t("pages.reports.parallel"), value: formatDuration(data.loggedSeconds - data.totalSeconds) }]
                  : []),
              ]}
            />
          )}
        </div>
      </PanelRow>
      <PanelSection
        title={t("pages.reports.detail")}
        actions={
          <SegmentedControl
            label={t("pages.reports.groupBy")}
            value={groupBy}
            onChange={setGroupBy}
            options={groupOptions()}
          />
        }
      >
        {loading || !data || (groupBy === "days" && !daily.data) ? (
          <div className="grid gap-2">
            {[0, 1, 2, 3].map(i => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : groupBy === "days" ? (
          <ReportDays
            days={daily.data?.days ?? []}
            issues={daily.data?.issues ?? []}
            targetFor={targetFor}
          />
        ) : (
          <ReportRows key={groupBy} rows={data.rows} groupBy={groupBy} />
        )}
      </PanelSection>
    </>
  );
}
