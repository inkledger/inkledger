import { toastError } from "@/lib/errorText";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  formatDurationLong,
  formatSeconds,
  MAX_WORKLOG_SECONDS,
  parseDurationToSeconds,
  roundToMinute,
  toLocalInputValue,
} from "@contracts/time";
import { DURATION_PRESETS } from "@/lib/jira";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ToggleChip } from "@/components/app/ToggleChip";
import { useBlockPlacement } from "@/hooks/useBlockPlacement";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { useKeepsTimeHere, useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";
import { issueId } from "@/lib/issues";
import { useTimerActions } from "@/hooks/useTimerActions";
import { DiscardTimerDialog } from "@/components/TimerControls";
import { occupiedId, partsInput, partsLabel, type Placement } from "@contracts/placement";
import { FULL_BP, splitOf, stretchesOf } from "@contracts/timerSplit";

export type EditableWorklog = {
  /** inkledger's id: edits go by it when known */
  id?: number;
  remoteId: string;
  timeSpentSeconds: number;
  started: Date;
  comment: string;
  /** Its connection, when known */
  connectionId?: number | null;
};

/**
 * Seconds as a typed duration, never below one minute (Jira's granularity):
 * hours and minutes only, so a day in the work schedule never changes it.
 */
function durationInput(seconds: number): string {
  return formatSeconds(roundToMinute(seconds), { days: false });
}

type Props = {
  issueKey: string;
  /** The issue's connection, when a key may live on two. */
  connectionId?: number;
  worklog?: EditableWorklog;
  trigger?: React.ReactNode;
  onDone?: () => void;
  /** Pre-fills the duration (e.g. from a stopped timer). */
  prefillSeconds?: number;
  /** Pre-fills the comment (e.g. the note of a stopped timer). */
  prefillComment?: string;
  /** Pre-fills the start (e.g. a gap of the day). */
  prefillStart?: Date;
  /** Logging a stopped timer: the server clears the timer once saved. */
  fromTimer?: boolean;
  /** When the timer was stopped: the block ends there (and on that day). */
  endAt?: Date;
  /** Day to log on (default today, or the day of `endAt` / `prefillStart`). */
  day?: Date;
  /** Timer whose time this is (away time): its span is not a collision. */
  excludeTimer?: string;
  /** Controlled open state (optional; dialog is uncontrolled otherwise). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Custom dialog title (default: "Log time · KEY") */
  title?: string;
  /** Label of the dismiss button (default: "Cancel") */
  cancelLabel?: string;
};

export function LogTimeDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  ...form
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (o: boolean) => {
    setInternalOpen(o);
    onOpenChange?.(o);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        {/* Mounted only while open: every opening starts from fresh values. */}
        <LogTimeForm {...form} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function LogTimeForm({
  issueKey,
  connectionId,
  worklog,
  prefillSeconds,
  prefillComment,
  prefillStart,
  fromTimer = false,
  endAt,
  day,
  excludeTimer,
  onDone,
  onClose,
  title,
  cancelLabel,
}: Omit<Props, "trigger" | "open" | "onOpenChange"> & { onClose: () => void }) {
  const id = useId();
  const invalidate = useInvalidateWorklogs();
  const conn = connectionId ?? worklog?.connectionId;
  const provider = useProviderName(conn);
  // A tracker that keeps no time (GitHub): the entry stays here, said as such.
  const here = useKeepsTimeHere(conn);
  const [timeSpent, setTimeSpent] = useState(() =>
    worklog
      ? durationInput(worklog.timeSpentSeconds)
      : prefillSeconds
        ? durationInput(prefillSeconds)
        : ""
  );
  // A start chosen by hand (or given: edit, a hole, away time).
  const [started, setStarted] = useState(() =>
    worklog
      ? toLocalInputValue(new Date(worklog.started))
      : prefillStart
        ? toLocalInputValue(prefillStart)
        : ""
  );
  // Otherwise the block is placed by the shared rule: it ends now (or at the
  // timer stop), never over time already logged. Frozen at opening, so the
  // field does not move while typing.
  const [openedAt] = useState(() => new Date());
  // A timer run beside others: their time together is shared out by the percentages given here
  // (contracts/timerSplit.ts), each defaulting to what the others' logs left.
  const splitRead = trpc.timers.split.useQuery(
    { issueKey, connectionId, until: (endAt ?? openedAt).toISOString() },
    { enabled: fromTimer && !worklog, staleTime: Infinity, refetchOnWindowFocus: false }
  );
  const stretches = useMemo(
    () => (splitRead.data ? stretchesOf(splitRead.data.target, splitRead.data.runs, splitRead.data.shares) : null),
    [splitRead.data]
  );
  const [percents, setPercents] = useState<Record<string, string>>({});
  const given: Record<string, number> = {};
  for (const [key, typed] of Object.entries(percents)) {
    const n = Number(typed.replace(",", "."));
    if (typed.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100) given[key] = (n * FULL_BP) / 100;
  }
  const split = stretches && splitRead.data ? splitOf(splitRead.data.target, stretches, given, splitRead.data.trackedSeconds) : null;
  const sharing = split && split.groups.length > 0 ? split : null;
  // The duration follows "To log" until typed by hand.
  const [durationEdited, setDurationEdited] = useState(false);
  const placementDay =
    day ?? endAt ?? prefillStart ?? (worklog ? new Date(worklog.started) : undefined);
  const placement = useBlockPlacement(placementDay, {
    excludeTimer: fromTimer ? issueId({ key: issueKey, connectionId }) : excludeTimer,
    shared: sharing?.groups.flatMap(g => g.others),
  });
  /** Editing: the start field was changed by hand (else keep the original). */
  const [startedEdited, setStartedEdited] = useState(false);
  const [startedTouched, setStartedTouched] = useState(
    !!worklog || !!prefillStart
  );
  const [comment, setComment] = useState(
    worklog?.comment ?? prefillComment ?? ""
  );
  // A stopped timer's dialog closed without logging (Later, Esc, outside): what was
  // typed stays as the timer's note, so the next opening has it back.
  const utils = trpc.useUtils();
  const typed = useRef(comment);
  const settled = useRef(false);
  useEffect(
    () => () => {
      const note = typed.current.slice(0, 500);
      if (!fromTimer || settled.current || note === (prefillComment ?? "")) return;
      void utils.client.timers.setNote
        .mutate({ issueKey, connectionId: connectionId ?? undefined, note })
        .then(() => utils.timers.list.invalidate())
        .catch(() => {
          // The timer went meanwhile (logged elsewhere, discarded): nothing to keep the note on.
        });
    },
    // Once, on close: the refs carry the latest values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // A typed "1d" is the work schedule's day (of the day being logged).
  const { targetFor } = useWorkSchedule();
  // An untouched duration is the stored one: the field shows whole minutes,
  // and saving its rounding would change an edit of the comment alone.
  const timeShown = sharing && !durationEdited ? durationInput(sharing.toLogSeconds) : timeSpent;
  const parsed =
    worklog && timeShown === durationInput(worklog.timeSpentSeconds)
      ? worklog.timeSpentSeconds
      : parseDurationToSeconds(timeShown, {
          daySeconds: targetFor(placementDay ?? (started ? new Date(started) : openedAt)),
        });
  const tooLong = !!parsed && parsed > MAX_WORKLOG_SECONDS;
  const invalid =
    timeShown.trim().length > 0 && (!parsed || parsed <= 0 || tooLong);

  const changeDuration = (value: string) => {
    setDurationEdited(true);
    setTimeSpent(value);
  };
  const seconds = parsed && parsed > 0 ? parsed : (prefillSeconds ?? 3600);
  // Shared out as it ran: placed where its part of the time together sits, tiled with the others' parts.
  const pieces = sharing?.pieces && !durationEdited ? sharing.pieces.map(p => ({ start: new Date(p.start), seconds: p.seconds })) : null;
  const auto: Placement | null = startedTouched
    ? null
    : pieces
      ? { ok: true, start: pieces[0].start, ...(pieces.length > 1 ? { parts: pieces } : {}) }
      : placement.ready
        ? placement.place(seconds, { now: openedAt, endAt, tracked: fromTimer ? prefillSeconds : undefined })
        : null;
  const startedShown = startedTouched
    ? started
    : auto?.ok
      ? toLocalInputValue(auto.start)
      : "";
  // Placed around the day's break: one worklog per piece. A start chosen by hand is one piece.
  const parts = !startedTouched && auto?.ok ? auto.parts : undefined;
  // Editing without touching time or duration: what Jira has stays as is.
  const unchangedEdit =
    !!worklog && !startedEdited && parsed === worklog.timeSpentSeconds;
  // Time over time already logged: a warning by default (parallel work),
  // refused only with the "block" policy. A start nobody could place is
  // always needed from the user.
  const overlapPolicy =
    trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data
      ?.overlapPolicy ?? "warn";
  const overlap =
    auto && !auto.ok
      ? null
      : startedShown && parsed && parsed > 0 && !unchangedEdit
        ? (parts ?? [{ start: new Date(startedShown), seconds: parsed }])
            .map(block =>
              placement.conflictOf(block, worklog && occupiedId({ connectionId: conn ?? null, remoteId: worklog.remoteId }))
            )
            .find(m => m !== null) ?? null
        : null;
  const conflict =
    auto && !auto.ok
      ? t("ui.logTime.pickStart", { reason: auto.reason })
      : overlap && overlapPolicy === "block"
        ? overlap
        : null;
  const overlapWarning =
    overlap && !conflict ? t("ui.logTime.overlapWarning", { message: overlap }) : null;
  const waiting = !worklog && (!placement.ready || (fromTimer && splitRead.isPending));

  const onSuccess = () => {
    toast.success(
      here
        ? worklog
          ? t("ui.logTime.updatedHere")
          : t("ui.logTime.loggedHere")
        : worklog
          ? t("ui.logTime.updated", { provider })
          : t("ui.logTime.logged", { provider })
    );
    invalidate();
    onClose();
    onDone?.();
  };
  const onError = (e: unknown) => {
    settled.current = false;
    toastError(e);
  };
  const create = trpc.worklogs.create.useMutation({ onSuccess, onError });
  const update = trpc.worklogs.update.useMutation({ onSuccess, onError });
  const pending = create.isPending || update.isPending;
  const timerActions = useTimerActions(issueKey, connectionId);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const discardTimer = () => {
    settled.current = true;
    timerActions.discard({
      onSuccess: onClose,
      onError: () => {
        settled.current = false;
      },
    });
  };
  const canSubmit =
    !pending &&
    !waiting &&
    !conflict &&
    !!parsed &&
    parsed > 0 &&
    !tooLong &&
    !!startedShown;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // An untouched start is sent as stored: the minute-precision field would
    // otherwise round it, or shift it by an hour on the DST change night.
    const keepStart = worklog && !startedEdited;
    const payload = {
      seconds: parsed,
      started: keepStart
        ? new Date(worklog.started).toISOString()
        : new Date(startedShown).toISOString(),
      comment,
    };
    if (worklog)
      update.mutate({
        ...payload,
        ...(worklog.id !== undefined
          ? { id: worklog.id }
          : { issueKey, remoteId: worklog.remoteId, connectionId: conn ?? undefined }),
      });
    else {
      settled.current = true;
      create.mutate({
        ...payload,
        issueKey,
        connectionId,
        fromTimer,
        parts: parts && partsInput(parts, parsed),
        ...(sharing && splitRead.data
          ? { split: { until: new Date(splitRead.data.until).toISOString(), shares: sharing.groups.map(g => ({ with: g.others, bp: Math.round(g.bp) })) } }
          : {}),
      });
    }
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {title ??
            t(worklog ? "ui.logTime.titleEdit" : "ui.logTime.titleNew", {
              key: issueKey,
            })}
        </DialogTitle>
        <DialogDescription>
          {here ? t("ui.logTime.descriptionHere", { provider }) : t("ui.logTime.description", { provider })}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        {sharing && (
          <SplitSection
            id={id}
            split={sharing}
            keyOf={timer => timer.slice(timer.indexOf(":") + 1)}
            percents={percents}
            onPercent={(key, value) => {
              setDurationEdited(false);
              setPercents(p => ({ ...p, [key]: value }));
            }}
          />
        )}
        <div className="grid gap-2">
          <Label htmlFor={`${id}-time`}>{t("ui.logTime.timeSpent")}</Label>
          <Input
            id={`${id}-time`}
            placeholder={t("ui.logTime.timePlaceholder")}
            value={timeShown}
            onChange={e => changeDuration(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={`${id}-time-hint`}
            autoFocus
          />
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t("ui.logTime.presets")}
          >
            {DURATION_PRESETS.map(p => (
              <ToggleChip
                key={p}
                pressed={timeShown === p}
                onClick={() => changeDuration(p)}
              >
                {p}
              </ToggleChip>
            ))}
          </div>
          <p
            id={`${id}-time-hint`}
            className={cn(
              "text-body-sm",
              invalid ? "text-danger" : "text-muted-foreground"
            )}
          >
            {tooLong
              ? t("ui.logTime.tooLong")
              : invalid
                ? t("ui.logTime.badFormat")
                : parsed && parsed > 0
                  ? `= ${formatSeconds(parsed)}`
                  : t("ui.logTime.units")}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-started`}>{t("ui.logTime.start")}</Label>
          <Input
            id={`${id}-started`}
            type="datetime-local"
            value={startedShown}
            aria-invalid={!!conflict || undefined}
            aria-describedby={`${id}-started-hint`}
            onChange={e => {
              setStartedTouched(true);
              setStartedEdited(true);
              setStarted(e.target.value);
            }}
          />
          <p
            id={`${id}-started-hint`}
            role={conflict || overlapWarning || (waiting && placement.error) ? "alert" : undefined}
            className={cn(
              "text-body-sm",
              conflict || (waiting && placement.error)
                ? "text-danger"
                : overlapWarning
                  ? "text-warning"
                  : "text-muted-foreground"
            )}
          >
            {conflict ??
              overlapWarning ??
              (waiting
                ? placement.error
                  ? t("ui.logTime.placementFailed")
                  : t("ui.logTime.computing")
                : pieces && !startedTouched
                  ? t("ui.logTime.split.placed", { parts: partsLabel(pieces) })
                  : parts
                  ? t("ui.logTime.splitAroundBreak", { parts: partsLabel(parts) })
                  : !startedTouched && auto?.ok && auto.overBreak
                    ? t("ui.logTime.overBreak")
                    : !startedTouched && startedShown
                      ? endAt
                        ? t("ui.logTime.endsAtStop")
                        : t("ui.logTime.endsNow")
                      : "\u00a0")}
          </p>
          {waiting && placement.error && (
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={placement.retry}>
              {t("common.retry")}
            </Button>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-comment`}>{t("ui.logTime.comment")}</Label>
          <Textarea
            id={`${id}-comment`}
            placeholder={t("ui.logTime.commentPlaceholder")}
            value={comment}
            onChange={e => {
              typed.current = e.target.value;
              setComment(e.target.value);
            }}
            rows={3}
          />
        </div>
      </div>
      <DialogFooter>
        {/* A timer started by mistake: gone from here, without logging its time. */}
        {fromTimer && (
          <Button
            type="button"
            variant="ghost"
            className="text-danger sm:mr-auto"
            disabled={pending || timerActions.pending}
            onClick={() => setConfirmingDiscard(true)}
          >
            {t("ui.logTime.discardTimer")}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          {cancelLabel ?? t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {pending
            ? t("common.saving")
            : waiting
              ? t("ui.logTime.calc")
              : worklog
                ? t("ui.logTime.update")
                : t("ui.logTime.log")}
        </Button>
      </DialogFooter>
      {fromTimer && (
        <DiscardTimerDialog
          issueKey={issueKey}
          connectionId={connectionId}
          open={confirmingDiscard}
          onOpenChange={setConfirmingDiscard}
          onConfirm={discardTimer}
        />
      )}
    </form>
  );
}

/**
 * The time a timer ran beside others: alone, then a row per set of timers it
 * ran with (its percentage of that time, typed), then what it logs. Above
 * 100 % together with the others' logs: said, not refused (counted twice).
 */
function SplitSection({
  id,
  split,
  keyOf,
  percents,
  onPercent,
}: {
  id: string;
  split: NonNullable<ReturnType<typeof splitOf>>;
  keyOf: (timer: string) => string;
  percents: Record<string, string>;
  onPercent: (key: string, value: string) => void;
}) {
  const minutes = (seconds: number) => formatDurationLong(Math.round(seconds / 60) * 60);
  return (
    <section aria-labelledby={`${id}-split`} className="grid gap-2 border-b pb-4">
      <h3 id={`${id}-split`} className="text-body-sm font-medium">
        {t("ui.logTime.split.title")}
      </h3>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-body-sm tabular">
        <span className="text-muted-foreground">{t("ui.logTime.split.alone")}</span>
        <span className="text-right">{minutes(split.aloneSeconds)}</span>
        {split.groups.map(g => {
          const keys = g.others.map(keyOf).join(", ");
          return (
            <div key={g.key} className="col-span-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {t("ui.logTime.split.with", { keys, duration: minutes(g.seconds) })}
              </span>
              <span className="flex items-center gap-1.5">
                <Input
                  inputMode="decimal"
                  className="w-16 text-right"
                  aria-label={t("ui.logTime.split.shareFor", { keys, duration: minutes(g.seconds) })}
                  value={percents[g.key] ?? String(Math.round(g.defaultBp / 100))}
                  onChange={e => onPercent(g.key, e.target.value)}
                />
                <span aria-hidden>%</span>
                <span className="w-20 text-right text-muted-foreground" aria-live="polite">
                  → {minutes(g.shareSeconds)}
                </span>
              </span>
            </div>
          );
        })}
        <span className="border-t pt-2 font-medium">{t("ui.logTime.split.toLog")}</span>
        <span className="border-t pt-2 text-right font-medium" aria-live="polite">
          {minutes(split.toLogSeconds)}
        </span>
      </div>
      {split.overBp > FULL_BP && (
        <p role="status" className="text-body-sm text-warning">
          {t("ui.logTime.split.over", { percent: Math.round(split.overBp / 100) })}
        </p>
      )}
    </section>
  );
}
