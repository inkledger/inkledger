import { failureText, errorText } from "@/lib/errorText";
import { keepPreviousData } from "@tanstack/react-query";
import { realSecondsByDay } from "@contracts/placement";
import { Fragment, cloneElement, isValidElement, useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useToday } from "@/hooks/useToday";
import {
  CalendarDays,
  CalendarRange,
  Plus,
  Settings2,
  Sun,
  Sunset,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { visibleIssues, issueId } from "@/lib/issues";
import {
  addDays,
  dayKey,
  formatDuration,
  formatDurationLong,
  parseDayKey,
  startOfDay,
  startOfWeek,
  findGaps,
  type TimeSpan,
} from "@contracts/time";
import { todoTimeByDay } from "@contracts/todo";
import {
  DASHBOARD_WIDGETS,
  type DashboardLayoutItem,
} from "@contracts/dashboard";
import { WorkspaceScopeProvider } from "@/lib/workspace/provider";
import { useWorkspace } from "@/lib/workspace/context";
import { placementsFor, useWorkspaceDeviceClass } from "@/lib/workspace/utils";
import { flowControlProps } from "@/lib/workspace/instrumentation";
import { WorkspaceInteractionBoundary } from "@/lib/workspace/interaction";
import { draftFromWorkspace, visibilityPatch } from "@/lib/workspace/draft";
import { usePeriod, type PeriodKind } from "@/hooks/usePeriod";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { effectiveTargetSeconds, effectiveTargetSecondsBetween, effectiveWorkSpans, openGap } from "@contracts/workSchedule";
import type { PlannedEntry } from "@contracts/planned";
import { GapCutter } from "@/components/dashboard/GapCutter";
import { PlannedDialog } from "@/components/PlannedDialog";
import { useCollapsedColumns } from "@/hooks/useCollapsedColumns";
import { useTimers } from "@/hooks/useTimers";
import { dayReview } from "@/lib/flag";
import { weekRecap } from "@/lib/recap";
import { WeekRecapCard } from "@/components/dashboard/WeekRecapCard";
import { projectOf, rankProjects } from "@/lib/projectColors";
import { daysUntil } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
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
import { PageHeader, SectionLabel } from "@/components/app/PageHeader";
import { PeriodNav } from "@/components/app/PeriodNav";
import { PanelSection } from "@/components/app/Panel";
import { Link } from "react-router";
import { ErrorState } from "@/components/app/States";
import { ActiveTimerQuickControls, TickingElapsed, TimerRing } from "@/components/TimerControls";
import { QuickLog } from "@/components/QuickLog";
import {
  DayTimeline,
  type TimelineEntry,
} from "@/components/dashboard/DayTimeline";
import { PeriodBars, type DayStack } from "@/components/dashboard/PeriodBars";
import {
  PeriodSummary,
  type IssueTotal,
} from "@/components/dashboard/PeriodSummary";
import { QuickStatsCard } from "@/components/dashboard/QuickStatsCard";
import { TasksBoard, type TaskColumn } from "@/components/dashboard/TasksBoard";
import {
  ActivityTable,
  type ActivityRow,
} from "@/components/dashboard/ActivityTable";
import { toast } from "sonner";
import { useProviderName } from "@/hooks/useConnections";
import { dateFormat, t } from "@/i18n";
import { ModuleSlot } from "@/modules/ModuleHost";
import { isClosed, isWaiting } from "@contracts/categories";
import { gapNeighbours } from "@/lib/gapCuts";
import { placePendingTimers } from "@/lib/pendingTimers";
import { timerLog } from "@/lib/timerLog";

const periodOptions = (): { value: PeriodKind; label: string; icon: typeof Sun }[] => [
  { value: "day", label: t("pages.dashboard.periodDay"), icon: Sun },
  { value: "week", label: t("pages.dashboard.periodWeek"), icon: CalendarRange },
  { value: "month", label: t("pages.dashboard.periodMonth"), icon: CalendarDays },
];

const longDay = () =>
  dateFormat({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
const monthYear = () => dateFormat({ month: "long", year: "numeric" });
const shortDay = () => dateFormat({ day: "numeric", month: "short" });

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The Customize popover's six sections (as before the workspace): shown or hidden, saved as a layout. */
function useDashboardLayout() {
  const { workspace, actions } = useWorkspace();
  // What the user just ticked, shown at once and dropped once saved (or put back if it failed).
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const shown = (anchorId: string) => ticked[anchorId] ?? workspace.placements.find(placement => placement.anchorId === anchorId)?.visible !== false;
  const layout: DashboardLayoutItem[] = DASHBOARD_WIDGETS
    .map(widget => `dashboard.${widget.id}`)
    .filter(anchorId => workspace.placements.some(placement => placement.anchorId === anchorId))
    .map(anchorId => ({ id: anchorId, visible: shown(anchorId) }));
  return {
    layout,
    isVisible: shown,
    toggle: (id: string) => {
      const visible = !shown(id);
      setTicked(current => ({ ...current, [id]: visible }));
      const settle = () => setTicked(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
      void actions.applyDraft(draftFromWorkspace(workspace, [visibilityPatch(workspace, id, visible)]))
        .then(result => {
          if (result.status === "deferred") toast.info(t("pages.dashboard.prefDeferred"));
          else if (result.status === "conflict") toast.error(t("pages.dashboard.prefNotSaved", { message: t("pages.dashboard.prefConflict") }));
        })
        .catch((error: unknown) => toast.error(t("pages.dashboard.prefNotSaved", { message: failureText(error) })))
        .finally(settle);
    },
  };
}

/** Pause and stop on the running block: one element, so the timeline's renders never redraw it. */
const LIVE_CONTROLS = <ActiveTimerQuickControls compact />;

/**
 * The header's timer: the running one, else the last paused, with its time,
 * paused, resumed or stopped from here (a stop asks to log, as everywhere).
 */
function HeaderTimer() {
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(tm => tm.state === "running") ?? timers[0];
  if (!timer) return null;
  const running = timer.state === "running";
  const toLog = timers
    .filter(tm => tm.state !== "running" && tm.pausedAt && tm.elapsedSeconds > 0)
    .sort((a, b) => new Date(a.pausedAt ?? 0).getTime() - new Date(b.pausedAt ?? 0).getTime());
  return (
    <span className="mr-1 flex items-center gap-1.5 border-r pr-1 text-body-sm font-medium">
      <TimerRing running={running} />
      <span className="text-muted-foreground">{timer.issueKey}</span>
      {running && <span className="sr-only">{t("pages.dashboard.timerRunning", { key: timer.issueKey })}</span>}
      <TickingElapsed state={timer.state} elapsedSeconds={timer.elapsedSeconds} fetchedAt={fetchedAt} className={running ? undefined : "text-warning"} />
      <ActiveTimerQuickControls />
      {/* Stopped ones behind the running one ("Later"): still to log, never out of sight. */}
      {running && toLog.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          title={t("pages.dashboard.toLogTitle")}
          className="text-warning"
          onClick={() => {
            const [oldest] = toLog;
            if (oldest.pausedAt)
              timerLog.push({ issueKey: oldest.issueKey, connectionId: oldest.connectionId ?? undefined, seconds: oldest.elapsedSeconds, note: oldest.note, end: new Date(oldest.pausedAt) });
          }}
        >
          {t("pages.dashboard.toLog", { count: toLog.length })}
        </Button>
      )}
    </span>
  );
}

function DashboardHeaderActions({ range, setKind, prev, next, reset, openAdd, futureDay, layout, toggle }: {
  range: ReturnType<typeof usePeriod>["range"];
  setKind: (kind: PeriodKind) => void;
  prev: () => void;
  next: () => void;
  reset: () => void;
  openAdd: () => void;
  futureDay: boolean;
  layout: DashboardLayoutItem[];
  toggle: (id: string) => void;
}) {
  const { workspace } = useWorkspace();
  const content: Record<string, ReactNode> = {
    "dashboard.period": (
      <>
        <SegmentedControl label={t("pages.dashboard.period")} value={range.kind} onChange={setKind} options={periodOptions()} />
        <PeriodNav onPrev={prev} onNext={next} onToday={reset} isCurrent={range.isCurrent} />
      </>
    ),
    "dashboard.headerTimer": <HeaderTimer />,
    "dashboard.quickActions": (
      <Button onClick={openAdd} {...flowControlProps(futureDay ? "dashboard.plan" : "dashboard.logTime")}>
        <Plus className="h-4 w-4" />
        {futureDay ? t("ui.planned.plan") : t("pages.dashboard.logTime")}
      </Button>
    ),
    "dashboard.customize": (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("pages.dashboard.customize")} title={t("pages.dashboard.customizeShort")} {...flowControlProps("dashboard.customize.open")}>
            <Settings2 className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60">
          <p className="mb-2 text-body-sm font-medium">{t("pages.dashboard.visibleSections")}</p>
          <ul className="grid gap-2">
            {layout.map(l => {
              const widget = DASHBOARD_WIDGETS.find(w => `dashboard.${w.id}` === l.id)!;
              const label = t(`pages.dashboard.widgets.${widget.id}`);
              return (
                <li key={l.id}>
                  <label className="flex items-center gap-2 text-body-sm">
                    <Checkbox checked={l.visible} onCheckedChange={() => toggle(l.id)} />
                    {label}
                  </label>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    ),
  };
  return (
    <>
      {placementsFor(workspace, "dashboard.header").map(placement => <Fragment key={placement.anchorId}>{content[placement.anchorId]}</Fragment>)}
    </>
  );
}

function DashboardSections({ content }: { content: Record<string, ReactNode> }) {
  const { workspace } = useWorkspace();
  const renderAnchor = (anchorId: string): ReactNode => {
    const node = content[anchorId];
    const placement = workspace.placements.find(item => item.anchorId === anchorId);
    if (!isValidElement(node) || !placement) return node;
    if (node.type === PanelSection) return cloneElement(node as ReactElement<{ anchorId: string; variant: typeof placement.variant }>, { anchorId, variant: placement.variant });
    if (node.type === QuickStatsCard) return cloneElement(node as ReactElement<{ variant: typeof placement.variant }>, { variant: placement.variant });
    if (anchorId === "dashboard.timeline") {
      const section = node as ReactElement<{ className?: string; "data-workspace-anchor"?: string; "data-workspace-variant"?: string }>;
      return cloneElement(section, {
        "data-workspace-anchor": anchorId,
        "data-workspace-variant": placement.variant,
        className: cn(section.props.className, placement.variant === "compact" && "p-3", placement.variant === "expanded" && "p-6 md:p-8"),
      });
    }
    return node;
  };
  // My issues and Recent activity stack in one column beside the summary, wherever the first of them sits.
  const stacked = new Set(["dashboard.tasks", "dashboard.activity"]);
  const primaryPlacements = placementsFor(workspace, "dashboard.primary")
    .filter(placement => placement.anchorId !== "dashboard.timeline" && placement.anchorId !== "dashboard.recap");
  const column = primaryPlacements.filter(placement => stacked.has(placement.anchorId));
  const primary = primaryPlacements.flatMap(placement => {
    if (!stacked.has(placement.anchorId)) return [<Fragment key={placement.anchorId}>{renderAnchor(placement.anchorId)}</Fragment>];
    if (placement !== column[0]) return [];
    return [<div key="dashboard.tasks+activity" className="min-w-0">{column.map(item => <Fragment key={item.anchorId}>{renderAnchor(item.anchorId)}</Fragment>)}</div>];
  });
  const timeline = renderAnchor("dashboard.timeline");
  const stats = renderAnchor("dashboard.stats");
  const summary = content["dashboard.summary"];
  const tasks = content["dashboard.tasks"];
  const activity = content["dashboard.activity"];
  const recap = renderAnchor("dashboard.recap");
  const desk = renderAnchor("dashboard.desk");
  const hasSecondaryContent = Boolean(tasks || activity);
  return (
    <>
      {(timeline || stats) && (
        <div className={cn("grid gap-6 border-b p-5 md:p-6", timeline && stats && "xl:grid-cols-[minmax(0,1fr)_340px]")}>
          {timeline}
          {stats}
        </div>
      )}
      {primary.length > 0 && (
        <div className={cn("grid", summary && hasSecondaryContent && "xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.45fr)]")}>
          {primary}
        </div>
      )}
      {recap}
      {desk}
    </>
  );
}

function DashboardContent() {
  const provider = useProviderName();
  const { range, setKind, prev, next, reset, jumpTo } = usePeriod("day");
  const { layout, isVisible, toggle } = useDashboardLayout();
  const today = useToday();
  const [logOpen, setLogOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [editingPlanned, setEditingPlanned] = useState<PlannedEntry | null>(null);
  const [pickOpen, setPickOpen] = useState(false);

  const title =
    range.kind === "day"
      ? capitalize(longDay().format(range.from))
      : range.kind === "week"
        ? t("pages.dashboard.weekTitle", {
            from: shortDay().format(range.from),
            to: shortDay().format(addDays(range.to, -1)),
          })
        : capitalize(monthYear().format(range.from));

  const stats = trpc.stats.dashboard.useQuery();
  const issues = trpc.issues.all.useQuery();
  // Another period keeps the last one on screen until its own arrives: no
  // skeleton between days, and what stands on the timeline (a module's tree) stays.
  const logs = trpc.worklogs.list.useQuery(
    { from: range.from.toISOString(), to: range.to.toISOString() },
    { placeholderData: keepPreviousData }
  );
  const recentFrom = useMemo(() => addDays(startOfDay(today), -13), [today]);
  // Up to the end of today: time pre-logged on future days isn't "recent".
  const recentTo = useMemo(() => addDays(startOfDay(today), 1), [today]);
  const recent = trpc.worklogs.list.useQuery({
    from: recentFrom.toISOString(),
    to: recentTo.toISOString(),
  });
  const plannedFrom = new Date(Math.min(range.from.getTime(), recentFrom.getTime(), startOfWeek(today).getTime()));
  const plannedTo = new Date(Math.max(range.to.getTime(), recentTo.getTime(), addDays(startOfWeek(today), 7).getTime()));
  const planned = trpc.planned.list.useQuery(
    { from: plannedFrom.toISOString(), to: plannedTo.toISOString() },
    { placeholderData: keepPreviousData }
  );
  // Kept the same array between renders: the targets below depend on it.
  const plannedEntries = useMemo(() => planned.data ?? [], [planned.data]);
  // TODO time in the period: beside the logged time, never added to it.
  const todoSessions = trpc.todos.sessions.useQuery(
    { from: range.from.toISOString(), to: range.to.toISOString() },
    { placeholderData: keepPreviousData, enabled: isVisible("dashboard.timeline") }
  );
  const todoSpans = useMemo(() => todoSessions.data ?? [], [todoSessions.data]);
  const todoByDay = useMemo(() => todoTimeByDay(todoSpans), [todoSpans]);
  const timerState = useTimers();
  const { timers } = timerState;
  // Today on screen: its parts show the time tracked and not yet logged (they tick, not the page).
  const pending = range.from <= today && today < range.to;

  const issueByKey = useMemo(
    () => new Map((issues.data ?? []).map(i => [issueId(i), i])),
    [issues.data]
  );

  // Totals per project / issue / day for the period on screen.
  const derived = useMemo(() => {
    const byProject = new Map<string, number>();
    const byIssue = new Map<string, IssueTotal>();
    const byDay = new Map<string, Map<string, number>>();
    for (const w of logs.data ?? []) {
      const project = projectOf(w.issueKey);
      byProject.set(
        project,
        (byProject.get(project) ?? 0) + w.timeSpentSeconds
      );
      const id = issueId(w);
      const entry = byIssue.get(id) ?? {
        issueKey: w.issueKey,
        connectionId: w.connectionId,
        seconds: 0,
      };
      entry.seconds += w.timeSpentSeconds;
      byIssue.set(id, entry);
      const key = dayKey(new Date(w.started));
      const day = byDay.get(key) ?? new Map<string, number>();
      day.set(project, (day.get(project) ?? 0) + w.timeSpentSeconds);
      byDay.set(key, day);
    }
    const logged = [...byIssue.values()].reduce((a, b) => a + b.seconds, 0);
    // The hours worked: each day's entries counted once where they run in parallel.
    const worked = realSecondsByDay((logs.data ?? []).map(w => ({ start: new Date(w.started), seconds: w.timeSpentSeconds })));
    const total = [...worked.values()].reduce((a, s) => a + s, 0);
    return { byIssue, byDay, worked, total, logged, ...rankProjects(byProject) };
  }, [logs.data]);

  // Vacation removes only its intersection with the schedule; work and travel never change the target.
  const { forDay, versions } = useWorkSchedule();
  const targetFor = useCallback(
    (date: Date) => effectiveTargetSeconds(date, forDay(date), plannedEntries),
    [forDay, plannedEntries]
  );
  const todayTarget = targetFor(today);
  const recap = useMemo(
    () => weekRecap(recent.data ?? [], today, targetFor),
    [recent.data, today, targetFor]
  );

  const weeklyTarget = effectiveTargetSecondsBetween(startOfWeek(today), 7, versions, plannedEntries);
  const target = effectiveTargetSecondsBetween(range.from, range.days.length, versions, plannedEntries);

  const issueTotals: IssueTotal[] = [...derived.byIssue.values()]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 5)
    .map(total => {
      const issue = issueByKey.get(issueId(total));
      return { ...total, summary: issue?.summary, remoteId: issue?.remoteId };
    });

  const timelineEntries: TimelineEntry[] = (logs.data ?? []).map(w => ({
    id: w.remoteId,
    issueKey: w.issueKey,
    connectionId: w.connectionId,
    remoteId: issueByKey.get(issueId(w))?.remoteId,
    summary: issueByKey.get(issueId(w))?.summary,
    start: new Date(w.started),
    seconds: w.timeSpentSeconds,
  }));
  const running = timers.find(tm => tm.state === "running");
  if (running && range.kind === "day" && range.isCurrent) {
    // Approximation: a running timer is drawn as ending now.
    timelineEntries.push({
      id: "live",
      issueKey: running.issueKey,
      connectionId: running.connectionId,
      summary: issueByKey.get(issueId(running))?.summary,
      start: new Date(timerState.fetchedAt - running.elapsedSeconds * 1000),
      seconds: running.elapsedSeconds,
      live: true,
    });
  }

  // Holes of the working day still to log: open weeks only, up to now.
  const dayView = range.kind === "day";
  const weekStatus = trpc.weeks.status.useQuery(
    { week: dayKey(range.from) },
    { enabled: dayView }
  );
  const daySchedule = forDay(range.from);
  const holesUntil = new Date();
  // A stopped timer's time is tracked, just not logged yet: drawn where logging
  // it would put it ("Later" keeps it here), and never a hole (filling it would
  // count that time twice).
  if (dayView) {
    for (const p of placePendingTimers({ day: range.from, now: holesUntil, timers, occupied: timelineEntries, schedule: daySchedule }))
      timelineEntries.push({
        id: `pending:${issueId(p.timer)}`,
        issueKey: p.timer.issueKey,
        connectionId: p.timer.connectionId ?? undefined,
        summary: issueByKey.get(issueId(p.timer))?.summary,
        start: p.start,
        seconds: p.seconds,
        pending: true,
      });
  }
  const missing =
    dayView && weekStatus.data === null && range.from.getTime() <= today.getTime()
      ? effectiveWorkSpans(range.from, daySchedule, plannedEntries).flatMap(work => {
          const end = new Date(Math.min(work.start.getTime() + work.seconds * 1000, holesUntil.getTime()));
          return end <= work.start ? [] : findGaps(timelineEntries, work.start, end, 1);
        })
      : [];
  // The hole reaching now: a timer can start from its start (Play on it). None while one runs.
  const openHole = running ? null : openGap(missing, holesUntil);
  const [gap, setGap] = useState<TimeSpan | null>(null);
  // The worklogs next to the hole, which it can extend instead of a tiny new one.
  const neighbours = useMemo(
    () =>
      gap
        ? gapNeighbours(
            (logs.data ?? []).map(w => ({
              id: w.id,
              issueKey: w.issueKey,
              connectionId: w.connectionId,
              start: new Date(w.started).getTime(),
              seconds: w.timeSpentSeconds,
              comment: w.comment,
              // Locked on its tracker or in conflict there: left as it is.
              editable: !w.sink.locked && w.sink.state !== "conflict",
            })),
            gap
          )
        : { before: null, after: null },
    [gap, logs.data]
  );
  // "Log time" logs on the day on screen, not always on today.
  const logDay = dayView && !range.isCurrent ? range.from : undefined;
  const futureDay = dayView && dayKey(range.from) > dayKey(today);
  const openAdd = () => {
    if (futureDay) setPlanOpen(true);
    else setLogOpen(true);
  };
  const editPlanned = (entry: PlannedEntry) => {
    setEditingPlanned(entry);
    setPlanOpen(true);
  };
  // A stopped timer on the timeline asks to be logged again, as at its stop.
  const logPending = (entry: TimelineEntry) => {
    const tm = timers.find(x => `pending:${issueId(x)}` === entry.id);
    if (!tm?.pausedAt) return;
    timerLog.push({
      issueKey: tm.issueKey,
      connectionId: tm.connectionId ?? undefined,
      seconds: tm.elapsedSeconds,
      note: tm.note,
      end: new Date(tm.pausedAt),
    });
  };

  const stacks: DayStack[] = range.days.map(day => ({
    day,
    parts: [
      ...(
        derived.byDay.get(dayKey(day)) ?? new Map<string, number>()
      ).entries(),
    ].map(([project, seconds]) => ({ project, seconds })),
    worked: derived.worked.get(dayKey(day)),
  }));

  const tasksCollapsed = useCollapsedColumns("dashboard");
  // My issues by status category, for the mini board.
  const columns: TaskColumn[] = useMemo(() => {
    // My work only: what is assigned to me (favorites of others stay out).
    const mine = visibleIssues(issues.data ?? []).filter(i => i.isMine);
    const pick = (keep: (category: string) => boolean) => mine.filter(i => keep(i.category));
    const byDue = (
      a: { dueDate: string | null },
      b: { dueDate: string | null }
    ) => ((a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : 1);
    const todo = pick(isWaiting).sort(byDue);
    const doing = pick(c => c === "doing").sort(byDue);
    const done = pick(isClosed);
    return [
      {
        title: t("pages.dashboard.todo"),
        tone: "danger",
        issues: todo.slice(0, 5),
        total: todo.length,
      },
      {
        title: t("pages.dashboard.doing"),
        tone: "warning",
        issues: doing.slice(0, 5),
        total: doing.length,
      },
      {
        title: t("pages.dashboard.done"),
        tone: "success",
        issues: done.slice(0, 5),
        total: done.length,
      },
    ];
  }, [issues.data]);

  const activity: ActivityRow[] = useMemo(() => {
    const rows = new Map<string, ActivityRow>();
    for (const w of recent.data ?? []) {
      const at = new Date(w.started);
      const id = issueId(w);
      const row = rows.get(id);
      const issue = issueByKey.get(id);
      if (!row) {
        rows.set(id, {
          issueKey: w.issueKey,
          connectionId: w.connectionId,
          remoteId: issue?.remoteId,
          summary: issue?.summary,
          status: issue?.status,
          category: issue?.category,
          lastComment: w.comment,
          lastAt: at,
          seconds: w.timeSpentSeconds,
        });
      } else {
        row.seconds += w.timeSpentSeconds;
        if (at > row.lastAt) {
          row.lastAt = at;
          row.lastComment = w.comment || row.lastComment;
        } else if (!row.lastComment && w.comment) {
          // Newest first: an empty latest comment falls back to an older one.
          row.lastComment = w.comment;
        }
      }
    }
    return [...rows.values()].slice(0, 10);
  }, [recent.data, issueByKey]);

  const openIssues = visibleIssues(issues.data ?? []).filter(
    i => !isClosed(i.category)
  );
  const overdue = openIssues
    .filter(i => i.dueDate && (daysUntil(i.dueDate, today) ?? 0) < 0)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  const inProgress = openIssues.filter(
    i => i.category === "doing"
  ).length;

  // A short, rule-based note: what deserves attention right now.
  const note = (() => {
    if (overdue.length > 0) {
      const oldest = overdue[0];
      const days = -(daysUntil(oldest.dueDate!, today) ?? 0);
      return overdue.length === 1
        ? t("pages.dashboard.overdueOne", { key: oldest.key, days, count: days })
        : t("pages.dashboard.overdueMany", { count: overdue.length, key: oldest.key, days });
    }
    if (todayTarget === 0) {
      return stats.data ? t("pages.dashboard.notWorkingDay") : undefined;
    }
    if (stats.data && stats.data.todaySeconds < todayTarget) {
      return t("pages.dashboard.remaining", {
        duration: formatDurationLong(todayTarget - stats.data.todaySeconds),
      });
    }
    return stats.data ? t("pages.dashboard.goalReached") : undefined;
  })();

  const periodLabel =
    range.kind === "day"
      ? range.isCurrent
        ? t("pages.dashboard.hoursToday")
        : t("pages.dashboard.hoursDay")
      : range.kind === "week"
        ? t("pages.dashboard.hoursWeek")
        : t("pages.dashboard.hoursMonth");

  const show = {
    timeline: isVisible("dashboard.timeline"),
    stats: isVisible("dashboard.stats"),
    summary: isVisible("dashboard.summary"),
    tasks: isVisible("dashboard.tasks"),
    activity: isVisible("dashboard.activity"),
    recap: isVisible("dashboard.recap"),
  };

  return (
    <>
      <ModuleSlot id="dashboard-overlay" />
      <PageHeader
        sticky
        title={title}
        documentTitle={t("pages.dashboard.documentTitle")}
        titleAddon={
          <>
            <Popover open={pickOpen} onOpenChange={setPickOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="rounded-md"
                  aria-label={t("pages.dashboard.pickDate")}
                >
                  <CalendarDays className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-3">
                <label
                  htmlFor="dash-date"
                  className="mb-1.5 block text-body-sm font-medium"
                >
                  {t("pages.dashboard.goToDay")}
                </label>
                <Input
                  id="dash-date"
                  type="date"
                  defaultValue={dayKey(range.from)}
                  className="w-auto"
                  onChange={e => {
                    const d = parseDayKey(e.target.value);
                    if (d) {
                      jumpTo(d);
                      setPickOpen(false);
                    }
                  }}
                />
              </PopoverContent>
            </Popover>
            <ModuleSlot id="dashboard-action" />
          </>
        }
        actions={
          <DashboardHeaderActions
            range={range}
            setKind={setKind}
            prev={prev}
            next={next}
            reset={reset}
            openAdd={openAdd}
            futureDay={futureDay}
            layout={layout}
            toggle={toggle}
          />
        }
      />


      {(() => {
        const sections: Record<string, ReactNode> = {
        "dashboard.timeline": show.timeline && (
          <section
            aria-label={t("pages.dashboard.periodTrend")}
            aria-busy={logs.isPlaceholderData}
            className={cn("min-w-0 transition-opacity", logs.isPlaceholderData && "opacity-60")}
          >
            {logs.isPending ? (
              <Skeleton className="h-64 rounded-xl" />
            ) : logs.error ? (
              <ErrorState message={errorText(logs.error)} onRetry={() => logs.refetch()} />
            ) : range.kind === "day" ? (
              <DayTimeline
                day={range.from}
                entries={timelineEntries}
                colorOf={derived.colorOf}
                schedule={daySchedule}
                missing={missing}
                onGap={setGap}
                openHole={openHole}
                floor={<ModuleSlot id="dashboard-perch" />}
                todoSpans={todoSpans}
                liveControls={running ? LIVE_CONTROLS : undefined}
                onPending={logPending}
                plannedEntries={plannedEntries}
                onEditPlanned={editPlanned}
              />
            ) : (
              <PeriodBars
                stacks={stacks}
                colorOf={derived.colorOf}
                targetFor={targetFor}
                dense={range.kind === "month"}
                pending={pending}
                parallel={todoByDay}
              />
            )}
          </section>
        ),
        "dashboard.stats": show.stats && (stats.isPending ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : stats.error ? (
          <ErrorState message={errorText(stats.error)} onRetry={() => stats.refetch()} />
        ) : (
          <QuickStatsCard
            stats={[
              { label: t("pages.dashboard.overdue"), value: String(overdue.length), tone: overdue.length > 0 ? "danger" : undefined },
              { label: t("pages.dashboard.inProgress"), value: String(inProgress) },
            ]}
            extra={[
              { label: t("pages.dashboard.week"), value: formatDuration(stats.data.weekSeconds) },
              { label: t("pages.dashboard.month"), value: formatDuration(stats.data.monthSeconds) },
              { label: t("pages.dashboard.open"), value: String(stats.data.openIssueCount) },
              { label: t("pages.dashboard.weeklyGoal"), value: formatDuration(weeklyTarget) },
            ]}
            note={note}
          />
        )),
        "dashboard.summary": show.summary && (
          <PanelSection
            title={t("pages.dashboard.summary")}
            className="border-b xl:border-b-0 xl:border-r"
            actions={pending && (
              <Button variant="outline" size="sm" onClick={() => dayReview.set(true)}>
                <Sunset className="h-4 w-4" />
                {t("pages.dashboard.closeDay")}
              </Button>
            )}
          >
            {logs.isPending ? (
              <Skeleton className="h-80" />
            ) : logs.error ? (
              <ErrorState message={errorText(logs.error)} onRetry={() => logs.refetch()} />
            ) : (
              <PeriodSummary
                label={periodLabel}
                totalSeconds={derived.total}
                loggedSeconds={range.kind === "day" ? undefined : derived.logged}
                targetSeconds={target}
                legend={derived.legend}
                issues={issueTotals}
                colorOf={derived.colorOf}
                pending={pending}
                celebrate={range.kind === "day" && pending}
              />
            )}
            {stats.data && (
              <div className="mt-8">
                <SectionLabel as="h3" className="mb-3 px-0">{t("pages.dashboard.last14")}</SectionLabel>
                <PeriodBars
                  compact
                  stacks={stats.data.perDay.map(d => ({ day: parseDayKey(d.date) ?? today, parts: [{ project: "_", seconds: d.seconds }] }))}
                  colorOf={() => ({ fill: "bg-chart-focus", soft: "", solid: "", stroke: "" })}
                  targetFor={targetFor}
                  dense
                  pending
                />
              </div>
            )}
          </PanelSection>
        ),
        "dashboard.tasks": show.tasks && (
          <PanelSection
            title={t("pages.dashboard.myIssues")}
            className="border-b"
            actions={<Button asChild variant="outline" size="sm"><Link to="/board">{t("pages.dashboard.openBoard")}</Link></Button>}
          >
            {issues.isPending ? (
              <Skeleton className="h-72" />
            ) : issues.error ? (
              <ErrorState message={errorText(issues.error)} onRetry={() => issues.refetch()} />
            ) : (
              <TasksBoard columns={columns} collapsed={tasksCollapsed.collapsed} onToggle={tasksCollapsed.toggle} />
            )}
          </PanelSection>
        ),
        "dashboard.activity": show.activity && (
          <PanelSection title={t("pages.dashboard.recentActivity")}>
            {recent.isPending ? (
              <Skeleton className="h-48" />
            ) : recent.error ? (
              <ErrorState message={errorText(recent.error)} onRetry={() => recent.refetch()} />
            ) : (
              <ActivityTable rows={activity} />
            )}
          </PanelSection>
        ),
        "dashboard.recap": show.recap && (
          <PanelSection title={t("pages.dashboard.yourWeek")} className="border-t">
            {recent.isPending ? (
              <Skeleton className="h-28" />
            ) : recent.error ? (
              <ErrorState message={errorText(recent.error)} onRetry={() => recent.refetch()} />
            ) : (
              <WeekRecapCard recap={recap} targetFor={targetFor} pending summaryOf={top => issueByKey.get(issueId(top))?.summary} />
            )}
          </PanelSection>
        ),
        "dashboard.desk": (
          <ModuleSlot
            id="dashboard-widget"
            frame={boxes => (
              <PanelSection title={t("pages.dashboard.desk")} className="border-t [&:not(:has([data-module]:not([hidden])))]:hidden">
                <div className="grid gap-4 md:grid-cols-2">{boxes}</div>
              </PanelSection>
            )}
          />
        ),
      };
        return <DashboardSections content={sections} />;
      })()}

      <PlannedDialog
        day={range.from}
        entry={editingPlanned}
        open={planOpen}
        onOpenChange={open => {
          setPlanOpen(open);
          if (!open) setEditingPlanned(null);
        }}
        onLogActual={() => setLogOpen(true)}
      />
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("pages.dashboard.logTime")}</DialogTitle>
            <DialogDescription>
              {logDay
                ? t("pages.dashboard.logOnDay", {
                    provider,
                    day: dateFormat({ weekday: "long", day: "numeric", month: "long" }).format(logDay),
                  })
                : t("pages.dashboard.logPick", { provider })}
            </DialogDescription>
          </DialogHeader>
          <QuickLog day={logDay} onLogged={() => setLogOpen(false)} />
        </DialogContent>
      </Dialog>
      <GapCutter
        gap={gap}
        neighbours={neighbours}
        open={!!gap && !!openHole && gap.start.getTime() === openHole.start.getTime()}
        onOpenChange={open => !open && setGap(null)}
      />
    </>
  );
}

export default function Dashboard() {
  const deviceClass = useWorkspaceDeviceClass();
  return (
    <WorkspaceScopeProvider scope={{ surfaceId: "dashboard", deviceClass }}>
      <WorkspaceInteractionBoundary><DashboardContent /></WorkspaceInteractionBoundary>
    </WorkspaceScopeProvider>
  );
}
