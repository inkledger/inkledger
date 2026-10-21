import { useId, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  formatSeconds,
  MAX_WORKLOG_SECONDS,
  parseDurationToSeconds,
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
import { occupiedId } from "@contracts/placement";

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
  return formatSeconds(Math.max(60, Math.round(seconds / 60) * 60), { days: false });
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
  const placementDay =
    day ?? endAt ?? prefillStart ?? (worklog ? new Date(worklog.started) : undefined);
  const placement = useBlockPlacement(placementDay, {
    excludeTimer: fromTimer ? issueId({ key: issueKey, connectionId }) : excludeTimer,
  });
  /** Editing: the start field was changed by hand (else keep the original). */
  const [startedEdited, setStartedEdited] = useState(false);
  const [startedTouched, setStartedTouched] = useState(
    !!worklog || !!prefillStart
  );
  const [comment, setComment] = useState(
    worklog?.comment ?? prefillComment ?? ""
  );

  // A typed "1d" is the work schedule's day (of the day being logged).
  const { targetFor } = useWorkSchedule();
  // An untouched duration is the stored one: the field shows whole minutes,
  // and saving its rounding would change an edit of the comment alone.
  const parsed =
    worklog && timeSpent === durationInput(worklog.timeSpentSeconds)
      ? worklog.timeSpentSeconds
      : parseDurationToSeconds(timeSpent, {
          daySeconds: targetFor(placementDay ?? (started ? new Date(started) : openedAt)),
        });
  const tooLong = !!parsed && parsed > MAX_WORKLOG_SECONDS;
  const invalid =
    timeSpent.trim().length > 0 && (!parsed || parsed <= 0 || tooLong);

  const changeDuration = (value: string) => setTimeSpent(value);
  const seconds = parsed && parsed > 0 ? parsed : (prefillSeconds ?? 3600);
  const auto =
    !startedTouched && placement.ready
      ? placement.place(seconds, { now: openedAt, endAt })
      : null;
  const startedShown = startedTouched
    ? started
    : auto?.ok
      ? toLocalInputValue(auto.start)
      : "";
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
        ? placement.conflictOf(
            { start: new Date(startedShown), seconds: parsed },
            worklog && occupiedId({ connectionId: conn ?? null, remoteId: worklog.remoteId })
          )
        : null;
  const conflict =
    auto && !auto.ok
      ? t("ui.logTime.pickStart", { reason: auto.reason })
      : overlap && overlapPolicy === "block"
        ? overlap
        : null;
  const overlapWarning =
    overlap && !conflict ? t("ui.logTime.overlapWarning", { message: overlap }) : null;
  const waiting = !worklog && !placement.ready;

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
  const onError = (e: { message: string }) => toast.error(e.message);
  const create = trpc.worklogs.create.useMutation({ onSuccess, onError });
  const update = trpc.worklogs.update.useMutation({ onSuccess, onError });
  const pending = create.isPending || update.isPending;
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
          : { issueKey, remoteId: worklog.remoteId }),
      });
    else create.mutate({ ...payload, issueKey, connectionId, fromTimer });
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
        <div className="grid gap-2">
          <Label htmlFor={`${id}-time`}>{t("ui.logTime.timeSpent")}</Label>
          <Input
            id={`${id}-time`}
            placeholder={t("ui.logTime.timePlaceholder")}
            value={timeSpent}
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
                pressed={timeSpent === p}
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
            role={conflict || overlapWarning ? "alert" : undefined}
            className={cn(
              "text-body-sm",
              conflict
                ? "text-danger"
                : overlapWarning
                  ? "text-warning"
                  : "text-muted-foreground"
            )}
          >
            {conflict ??
              overlapWarning ??
              (waiting
                ? t("ui.logTime.computing")
                : !startedTouched && startedShown
                  ? endAt
                    ? t("ui.logTime.endsAtStop")
                    : t("ui.logTime.endsNow")
                  : "\u00a0")}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-comment`}>{t("ui.logTime.comment")}</Label>
          <Textarea
            id={`${id}-comment`}
            placeholder={t("ui.logTime.commentPlaceholder")}
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={3}
          />
        </div>
      </div>
      <DialogFooter>
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
    </form>
  );
}
