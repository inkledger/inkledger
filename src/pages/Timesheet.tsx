import { keepPreviousData } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { ViewScope } from "@/components/ViewScope";
import { useMemo, useState } from "react";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { useBlockPlacement } from "@/hooks/useBlockPlacement";
import { useToday } from "@/hooks/useToday";
import {
  CalendarDays,
  CalendarRange,
  Download,
  Lock,
  LockOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { useUrlFields } from "@/hooks/useUrlState";
import { day, flag, oneOf, text, type Fields } from "@/lib/urlCodecs";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  addDays,
  dayKey,
  formatDurationLong,
  formatDuration,
  parseDayKey,
  startOfWeek,
} from "@contracts/time";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import { useWorklogSelection } from "@/hooks/useWorklogSelection";
import { usePendingSeconds } from "@/hooks/useTimers";
import { downloadCsv } from "@/lib/csv";
import { issueId } from "@/lib/issues";
import { projectOf, rankProjects } from "@/lib/projectColors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { PageHeader } from "@/components/app/PageHeader";
import { PeriodNav } from "@/components/app/PeriodNav";
import { PanelRow, PanelSection } from "@/components/app/Panel";
import { QuickLog } from "@/components/QuickLog";
import { PeriodBars, type DayStack } from "@/components/dashboard/PeriodBars";
import {
  PeriodSummary,
  type IssueTotal,
} from "@/components/dashboard/PeriodSummary";
import { QuickStatsCard } from "@/components/dashboard/QuickStatsCard";
import { EmptyState, ErrorState } from "@/components/app/States";
import { LogTimeDialog } from "@/components/LogTimeDialog";
import { WeekView, type TimesheetLog } from "@/components/timesheet/WeekView";
import { MonthView } from "@/components/timesheet/MonthView";
import { Chip } from "@/components/app/Chip";
import { useConnections, useProviderName } from "@/hooks/useConnections";
import { dateFormat, t } from "@/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TrashDialog } from "@/components/timesheet/TrashDialog";
import { workedSeconds } from "@/lib/worked";

type View = "week" | "month";

const viewOptions = () => [
  { value: "week" as const, label: t("pages.timesheet.viewWeek"), icon: CalendarRange },
  { value: "month" as const, label: t("pages.timesheet.viewMonth"), icon: CalendarDays },
];

const shortDay = () => dateFormat({ day: "numeric", month: "long" });
const monthYear = () => dateFormat({ month: "long", year: "numeric" });
const dateNumeric = () => dateFormat({ day: "2-digit", month: "2-digit", year: "numeric" });
const logDayFormat = () => dateFormat({ weekday: "short", day: "numeric", month: "short" });

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Confirm =
  | { type: "delete"; log: TimesheetLog }
  | { type: "bulk" }
  | { type: "duplicate"; key: string; date: Date };

export default function Timesheet() {
  const [trashOpen, setTrashOpen] = useState(false);
  const provider = useProviderName();
  const today = useToday();
  const todayKey = dayKey(today);
  // View and the day shown live in the URL (Back finds the same week).
  const fields = useMemo(
    (): Fields<{ view: View; anchor: Date; all: boolean; search: string }> => ({
      view: { key: "view", fallback: "week", codec: oneOf(["week", "month"] as const) },
      // D9: the device's bucket, unless All is on; a search on the worklogs' issues.
      all: { key: "all", fallback: false, codec: flag },
      search: { key: "q", fallback: "", codec: text },
      // Any local day inside the period on screen.
      anchor: { key: "day", fallback: today, codec: day },
    }),
    [today]
  );
  const [shown, setShown] = useUrlFields(fields);
  const { view, anchor } = shown;
  const search = useDebouncedValue(shown.search.trim(), 300);
  const setAnchor = (d: Date) => setShown({ anchor: d });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [editing, setEditing] = useState<TimesheetLog | null>(null);
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  /** Day picked from an empty card ("+"); null = now. */
  const [logDay, setLogDay] = useState<Date | null>(null);
  const [pickOpen, setPickOpen] = useState(false);

  const invalidate = useInvalidateWorklogs();
  const utils = trpc.useUtils();

  // --- period ---
  const period = useMemo(() => {
    if (view === "week") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7), fetchFrom: from };
    }
    const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return { from, to, fetchFrom: startOfWeek(from) };
  }, [view, anchor]);
  const fetchTo = useMemo(
    () =>
      view === "week"
        ? period.to
        : addDays(startOfWeek(addDays(period.to, -1)), 7),
    [view, period.to]
  );
  const periodKey = `${view}:${dayKey(period.from)}`;
  const currentStart =
    view === "week"
      ? startOfWeek(today)
      : new Date(today.getFullYear(), today.getMonth(), 1);
  const isCurrent = dayKey(period.from) === dayKey(currentStart);
  const pendingNow = usePendingSeconds();
  const pending = isCurrent ? pendingNow : undefined;

  const title =
    view === "week"
      ? t("pages.timesheet.weekTitle", {
          from: shortDay().format(period.from),
          to: shortDay().format(addDays(period.to, -1)),
        })
      : capitalize(monthYear().format(period.from));

  const step = (dir: 1 | -1) =>
    setAnchor(
      view === "week"
        ? addDays(period.from, dir * 7)
        : new Date(period.from.getFullYear(), period.from.getMonth() + dir, 1)
    );
  const switchView = (v: View) => setShown({ view: v, anchor: today });

  // --- data ---
  const issues = trpc.issues.all.useQuery();
  const logs = trpc.worklogs.list.useQuery(
    {
      from: period.fetchFrom.toISOString(),
      to: fetchTo.toISOString(),
      scope: shown.all ? "all" : "bucket",
      ...(search ? { search } : {}),
    },
    { placeholderData: keepPreviousData }
  );
  // Targets come from the work schedule in force on each day.
  const { targetFor } = useWorkSchedule();
  // Where "Duplicate on today" may go: today's worklogs and timers.
  const todayPlacement = useBlockPlacement();

  const summaries = useMemo(
    () =>
      new Map(
        (issues.data ?? []).map(i => [
          issueId(i),
          { summary: i.summary, remoteId: i.remoteId, projectKey: i.projectKey },
        ])
      ),
    [issues.data]
  );
  const connections = useConnections();
  const byDay = useMemo(() => {
    const map = new Map<string, TimesheetLog[]>();
    for (const w of logs.data ?? []) {
      const key = dayKey(new Date(w.started));
      const list = map.get(key);
      if (list) list.push(w);
      else map.set(key, [w]);
    }
    return map;
  }, [logs.data]);

  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const date = addDays(period.from, i);
        return { date, key: dayKey(date) };
      }),
    [period.from]
  );
  const monthCells = useMemo(() => {
    const count = Math.round(
      (fetchTo.getTime() - period.fetchFrom.getTime()) / (7 * 86400000)
    );
    return Array.from({ length: count * 7 }, (_, i) => {
      const date = addDays(period.fetchFrom, i);
      return {
        date,
        key: dayKey(date),
        inMonth: date.getMonth() === period.from.getMonth(),
      };
    });
  }, [period, fetchTo]);

  const periodLogs = useMemo(() => {
    const days = view === "week" ? weekDays : monthCells.filter(c => c.inMonth);
    return days.flatMap(d => byDay.get(d.key) ?? []);
  }, [view, weekDays, monthCells, byDay]);
  // The hours worked (parallel work once); the entries' sum beside it when they differ.
  const periodTotal = workedSeconds(periodLogs);
  const periodLogged = periodLogs.reduce((a, w) => a + w.timeSpentSeconds, 0);
  const target = (
    view === "week" ? weekDays : monthCells.filter(c => c.inMonth)
  ).reduce((a, d) => a + targetFor(d.date), 0);

  const { colorOf, legend, count: projectCount } = useMemo(() => {
    const totals = new Map<string, number>();
    for (const w of periodLogs) {
      const p = projectOf(w.issueKey);
      totals.set(p, (totals.get(p) ?? 0) + w.timeSpentSeconds);
    }
    return rankProjects(totals);
  }, [periodLogs]);

  const issueTotals = useMemo<IssueTotal[]>(() => {
    const map = new Map<string, IssueTotal>();
    for (const w of periodLogs) {
      const id = issueId(w);
      const entry = map.get(id) ?? {
        issueKey: w.issueKey,
        connectionId: w.connectionId,
        seconds: 0,
      };
      entry.seconds += w.timeSpentSeconds;
      map.set(id, entry);
    }
    return [...map.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 5)
      .map(total => {
        const info = summaries.get(issueId(total));
        return { ...total, summary: info?.summary, remoteId: info?.remoteId };
      });
  }, [periodLogs, summaries]);

  const stacks = useMemo<DayStack[]>(
    () =>
      monthCells
        .filter(c => c.inMonth)
        .map(c => {
          const parts = new Map<string, number>();
          for (const w of byDay.get(c.key) ?? []) {
            const p = projectOf(w.issueKey);
            parts.set(p, (parts.get(p) ?? 0) + w.timeSpentSeconds);
          }
          return {
            day: c.date,
            parts: [...parts.entries()].map(([project, seconds]) => ({
              project,
              seconds,
            })),
            worked: workedSeconds(byDay.get(c.key) ?? []),
          };
        }),
    [monthCells, byDay]
  );

  const dayStats = useMemo(() => {
    const days = view === "week" ? weekDays : monthCells.filter(c => c.inMonth);
    const totals = days.map(d => ({
      date: d.date,
      key: d.key,
      seconds: workedSeconds(byDay.get(d.key) ?? []),
    }));
    const under = totals.filter(
      d =>
        d.key <= todayKey &&
        d.seconds < targetFor(d.date)
    ).length;
    const active = totals.filter(d => d.seconds > 0);
    const longest = active.reduce<(typeof totals)[number] | null>(
      (m, d) => (m && m.seconds >= d.seconds ? m : d),
      null
    );
    return { under, active: active.length, longest };
  }, [view, weekDays, monthCells, byDay, todayKey, targetFor]);

  // --- closed weeks ---
  const weekKey = dayKey(period.from);
  const weekStatus = trpc.weeks.status.useQuery(
    { week: weekKey },
    { enabled: view === "week" }
  );
  const locked = view === "week" && !!weekStatus.data;
  const closeMut = trpc.weeks.close.useMutation({
    onSuccess: () => {
      void utils.weeks.invalidate();
      toast.success(t("pages.timesheet.weekClosed"));
    },
    onError: e => toast.error(e.message),
  });
  const reopenMut = trpc.weeks.reopen.useMutation({
    onSuccess: () => {
      void utils.weeks.invalidate();
      toast.success(t("pages.timesheet.weekReopened"));
    },
    onError: e => toast.error(e.message),
  });

  // --- selection & mutations ---
  const selection = useWorklogSelection(periodKey);
  const del = trpc.worklogs.delete.useMutation();
  const create = trpc.worklogs.create.useMutation();

  const selectedLogs = periodLogs.filter(w => selection.selected.has(w.id));

  const deleteLogs = async (targets: TimesheetLog[]) => {
    setBusy(true);
    const failed: TimesheetLog[] = [];
    let reason = "";
    for (const w of targets) {
      try {
        // By its id: its key may be on two trackers.
        await del.mutateAsync({ id: w.id });
      } catch (e) {
        failed.push(w);
        reason ||= e instanceof Error ? e.message : String(e);
      }
    }
    setBusy(false);
    // What could not be deleted stays selected: easy to see, easy to retry.
    selection.setAll(failed.map(w => w.id));
    invalidate();
    const ok = targets.length - failed.length;
    if (failed.length === 0) {
      toast.success(t("pages.timesheet.deletedOne", { count: ok }));
    } else {
      toast.error(
        t("pages.timesheet.deletedSome", { count: failed.length, ok, total: targets.length }),
        { description: reason }
      );
    }
  };

  /**
   * Copy a day onto today in its original (chronological) order, as one
   * back-to-back run placed by the shared rule: ending now, or in the latest
   * free stretch long enough before now; never over today's worklogs or
   * timers, never before midnight. No room: nothing is created.
   */
  const duplicateDay = async (key: string, now: Date) => {
    const entries = [...(byDay.get(key) ?? [])].sort(
      (a, b) => new Date(a.started).getTime() - new Date(b.started).getTime()
    );
    if (entries.length === 0) return;
    // Jira logs whole minutes: round once, and move the cursor by the same.
    const blocks = entries.map(w => ({
      w,
      seconds: Math.max(60, Math.round(w.timeSpentSeconds / 60) * 60),
    }));
    const total = blocks.reduce((a, b) => a + b.seconds, 0);
    if (!todayPlacement.ready) {
      toast.error(t("pages.timesheet.todayNotLoaded"));
      return;
    }
    const placed = todayPlacement.place(total, { now });
    if (!placed.ok) {
      toast.error(t("pages.timesheet.notDuplicated", { reason: placed.reason }), {
        duration: 10_000,
      });
      return;
    }
    let cursor = placed.start.getTime();
    setBusy(true);
    const done: string[] = [];
    try {
      for (const { w, seconds } of blocks) {
        await create.mutateAsync({
          issueKey: w.issueKey,
          connectionId: w.connectionId ?? undefined,
          seconds,
          started: new Date(cursor).toISOString(),
          comment: w.comment,
        });
        cursor += seconds * 1000;
        done.push(w.issueKey);
      }
      toast.success(t("pages.timesheet.duplicated", { count: done.length }));
    } catch (e) {
      // Say exactly what already exists, so a retry doesn't double it.
      toast.error(
        t("pages.timesheet.duplicatePartial", {
          done: done.length,
          total: blocks.length,
          list: done.length ? ` (${done.join(", ")})` : "",
          message: e instanceof Error ? e.message : t("pages.timesheet.errorWord"),
        }),
        { duration: 10_000 }
      );
    } finally {
      setBusy(false);
      invalidate();
    }
  };

  const runConfirm = () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    if (c.type === "delete") void deleteLogs([c.log]);
    else if (c.type === "bulk") void deleteLogs(selectedLogs);
    else void duplicateDay(c.key, new Date());
  };

  const trackerOf = (connectionId?: number | null): string => {
    const c = (connections.data ?? []).find(x => x.id === connectionId);
    return c ? c.label || c.name : "";
  };
  // "APP-1" -> "APP", "owner/repo#12" -> "owner/repo"
  const containerOf = (key: string): string => key.split(/[-#]/)[0] ?? "";

  const exportCsv = () => {
    const rows = [...periodLogs]
      .sort(
        (a, b) => new Date(a.started).getTime() - new Date(b.started).getTime()
      )
      .map(w => [
        // Days as ISO dates, hours to 2 decimals: same as the Reports export.
        dayKey(new Date(w.started)),
        w.issueKey,
        summaries.get(issueId(w))?.summary ?? "",
        Math.round((w.timeSpentSeconds / 3600) * 100) / 100,
        w.comment,
        // Tracker (its label, else its service name) and project/repository.
        trackerOf(w.connectionId),
        summaries.get(issueId(w))?.projectKey || containerOf(w.issueKey),
      ]);
    const name =
      view === "week"
        ? `timesheet-${dayKey(period.from)}.csv`
        : `timesheet-${dayKey(period.from).slice(0, 7)}.csv`;
    downloadCsv(
      name,
      [
        t("pages.timesheet.csvDate"),
        t("pages.timesheet.csvIssue"),
        t("pages.timesheet.csvSummary"),
        t("pages.timesheet.csvHours"),
        t("pages.timesheet.csvComment"),
        t("pages.timesheet.csvTracker"),
        t("pages.timesheet.csvContainer"),
      ],
      rows
    );
    toast.success(t("pages.timesheet.exported", { count: rows.length }));
  };

  const confirmText = (() => {
    if (!confirm) return { title: "", body: "", action: "" };
    if (confirm.type === "delete")
      return {
        title: t("pages.timesheet.deleteOneTitle", { key: confirm.log.issueKey }),
        body: t("pages.timesheet.deleteOneBody", {
          provider,
          duration: formatDurationLong(confirm.log.timeSpentSeconds),
        }),
        action: t("pages.timesheet.deleteAction"),
      };
    if (confirm.type === "bulk")
      return {
        title: t("pages.timesheet.bulkTitle", { count: selectedLogs.length }),
        body: t("pages.timesheet.bulkBody", { provider }),
        action: t("pages.timesheet.deleteAction"),
      };
    const entries = byDay.get(confirm.key) ?? [];
    const total = workedSeconds(entries);
    return {
      title: t("pages.timesheet.duplicateTitle"),
      body: t("pages.timesheet.duplicateBody", {
        count: entries.length,
        duration: formatDurationLong(total),
        date: dateNumeric().format(confirm.date),
      }),
      action: t("pages.timesheet.duplicateAction"),
    };
  })();

  const periodLabel =
    view === "week"
      ? t("pages.timesheet.hoursWeek")
      : t("pages.timesheet.hoursMonth");
  const isEmpty = !logs.isPending && !logs.error && periodLogs.length === 0;

  return (
    <>
      <PageHeader
        sticky
        title={title}
        documentTitle={t("pages.timesheet.documentTitle")}
        titleAddon={
          <>
            <Popover open={pickOpen} onOpenChange={setPickOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="rounded-md"
                  aria-label={t("pages.timesheet.pickDate")}
                >
                  <CalendarDays className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <label
                  htmlFor="ts-date"
                  className="mb-1.5 block text-body-sm font-medium"
                >
                  {t("pages.timesheet.goToDay")}
                </label>
                <Input
                  id="ts-date"
                  type="date"
                  defaultValue={dayKey(period.from)}
                  className="w-auto"
                  onChange={e => {
                    const d = parseDayKey(e.target.value);
                    if (d) {
                      setAnchor(d);
                      setPickOpen(false);
                    }
                  }}
                />
              </PopoverContent>
            </Popover>
            {view === "week" && locked && (
              <Chip tone="success" className="ml-1">
                <Lock className="h-3 w-3" aria-hidden /> {t("pages.timesheet.closed")}
              </Chip>
            )}
          </>
        }
        actions={
          <>
            <SegmentedControl
              label={t("pages.timesheet.view")}
              value={view}
              onChange={switchView}
              options={viewOptions()}
            />
            <PeriodNav
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onToday={() => setAnchor(today)}
              isCurrent={isCurrent}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t("pages.timesheet.moreActions")}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {view === "week" &&
                  (locked ? (
                    <DropdownMenuItem
                      disabled={reopenMut.isPending}
                      onSelect={() => reopenMut.mutate({ week: weekKey })}
                    >
                      <LockOpen className="h-4 w-4" /> {t("pages.timesheet.reopenWeek")}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      disabled={closeMut.isPending}
                      onSelect={() => closeMut.mutate({ week: weekKey })}
                    >
                      <Lock className="h-4 w-4" /> {t("pages.timesheet.closeWeek")}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuItem
                  disabled={periodLogs.length === 0}
                  onSelect={exportCsv}
                >
                  <Download className="h-4 w-4" /> {t("pages.timesheet.exportCsv")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTrashOpen(true)}>
                  <Trash2 className="h-4 w-4" /> {t("pages.timesheet.trash")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              onClick={() => {
                setLogDay(null);
                setLogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              {t("pages.timesheet.logTime")}
            </Button>
          </>
        }
      />

      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
      <ViewScope all={shown.all} onAll={all => setShown({ all })} search={shown.search} onSearch={s => setShown({ search: s })} />
      <PanelRow className="xl:grid-cols-[minmax(0,1fr)_340px]">
        <PanelSection
          title={t("pages.timesheet.summary")}
          className="border-b xl:border-b-0 xl:border-r"
        >
          {logs.isPending ? (
            <Skeleton className="h-80" />
          ) : logs.error ? (
            <ErrorState
              message={logs.error.message}
              onRetry={() => logs.refetch()}
            />
          ) : (
            <PeriodSummary
              label={periodLabel}
              totalSeconds={periodTotal}
              loggedSeconds={periodLogged}
              targetSeconds={target}
              legend={legend}
              issues={issueTotals}
              colorOf={colorOf}
              pending={pending}
            />
          )}
        </PanelSection>
        <div className="min-w-0 p-5 md:p-6">
          {logs.isPending ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : logs.error ? (
            <ErrorState
              message={logs.error.message}
              onRetry={() => logs.refetch()}
            />
          ) : (
            <QuickStatsCard
              title={view === "week" ? t("pages.timesheet.viewWeek") : t("pages.timesheet.viewMonth")}
              stats={[
                {
                  label: t("pages.timesheet.underGoal"),
                  value: String(dayStats.under),
                  tone: dayStats.under > 0 ? "danger" : undefined,
                },
                { label: t("pages.timesheet.entries"), value: String(periodLogs.length) },
              ]}
              extra={[
                {
                  label: t("pages.timesheet.avgPerDay"),
                  value:
                    dayStats.active > 0
                      ? formatDuration(periodTotal / dayStats.active)
                      : "—",
                },
                {
                  label: t("pages.timesheet.maxDay"),
                  value: dayStats.longest
                    ? formatDuration(dayStats.longest.seconds)
                    : "—",
                },
                { label: t("pages.timesheet.projects"), value: String(projectCount) },
                view === "week"
                  ? {
                      label: t("pages.timesheet.status"),
                      value: weekStatus.data ? t("pages.timesheet.closed") : t("pages.timesheet.open"),
                    }
                  : { label: t("pages.timesheet.goal"), value: formatDuration(target) },
              ]}
            />
          )}
        </div>
      </PanelRow>

      <PanelRow>
        <PanelSection
          title={view === "week" ? t("pages.timesheet.days") : t("pages.timesheet.viewMonth")}
          actions={
            view === "week" && !locked && selectedLogs.length > 0 ? (
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => setConfirm({ type: "bulk" })}
              >
                <Trash2 className="h-4 w-4" />{" "}
                {t("pages.timesheet.deleteSelected", { count: selectedLogs.length })}
              </Button>
            ) : undefined
          }
        >
          {logs.isPending ? (
            <Skeleton className="h-96" />
          ) : logs.error ? (
            <ErrorState
              message={logs.error.message}
              onRetry={() => logs.refetch()}
            />
          ) : (
            <>
              {isEmpty && (
                <EmptyState
                  className="py-6"
                  art="calendar"
                  title={
                    view === "week"
                      ? t("pages.timesheet.emptyWeek")
                      : t("pages.timesheet.emptyMonth")
                  }
                  message={t("pages.timesheet.emptyHint")}
                />
              )}
              {view === "week" ? (
                <WeekView
                  days={weekDays}
                  byDay={byDay}
                  summaries={summaries}
                  targetFor={targetFor}
                  todayKey={todayKey}
                  pending={pending}
                  locked={locked}
                  selected={selection.selected}
                  busy={busy}
                  onToggle={selection.toggle}
                  onEdit={setEditing}
                  onDelete={log => setConfirm({ type: "delete", log })}
                  onDuplicate={d =>
                    setConfirm({ type: "duplicate", key: d.key, date: d.date })
                  }
                  onAdd={date => {
                    setLogDay(dayKey(date) === todayKey ? null : date);
                    setLogOpen(true);
                  }}
                />
              ) : (
                <div className="grid gap-6">
                  <MonthView
                    cells={monthCells}
                    byDay={byDay}
                    targetFor={targetFor}
                    todayKey={todayKey}
                    onOpenDay={date => setShown({ view: "week", anchor: date })}
                  />
                  <PeriodBars
                    dense
                    stacks={stacks}
                    colorOf={colorOf}
                    targetFor={targetFor}
                    pending={pending}
                  />
                </div>
              )}
            </>
          )}
        </PanelSection>
      </PanelRow>

      {editing && (
        <LogTimeDialog
          key={editing.id}
          issueKey={editing.issueKey}
          connectionId={editing.connectionId ?? undefined}
          worklog={{
            id: editing.id,
            connectionId: editing.connectionId,
            remoteId: editing.remoteId,
            timeSpentSeconds: editing.timeSpentSeconds,
            started: new Date(editing.started),
            comment: editing.comment,
          }}
          open
          onOpenChange={o => {
            if (!o) setEditing(null);
          }}
        />
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={o => {
          if (!o) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmText.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("pages.timesheet.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              destructive={confirm?.type !== "duplicate"}
              onClick={runConfirm}
            >
              {confirmText.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("pages.timesheet.logTime")}
              {logDay && ` · ${capitalize(logDayFormat().format(logDay))}`}
            </DialogTitle>
            <DialogDescription>
              {t("pages.timesheet.logPick", { provider })}
            </DialogDescription>
          </DialogHeader>
          <QuickLog
            day={logDay ?? undefined}
            onLogged={() => setLogOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
