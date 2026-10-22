import { useMemo, useRef, useState } from "react";
import {
  Check,
  Clock,
  Loader2,
  Plus,
  Sunset,
  TriangleAlert,
} from "lucide-react";
import {
  formatDuration,
  formatDurationLong,
  formatSeconds,
  MAX_WORKLOG_SECONDS,
  parseDurationToSeconds,
  startOfDay,
  addDays,
  dayKey,
} from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { logSpan } from "@/lib/timerLog";
import { issueId } from "@/lib/issues";
import { useTimers } from "@/hooks/useTimers";
import { useBlockPlacement } from "@/hooks/useBlockPlacement";
import { placeBlock, type Occupied } from "@contracts/placement";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import {
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { GoalProgress } from "@/components/dashboard/PeriodSummary";
import { SectionLabel } from "@/components/app/PageHeader";
import { projectOf } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { toast } from "sonner";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { missingSpans } from "@contracts/workSchedule";
import { useProviderName } from "@/hooks/useConnections";
import { dateFormat, t } from "@/i18n";
import { workedSeconds } from "@/lib/worked";

const time = () => dateFormat({ hour: "2-digit", minute: "2-digit" });
type Draft = {
  issueKey: string;
  connectionId?: number | null;
  include: boolean;
  duration: string;
  /** Edited by hand: keep it; otherwise running timers count up to confirm. */
  touched: boolean;
  comment: string;
};
type RowStatus = "idle" | "saving" | "done" | "error";

/** Read at event time (handlers), never during render. */
const nowMs = () => Date.now();

const roundedMinutes = (s: number) => Math.max(60, Math.round(s / 60) * 60);

/** The day review's content (DayReview.tsx draws its sheet): loaded on demand. */
export function DayReviewBody() {
  const provider = useProviderName();
  const [now] = useState(() => new Date());
  const today = useMemo(() => startOfDay(now), [now]);
  const { timers, fetchedAt } = useTimers();
  const { forDay, targetFor } = useWorkSchedule();
  const issues = trpc.issues.all.useQuery(undefined, { staleTime: 60_000 });
  // Today's worklogs and timers: where the batch may go (never over them).
  const placement = useBlockPlacement(today);
  const logs = trpc.worklogs.list.useQuery({
    from: today.toISOString(),
    to: addDays(today, 1).toISOString(),
  });
  const invalidate = useInvalidateWorklogs();
  const utils = trpc.useUtils();
  const create = trpc.worklogs.create.useMutation();

  const summaries = useMemo(
    () => new Map((issues.data ?? []).map(i => [issueId(i), i.summary])),
    [issues.data]
  );
  const draftFor = (t: (typeof timers)[number]): Draft => ({
    issueKey: t.issueKey,
    connectionId: t.connectionId,
    include: t.elapsedSeconds >= 60,
    duration: formatSeconds(roundedMinutes(t.elapsedSeconds), { days: false }),
    touched: false,
    comment: t.note,
  });
  const [drafts, setDrafts] = useState<Draft[]>(() => timers.map(draftFor));
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  // Timers started, or logged elsewhere, while the sheet is open: the rows
  // follow (a gone timer would fail as "already logged"). Rows this sheet
  // already handled stay, with their outcome. Adjusted while rendering, as
  // React suggests for state derived from a changed prop.
  const timerKeys = timers.map(t => issueId(t)).join(" ");
  const [seenKeys, setSeenKeys] = useState(timerKeys);
  if (seenKeys !== timerKeys) {
    setSeenKeys(timerKeys);
    const live = new Set(timers.map(t => issueId(t)));
    const kept = drafts.filter(
      d => live.has(issueId(d)) || (status[issueId(d)] ?? "idle") !== "idle"
    );
    const known = new Set(kept.map(d => issueId(d)));
    const added = timers.filter(t => !known.has(issueId(t))).map(draftFor);
    if (added.length > 0 || kept.length !== drafts.length) setDrafts([...kept, ...added]);
  }
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  const target = targetFor(today);
  // The hours worked today: parallel work once.
  const logged = workedSeconds(logs.data ?? []);

  // Working time of today's schedule covered neither by worklogs nor by
  // timers (each up to its stop), breaks excluded.
  const gaps = useMemo(
    () =>
      placement.ready
        ? missingSpans(today, forDay(today), placement.occupied, now)
        : [],
    [placement.ready, placement.occupied, today, now, forDay]
  );

  // Running timers keep counting while the sheet is open: untouched rows
  // take their live value when the batch is confirmed.
  const liveSeconds = (id: string): number | null => {
    const t = timers.find(x => issueId(x) === id);
    if (!t || t.state !== "running") return null;
    return roundedMinutes(t.elapsedSeconds + (nowMs() - fetchedAt) / 1000);
  };
  const [frozen, setFrozen] = useState<Map<string, number> | null>(null);
  const parsed = drafts.map(
    d => frozen?.get(issueId(d)) ?? parseDurationToSeconds(d.duration, { daySeconds: targetFor(new Date()) })
  );
  const selected = drafts
    .map((d, i) => ({ ...d, seconds: parsed[i] }))
    .filter(
      (d): d is Draft & { seconds: number } =>
        d.include &&
        !!d.seconds &&
        d.seconds > 0 &&
        d.seconds <= MAX_WORKLOG_SECONDS &&
        status[issueId(d)] !== "done"
    );
  const selectedTotal = selected.reduce((a, d) => a + d.seconds, 0);

  const patch = (id: string, p: Partial<Draft>) =>
    setDrafts(ds =>
      ds.map(d =>
        issueId(d) === id
          ? { ...d, ...p, touched: d.touched || p.duration !== undefined }
          : d
      )
    );

  /** Snapshot live durations for the confirmation (and the batch). */
  const openConfirm = () => {
    const live = new Map<string, number>();
    for (const d of drafts) {
      const v = d.touched ? null : liveSeconds(issueId(d));
      if (v !== null) live.set(issueId(d), v);
    }
    setFrozen(live);
    setConfirming(true);
  };

  /** Set at once by logAll: the dialog's own close, in the same click, must keep the snapshot. */
  const logging = useRef(false);

  const logAll = async () => {
    logging.current = true;
    setConfirming(false);
    setRunning(true);
    // Each timer ends where it was stopped (now if still running), placed by
    // the shared rule: never over a worklog, another timer or a block just
    // placed, never before today's midnight.
    const at = new Date(nowMs());
    const batchKeys = new Set(selected.map(d => issueId(d)));
    const occupied: Occupied[] = placement.occupied.filter(
      o => !(o.timer && batchKeys.has(o.timer))
    );
    const endOf = (id: string): Date => {
      const t = timers.find(x => issueId(x) === id);
      return t?.state === "running" || !t?.pausedAt ? at : new Date(t.pausedAt);
    };
    let ok = 0;
    const latestFirst = [...selected].sort(
      (a, b) => endOf(issueId(b)).getTime() - endOf(issueId(a)).getTime()
    );
    for (const d of latestFirst) {
      let paused: string | null = null;
      const timer = timers.find(t => issueId(t) === issueId(d));
      const endAt = endOf(issueId(d));
      const placed =
        dayKey(endAt) === dayKey(today)
          ? placeBlock({
              day: today,
              seconds: d.seconds,
              occupied,
              schedule: forDay(today),
              now: at,
              endAt,
              // What the timer tracked up to then: typed over it, the block is not that work.
              tracked: timer ? timer.elapsedSeconds + (timer.state === "running" ? Math.max(0, at.getTime() - fetchedAt) / 1000 : 0) : undefined,
            })
          : ({
              ok: false,
              reason: t("ui.dayReview.otherDay"),
              with: [],
            } as const);
      if (!placed.ok) {
        setStatus(s => ({ ...s, [issueId(d)]: "error" }));
        toast.error(`${d.issueKey}: ${placed.reason}`);
        continue;
      }
      setStatus(s => ({ ...s, [issueId(d)]: "saving" }));
      try {
        // A running timer is paused first: its time is the one being logged.
        if (timer?.state === "running") {
          await utils.client.timers.pause.mutate({ issueKey: d.issueKey, connectionId: timer.connectionId });
          paused = issueId(d);
        }
        await create.mutateAsync({
          issueKey: d.issueKey,
          connectionId: timer?.connectionId,
          seconds: d.seconds,
          started: placed.start.toISOString(),
          comment: d.comment.trim(),
          fromTimer: true,
        });
        ok++;
        occupied.push({ start: placed.start, seconds: d.seconds, label: d.issueKey });
        setStatus(s => ({ ...s, [issueId(d)]: "done" }));
      } catch (e) {
        // Not logged: the timer we paused keeps running as before.
        if (paused === issueId(d))
          await utils.client.timers.start
            .mutate({ issueKey: d.issueKey, connectionId: timer?.connectionId })
            .catch(() => undefined);
        setStatus(s => ({ ...s, [issueId(d)]: "error" }));
        toast.error(
          `${d.issueKey}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    logging.current = false;
    setRunning(false);
    setFrozen(null);
    invalidate();
    void utils.timers.list.invalidate();
    if (ok > 0) toast.success(t("ui.dayReview.logged", { count: ok, provider }));
  };

  const remaining = Math.max(0, target - logged - selectedTotal);

  return (
    <>
      <SheetHeader className="border-b p-5">
        <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary-strong" {...surface("picture")}>
          <Sunset className="h-5 w-5" aria-hidden />
        </span>
        <SheetTitle className="font-display text-title">
          {t("ui.dayReview.title")}
        </SheetTitle>
        <SheetDescription>
          {t("ui.dayReview.description", { provider })}
        </SheetDescription>
      </SheetHeader>

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <section className="border-b p-5">
          <p className="text-body-sm text-muted-foreground">{t("ui.dayReview.loggedToday")}</p>
          <p className="mt-1 font-display text-title tabular">
            {formatDurationLong(logged)}
          </p>
          <GoalProgress
            className="mt-3"
            totalSeconds={logged}
            targetSeconds={target}
            pending
          />
        </section>

        <section className="border-b p-5">
          <SectionLabel as="h3" className="mb-3 px-0">
            {t("ui.dayReview.toLog")}
          </SectionLabel>
          {drafts.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">
              {t("ui.dayReview.noTimers")}
            </p>
          ) : (
            <ul className="grid gap-2">
              {drafts.map((d, i) => {
                const st = status[issueId(d)] ?? "idle";
                const bad =
                  d.include &&
                  (!parsed[i] ||
                    (parsed[i] ?? 0) <= 0 ||
                    (parsed[i] ?? 0) > MAX_WORKLOG_SECONDS);
                return (
                  <li
                    key={issueId(d)}
                    className={cn(
                      "grid min-w-0 gap-2 rounded-lg border p-3 transition-opacity",
                      (!d.include || st === "done") && "opacity-60"
                    )}
                    {...surface("card")}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        checked={d.include}
                        disabled={running || st === "done"}
                        onCheckedChange={v =>
                          patch(issueId(d), { include: v === true })
                        }
                        aria-label={t("ui.dayReview.include", { key: d.issueKey })}
                      />
                      <span className="font-medium">{d.issueKey}</span>
                      <span className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground">
                        {summaries.get(issueId(d)) ?? projectOf(d.issueKey)}
                      </span>
                      <RowBadge status={st} />
                    </div>
                    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
                      <Input
                        value={d.duration}
                        onChange={e =>
                          patch(issueId(d), { duration: e.target.value })
                        }
                        disabled={running || st === "done"}
                        aria-invalid={bad}
                        aria-label={t("ui.dayReview.durationOf", { key: d.issueKey })}
                        className="h-8 tabular"
                      />
                      <Input
                        value={d.comment}
                        onChange={e =>
                          patch(issueId(d), { comment: e.target.value })
                        }
                        disabled={running || st === "done"}
                        placeholder={t("ui.dayReview.commentPlaceholder")}
                        aria-label={t("ui.dayReview.commentOf", { key: d.issueKey })}
                        className="h-8"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="p-5">
          <SectionLabel as="h3" className="mb-3 px-0">
            {t("ui.dayReview.gaps")}
          </SectionLabel>
          {gaps.length === 0 ? (
            <p className="text-body-sm text-muted-foreground">
              {target === 0
                ? t("ui.dayReview.notWorkday")
                : t("ui.dayReview.noGaps")}
            </p>
          ) : (
            <ul className="divide-y">
              {gaps.map(g => (
                <li
                  key={g.start.getTime()}
                  className="flex items-center gap-3 py-2.5"
                >
                  <span className="stripes-idle h-8 w-1.5 shrink-0 rounded-full" {...surface("glass")} />
                  <span className="text-body-sm tabular">
                    {time().format(g.start)} –{" "}
                    {time().format(
                      new Date(g.start.getTime() + g.seconds * 1000)
                    )}
                  </span>
                  <span className="text-body-sm text-muted-foreground">
                    {formatDuration(g.seconds)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      logSpan(g.start, roundedMinutes(g.seconds))
                    }
                  >
                    <Plus className="h-4 w-4" /> {t("ui.dayReview.log")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <SheetFooter className="flex-row items-center gap-3 border-t p-5">
        <p className="mr-auto text-body-sm text-muted-foreground">
          {selected.length > 0
            ? t("ui.dayReview.summary", {
                duration: formatDurationLong(selectedTotal),
                count: selected.length,
              })
            : t("ui.dayReview.nothingSelected")}
          {remaining > 0 && selected.length > 0 && (
            <span className="block text-caption">
              {t("ui.dayReview.remaining", { duration: formatDurationLong(remaining) })}
            </span>
          )}
        </p>
        <Button
          disabled={selected.length === 0 || running}
          onClick={openConfirm}
        >
          {running ? (
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {selected.length > 0
            ? t("ui.dayReview.logNToJira", { count: selected.length, provider })
            : t("ui.dayReview.logToJira", { provider })}
        </Button>
      </SheetFooter>

      <AlertDialog
        open={confirming}
        onOpenChange={o => {
          setConfirming(o);
          // Cancelled: the live values again. Confirmed: the snapshot stands for the save
          // (this runs in the same click as logAll, before "running" is drawn).
          if (!o && !logging.current) setFrozen(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ui.dayReview.confirmTitle", { provider })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>
                  {t("ui.dayReview.confirmBody", {
                    count: selected.length,
                    duration: formatDurationLong(selectedTotal),
                  })}
                </p>
                <ul className="mt-2 grid gap-1">
                  {selected.map(d => (
                    <li key={issueId(d)} className="flex justify-between gap-3">
                      <span className="font-medium text-foreground">
                        {d.issueKey}
                      </span>
                      <span className="tabular">
                        {formatDurationLong(d.seconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void logAll()}>
              {t("ui.dayReview.log")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RowBadge({ status }: { status: RowStatus }) {
  if (status === "saving")
    return (
      <Loader2
        className="h-4 w-4 text-muted-foreground motion-safe:animate-spin"
        aria-label={t("ui.dayReview.saving")}
      />
    );
  if (status === "done")
    return <Check className="h-4 w-4 text-success" aria-label={t("ui.dayReview.done")} />;
  if (status === "error")
    return (
      <TriangleAlert className="h-4 w-4 text-danger" aria-label={t("ui.dayReview.error")} />
    );
  return <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />;
}
