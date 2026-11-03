import { flowControlProps, type FlowControlAttributes } from "@/lib/workspace/instrumentation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { keepPreviousData } from "@tanstack/react-query";
import { Lock, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { errorText } from "@/lib/errorText";
import { useAuth } from "@/hooks/useAuth";
import { useToday } from "@/hooks/useToday";
import { useUrlFields } from "@/hooks/useUrlState";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { int, oneOf, text, type Fields } from "@/lib/urlCodecs";
import { activePreset, presetRange, type PresetId } from "@/lib/reportLabel";
import { autoGranularity, BELOW, bucketsOf, coverageDelta, type Bucket, type Granularity } from "@contracts/team";
import { addDays, dayKey, formatDurationLong, parseDayKey } from "@contracts/time";
import { PageHeader } from "@/components/app/PageHeader";
import { PanelSection } from "@/components/app/Panel";
import { PeriodNav } from "@/components/app/PeriodNav";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { EmptyState, ErrorState } from "@/components/app/States";
import { lazyPart } from "@/components/app/lazyPart";
import { PeriodPicker } from "@/components/reports/PeriodPicker";
import { Delta, TeamMatrix, type MatrixRow } from "@/components/team/TeamMatrix";
import { cellsOf, freshnessNote, percent, STEP_CLASS, teamDays, type Person } from "@/components/team/model";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dateFormat, t } from "@/i18n";

const TeamDayBody = lazyPart(() => import("@/components/team/TeamDayBody").then(m => m.TeamDayBody));
const TeamPersonPanel = lazyPart(() => import("@/components/team/TeamPersonPanel").then(m => m.TeamPersonPanel));

type Sort = "hours" | "coverage" | "name" | "change";
type Show = "all" | "below" | "check";
type Cols = "auto" | Granularity;

/** Same cap as the server (team.overview reads a report's range). */
const REPORT_MAX_DAYS = 366;

/** The one line saying what the pointer or the focus is on: its own store, so a hover re-renders nothing else. */
function createReadout() {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  return {
    set: (next: string | null) => {
      if (next === current) return;
      current = next;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    get: () => current,
  };
}

function ReadoutLine({ store }: { store: ReturnType<typeof createReadout> }) {
  const said = useSyncExternalStore(store.subscribe, store.get, store.get);
  return (
    <p aria-live="polite" className={cn("min-h-5 truncate text-body-sm tabular", said ? "text-foreground" : "text-muted-foreground")}>
      {said ?? t("pages.team.readoutHint")}
    </p>
  );
}

/** A KPI: label, value, and what it adds; a filter when `onClick` is given. */
function Kpi({ label, value, extra, hint, onClick, pressed, control }: { label: string; value: string; extra?: React.ReactNode; hint?: string; onClick?: () => void; pressed?: boolean; control?: FlowControlAttributes }) {
  const body = (
    <>
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-display text-heading tabular">{value}</span>
        {extra}
      </span>
    </>
  );
  return onClick ? (
    <button
      type="button"
      title={hint}
      aria-pressed={pressed}
      onClick={onClick}
      {...control}
      className={cn("grid min-w-0 content-start gap-0.5 px-5 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", pressed && "bg-primary-soft/60")}
    >
      {body}
    </button>
  ) : (
    <div title={hint} className="grid min-w-0 content-start gap-0.5 px-5 py-3">
      {body}
    </div>
  );
}

/** Legend swatches, in the cells' own fills. */
function Legend() {
  const items: [string, string][] = [
    [STEP_CLASS.full, t("pages.team.legendFull")],
    [STEP_CLASS.high, t("pages.team.legendHigh")],
    [STEP_CLASS.mid, t("pages.team.legendMid")],
    [STEP_CLASS.low, t("pages.team.legendLow")],
    [STEP_CLASS.none, t("pages.team.legendNone")],
    [STEP_CLASS.absent, t("pages.team.legendAbsent")],
    ["border border-border", t("pages.team.legendOff")],
    [STEP_CLASS.future, t("pages.team.legendFuture")],
  ];

  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-muted-foreground">
      {items.map(([fill, label]) => (
        <li key={label} className="flex items-center gap-1.5 whitespace-nowrap">
          {/* surface: none — a legend swatch mirrors a flat heat cell */}
          <span aria-hidden className={cn("h-3 w-3 rounded-sm", fill)} />
          {label}
        </li>
      ))}
    </ul>
  );
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The team report (viewTeamTime): a heat map of everyone's logged hours
 * against their own schedule, a row per person and a column per day, week
 * or month; numbers stay secondary (KPIs, the totals column, the readout
 * line). A cell opens that day (or zooms into its days), a name opens the
 * person's period.
 */
export default function Team() {
  const today = useToday();
  const todayKey = dayKey(today);
  const now = today.getTime();
  const { user } = useAuth();
  const allowed = user?.permissions.includes("viewTeamTime") ?? false;
  const utils = trpc.useUtils();
  const [readout] = useState(createReadout);

  // The whole view lives in the URL: Back from a day or a person finds it as it was.
  const fields = useMemo(
    (): Fields<{ from: string; to: string; sort: Sort; show: Show; q: string; cols: Cols; person: number }> => ({
      from: { key: "from", fallback: dayKey(presetRange("month", today).from), codec: text },
      to: { key: "to", fallback: dayKey(presetRange("month", today).to), codec: text },
      sort: { key: "sort", fallback: "hours", codec: oneOf(["hours", "coverage", "name", "change"] as const) },
      show: { key: "show", fallback: "all", codec: oneOf(["all", "below", "check"] as const) },
      q: { key: "q", fallback: "", codec: text },
      cols: { key: "cols", fallback: "auto", codec: oneOf(["auto", "day", "week", "month"] as const) },
      person: { key: "person", fallback: 0, codec: int },
    }),
    [today]
  );
  const [shown, setShown] = useUrlFields(fields);
  const { from, to, sort, show, cols } = shown;
  const search = useDebouncedValue(shown.q.trim(), 200);
  const fromDate = useMemo(() => parseDayKey(from), [from]);
  const toDate = useMemo(() => parseDayKey(to), [to]);
  const ordered = fromDate !== null && toDate !== null && from <= to;
  const tooLong = ordered && addDays(fromDate, REPORT_MAX_DAYS) <= toDate;
  const rangeValid = ordered && !tooLong;

  const overview = trpc.team.overview.useQuery(
    { from, to, compare: true },
    { enabled: allowed && rangeValid, placeholderData: keepPreviousData }
  );
  // Taken away meanwhile: the menu learns it too.
  const forbidden = overview.error?.data?.code === "FORBIDDEN";
  useEffect(() => {
    if (forbidden) void utils.auth.me.invalidate();
  }, [forbidden, utils]);

  const [day, setDay] = useState<{ person: Person; day: Date } | null>(null);

  const kind: Granularity = useMemo(() => {
    if (cols !== "auto") return cols;
    if (!fromDate || !toDate) return "day";
    return autoGranularity(Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1);
  }, [cols, fromDate, toDate]);
  const buckets: Bucket[] = useMemo(
    () => (rangeValid && fromDate && toDate ? bucketsOf(fromDate, toDate, kind) : []),
    [rangeValid, fromDate, toDate, kind]
  );

  const data = overview.data;
  const all: MatrixRow[] = useMemo(
    () =>
      (data?.people ?? []).map(p => ({
        person: p,
        cells: cellsOf(p.days, buckets, todayKey),
        delta: coverageDelta(p.coverage, p.previous?.coverage ?? null),
        note: freshnessNote(p, now),
      })),
    [data, buckets, todayKey, now]
  );
  const below = useMemo(() => all.filter(r => r.person.coverage !== null && r.person.coverage < BELOW), [all]);
  const check = useMemo(() => all.filter(r => r.note !== null), [all]);
  const rows = useMemo(() => {
    const wanted = fold(search);
    const list = (show === "below" ? below : show === "check" ? check : all).filter(r => !wanted || fold(r.person.displayName).includes(wanted));
    const by: Record<Sort, (a: MatrixRow, b: MatrixRow) => number> = {
      hours: () => 0,
      // Nothing expected goes last: no share to rank by.
      coverage: (a, b) => (b.person.coverage ?? -1) - (a.person.coverage ?? -1),
      name: (a, b) => a.person.displayName.localeCompare(b.person.displayName),
      // The biggest drops first: what to look at.
      change: (a, b) => (a.delta ?? Infinity) - (b.delta ?? Infinity),
    };
    return [...list].sort((a, b) => by[sort](a, b) || b.person.loggedSeconds - a.person.loggedSeconds);
  }, [all, below, check, show, search, sort]);
  const team = useMemo(() => cellsOf(teamDays(data?.people ?? []), buckets, todayKey), [data, buckets, todayKey]);

  const onCell = useCallback(
    (row: MatrixRow, b: Bucket) => {
      if (b.kind === "day") return setDay({ person: row.person, day: b.from });
      setShown({ from: dayKey(b.from), to: dayKey(b.to), cols: "auto" });
    },
    [setShown]
  );
  // A person's panel is a step in history: Back closes it, and so does its own close (one step back).
  const navigate = useNavigate();
  const pushedPerson = useRef(false);
  const onPerson = useCallback(
    (row: MatrixRow) => {
      pushedPerson.current = true;
      setShown({ person: row.person.userId }, { push: true });
    },
    [setShown]
  );
  const closePerson = () => {
    if (pushedPerson.current) {
      pushedPerson.current = false;
      void navigate(-1);
    } else setShown({ person: 0 });
  };
  const onRead = useCallback((said: string | null) => readout.set(said), [readout]);

  // ‹ ›: a whole month moves by a month, any other range by its own length.
  const wholeMonth = !!fromDate && !!toDate && fromDate.getDate() === 1 && addDays(toDate, 1).getDate() === 1 && fromDate.getMonth() === toDate.getMonth();
  const shift = (dir: 1 | -1) => {
    if (!fromDate || !toDate) return;
    if (wholeMonth) {
      const y = fromDate.getFullYear();
      const m = fromDate.getMonth() + dir;
      return setShown({ from: dayKey(new Date(y, m, 1)), to: dayKey(new Date(y, m + 1, 0)) });
    }
    const length = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
    setShown({ from: dayKey(addDays(fromDate, dir * length)), to: dayKey(addDays(toDate, dir * length)) });
  };

  const preset = activePreset(from, to, today);
  const header = (
    <PageHeader
      sticky
      title={t("pages.team.title")}
      description={t("pages.team.description")}
      actions={
        allowed ? (
          <>
            <PeriodNav
              onPrev={() => shift(-1)}
              onNext={() => shift(1)}
              onToday={() => {
                const r = presetRange("month", today);
                setShown({ from: dayKey(r.from), to: dayKey(r.to) });
              }}
              isCurrent={from <= todayKey && todayKey <= to}
            />
            <PeriodPicker
              from={from}
              to={to}
              preset={preset}
              valid={rangeValid}
              onPreset={(id: PresetId) => {
                const r = presetRange(id, today);
                setShown({ from: dayKey(r.from), to: dayKey(r.to) });
              }}
              onFrom={v => setShown({ from: v })}
              onTo={v => setShown({ to: v })}
            />
          </>
        ) : undefined
      }
    />
  );

  if (!allowed || forbidden) {
    return (
      <>
        {header}
        <PanelSection>
          <EmptyState icon={Lock} title={t("pages.team.notAllowedTitle")} message={t("pages.team.notAllowedMessage")} />
        </PanelSection>
      </>
    );
  }
  if (!rangeValid) {
    return (
      <>
        {header}
        <PanelSection>
          <p role="alert" className="text-body-sm text-danger">
            {tooLong ? t("pages.reports.rangeTooLong", { max: REPORT_MAX_DAYS }) : t("pages.reports.rangeInvalid")}
          </p>
        </PanelSection>
      </>
    );
  }
  if (overview.error) {
    return (
      <>
        {header}
        <PanelSection>
          <ErrorState message={errorText(overview.error)} onRetry={() => void overview.refetch()} />
        </PanelSection>
      </>
    );
  }
  if (data && data.loggedSeconds === 0 && data.targetSeconds === 0) {
    return (
      <>
        {header}
        <PanelSection>
          <EmptyState art="chart" title={t("pages.team.emptyTitle")} message={t("pages.team.emptyMessage")} />
        </PanelSection>
      </>
    );
  }

  const selected = all.find(r => r.person.userId === shown.person) ?? null;
  const dayRow = day ? day.person.days.find(d => d.day === dayKey(day.day)) : undefined;

  return (
    // The page fills the panel and the matrix takes what is left (no height guessed from a toolbar of one row).
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      {header}
      {/* KPIs: one row divided by hairlines (2×2 on a phone); the two counts are filters. */}
      <div data-workspace-anchor="team.kpis" className="grid grid-cols-2 divide-border border-b lg:grid-cols-4 lg:divide-x max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*:nth-child(2n)]:border-l">
        {!data ? (
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="px-5 py-3">
              <Skeleton className="h-10 rounded-md" />
            </div>
          ))
        ) : (
          <>
            <Kpi
              label={t("pages.team.kpiCoverage")}
              value={data.coverage === null ? "—" : percent(data.coverage)}
              extra={<Delta value={coverageDelta(data.coverage, data.previous?.coverage ?? null)} />}
            />
            <Kpi
              label={t("pages.team.kpiLogged")}
              value={formatDurationLong(data.loggedSeconds)}
              extra={<span className="text-caption text-muted-foreground tabular">{t("pages.team.kpiLoggedOf", { target: formatDurationLong(data.targetSeconds) })}</span>}
            />
            <Kpi
              label={t("pages.team.kpiBelow")}
              value={String(below.length)}
              hint={t("pages.team.kpiBelowHint", { percent: percent(BELOW) })}
              pressed={show === "below"}
              onClick={() => setShown({ show: show === "below" ? "all" : "below" })}
              control={flowControlProps("team.kpi.below")}
            />
            <Kpi
              label={t("pages.team.kpiCheck")}
              value={String(check.length)}
              hint={t("pages.team.kpiCheckHint")}
              pressed={show === "check"}
              onClick={() => setShown({ show: show === "check" ? "all" : "check" })}
              control={flowControlProps("team.kpi.check")}
            />
          </>
        )}
      </div>
      <PanelSection variant="compact" className="grid gap-3 px-5 md:px-6 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col" anchorId="team.matrix">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-48 sm:max-w-64">
            <span className="sr-only">{t("pages.team.search")}</span>
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" value={shown.q} onChange={e => setShown({ q: e.target.value })} placeholder={t("pages.team.search")} className="pl-8" />
          </label>
          {/* Who is shown: the two KPI figures above are the filter (pressed), never a second control here. */}
          <SegmentedControl
            label={t("pages.team.sort")}
            value={sort}
            onChange={v => setShown({ sort: v })}
            options={[
              { value: "hours", label: t("pages.team.sortHours"), control: flowControlProps("team.sort.hours") },
              { value: "coverage", label: t("pages.team.sortCoverage"), control: flowControlProps("team.sort.coverage") },
              { value: "name", label: t("pages.team.sortName"), control: flowControlProps("team.sort.name") },
              { value: "change", label: t("pages.team.sortChange"), control: flowControlProps("team.sort.change") },
            ]}
          />
          <SegmentedControl
            label={t("pages.team.cols")}
            value={cols}
            onChange={v => setShown({ cols: v })}
            options={[
              { value: "auto", label: t("pages.team.colsAuto") },
              { value: "day", label: t("pages.team.colsDay") },
              { value: "week", label: t("pages.team.colsWeek") },
              { value: "month", label: t("pages.team.colsMonth") },
            ]}
          />
        </div>
        {/* What the cells' fills mean, next to them (not under a long list). */}
        <Legend />
        <ReadoutLine store={readout} />
        {!data ? (
          <Skeleton className="h-96 rounded-xl" />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t("pages.team.nobody")}
            message={t("pages.team.nobodyMessage")}
            action={
              <Button variant="outline" onClick={() => setShown({ show: "all", q: "" })}>
                {t("pages.team.showEveryone")}
              </Button>
            }
          />
        ) : (
          <div aria-busy={overview.isPlaceholderData} className={cn("min-w-0 transition-opacity lg:flex lg:min-h-0 lg:flex-1 lg:flex-col", overview.isPlaceholderData && "opacity-60")}>
            <TeamMatrix
              rows={rows}
              team={team}
              buckets={buckets}
              kind={kind}
              today={todayKey}
              compare={data.previous !== null}
              onCell={onCell}
              onPerson={onPerson}
              onRead={onRead}
            />
          </div>
        )}
        <p className="text-caption text-muted-foreground">{t("pages.team.limits")}</p>
      </PanelSection>

      <Sheet open={selected !== null} onOpenChange={o => !o && closePerson()}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
          {selected && (
            <TeamPersonPanel
              person={selected.person}
              from={from}
              to={to}
              today={todayKey}
              note={selected.note}
              delta={selected.delta}
              onDay={d => setDay({ person: selected.person, day: d })}
            />
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={day !== null} onOpenChange={o => !o && setDay(null)}>
        <DialogContent className="sm:max-w-3xl">
          {day && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t("pages.team.dayTitle", {
                    name: day.person.displayName,
                    date: dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(day.day),
                  })}
                </DialogTitle>
                <DialogDescription>
                  {t("pages.team.dayDescription", {
                    logged: formatDurationLong(dayRow?.loggedSeconds ?? 0),
                    target: formatDurationLong(dayRow?.targetSeconds ?? 0),
                  })}
                </DialogDescription>
              </DialogHeader>
              <TeamDayBody userId={day.person.userId} day={day.day} dayKey={dayKey(day.day)} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
