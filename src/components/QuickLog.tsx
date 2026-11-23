import { timeOfDay } from "@/lib/dates";
import { toastError } from "@/lib/errorText";
import { useId, useRef, useState } from "react";
import { newOpId } from "@/lib/timerConflict";
import { trpc } from "@/lib/trpc";
import { visibleIssues } from "@/lib/issues";
import { formatDuration, MAX_WORKLOG_SECONDS, parseDurationToSeconds, toLocalInputValue } from "@contracts/time";
import { partsInput, partsLabel } from "@contracts/placement";
import { DURATION_PRESETS } from "@/lib/jira";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import { toast } from "sonner";
import { ToggleChip } from "@/components/app/ToggleChip";
import { IssuePicker, type IssueRef } from "@/components/app/IssuePicker";
import { useBlockPlacement } from "@/hooks/useBlockPlacement";
import { useWorkSchedule } from "@/hooks/useWorkSchedule";
import { cn } from "@/lib/utils";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { durationInput, secondsToEnd, type TimeAs } from "@/lib/timeAs";
import { useTimeAs } from "@/hooks/useTimeAs";
import { t } from "@/i18n";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";


/**
 * Fastest path to log time: pick an issue (themed searchable picker),
 * tap a duration preset (or type an end time), optionally add a comment, done.
 */
export function QuickLog({
  onLogged,
  day,
  saveControl,
}: {
  onLogged?: () => void;
  /** Another day than today: the block goes after that day's last one. */
  day?: Date;
  /** FlowMap's mark for the save button, from the host that counts it (the Dashboard). */
  saveControl?: FlowControlAttributes;
} = {}) {
  const id = useId();
  const invalidate = useInvalidateWorklogs();
  const issues = trpc.issues.all.useQuery();
  const [issueKey, setIssueKey] = useState<IssueRef | null>(null);
  const [timeSpent, setTimeSpent] = useState("");
  const [comment, setComment] = useState("");
  // Shared rule: today the block ends now, other days it follows the last
  // one; never over time already logged. "Now" is when the form opened.
  const placement = useBlockPlacement(day);
  const [openedAt] = useState(() => new Date());
  // By end time (as in LogTimeDialog): the start shown when it was chosen, then in its field.
  const [started, setStarted] = useState("");
  // Pinned once an end is chosen: from then the start is the field's, emptied too.
  const [startPinned, setStartPinned] = useState(false);
  const timeAs = useTimeAs({
    pinStart: s => {
      setStarted(s);
      setStartPinned(true);
    },
    toDuration: s => setTimeSpent(durationInput(s)),
  });
  const byEnd = timeAs.mode === "end";
  // One log asked for: a retry is answered, not logged twice; a new one after each success.
  const opId = useRef(newOpId());

  const create = trpc.worklogs.create.useMutation({
    onSuccess: (w, input) => {
      opId.current = newOpId();
      toast.success(
        t("ui.quickLog.logged", {
          // All of it, when it went in pieces around a break.
          duration: formatDuration(input.seconds ?? w.timeSpentSeconds),
          key: w.issueKey,
        })
      );
      setTimeSpent("");
      setComment("");
      setStarted("");
      setStartPinned(false);
      timeAs.reset();
      invalidate();
      onLogged?.();
    },
    onError: e => toastError(e),
  });

  const list = visibleIssues(issues.data ?? []);
  const matched = issueKey
    ? (list.find(
        i => i.key === issueKey.key && i.connectionId === issueKey.connectionId
      ) ?? null)
    : null;
  const favorites = list.filter(i => i.favorite === 1).slice(0, 8);

  // A typed "1d" is the work schedule's day.
  const { targetFor } = useWorkSchedule();
  const endSeconds = byEnd ? secondsToEnd(started, timeAs.end) : null;
  const parsed = byEnd
    ? endSeconds !== null && endSeconds > 0
      ? endSeconds
      : null
    : parseDurationToSeconds(timeSpent, { daySeconds: targetFor(day ?? openedAt) });
  const tooLong = !!parsed && parsed > MAX_WORKLOG_SECONDS;
  // Placed by the shared rule until an end pins its start (an hour stands in for a length not typed yet).
  const seconds = parsed && parsed > 0 ? parsed : (timeAs.pending ?? 3600);
  const pinned = byEnd && startPinned;
  const auto = !pinned && placement.ready ? placement.place(seconds, { now: openedAt }) : null;
  const shown = { start: pinned ? started : auto?.ok ? toLocalInputValue(auto.start) : "", placed: placement.ready, seconds };
  timeAs.settle(byEnd, shown);
  const placed = !byEnd && parsed && parsed > 0 ? auto : null;
  // By end the block is the one typed: over time already logged, warned or refused as in LogTimeDialog.
  const overlapPolicy = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data?.overlapPolicy ?? "warn";
  const typedBlock = pinned && started && parsed && parsed > 0 && placement.ready ? { start: new Date(started), seconds: parsed } : null;
  const overlap = typedBlock ? placement.conflictOf(typedBlock) : null;
  const conflict = overlap && overlapPolicy === "block" ? overlap : null;
  const start = byEnd ? typedBlock?.start : placed?.ok ? placed.start : undefined;
  const canSubmit =
    !!matched && !!parsed && parsed > 0 && !tooLong && !!start && !conflict && !create.isPending;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit || !matched || !parsed || !start) return;
    create.mutate({
      issueKey: matched.key,
      connectionId: matched.connectionId,
      opId: opId.current,
      seconds: parsed,
      started: start.toISOString(),
      comment,
      parts: !byEnd && placed?.ok && placed.parts ? partsInput(placed.parts, parsed) : undefined,
    });
  };
  const switchMode = (next: TimeAs) => timeAs.switchTo(next, shown, parsed);
  const endInvalid = byEnd && timeAs.end !== "" && !!started && (!parsed || tooLong);
  // What the time typed by end makes: an error, an overlap, or its span.
  const endNote: { tone: "danger" | "warning" | "muted"; text: string } | null = !byEnd
    ? null
    : tooLong
      ? { tone: "danger", text: t("ui.logTime.tooLong") }
      : endInvalid
        ? { tone: "danger", text: t("ui.logTime.endBeforeStart") }
        : conflict
          ? { tone: "danger", text: conflict }
          : overlap
            ? { tone: "warning", text: t("ui.logTime.overlapWarning", { message: overlap }) }
            : typedBlock
              ? { tone: "muted", text: t("ui.quickLog.range", { from: timeOfDay(typedBlock.start), to: timeOfDay(new Date(typedBlock.start.getTime() + typedBlock.seconds * 1000)) }) }
              : null;

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className={cn("grid gap-3", !byEnd && "sm:grid-cols-[1fr_8rem]")}>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-issue`}>{t("ui.quickLog.issue")}</Label>
          <IssuePicker
            id={`${id}-issue`}
            issues={list}
            value={issueKey}
            onChange={setIssueKey}
          />
        </div>
        {!byEnd && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-time`}>{t("ui.quickLog.duration")}</Label>
            <Input
              id={`${id}-time`}
              placeholder="2h 30m"
              value={timeSpent}
              onChange={e => setTimeSpent(e.target.value)}
              aria-invalid={timeSpent.trim() !== "" && (!parsed || tooLong)}
            />
          </div>
        )}
      </div>
      {byEnd && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-start`}>{t("ui.logTime.start")}</Label>
            <Input
              id={`${id}-start`}
              type="datetime-local"
              value={shown.start}
              aria-invalid={!!conflict || undefined}
              onChange={e => setStarted(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-end`}>{t("ui.logTime.end")}</Label>
            <Input
              id={`${id}-end`}
              type="datetime-local"
              value={timeAs.end}
              aria-invalid={endInvalid}
              onChange={e => timeAs.setEnd(e.target.value)}
            />
          </div>
        </div>
      )}

      {favorites.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label={t("ui.quickLog.favorites")}
        >
          {favorites.map(f => (
            <ToggleChip
              key={`${f.connectionId}:${f.key}`}
              size="sm"
              pressed={matched?.key === f.key && matched.connectionId === f.connectionId}
              onClick={() => setIssueKey({ key: f.key, connectionId: f.connectionId })}
              title={f.summary}
            >
              {f.key}
            </ToggleChip>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {!byEnd && (
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label={t("ui.quickLog.presets")}
          >
            {DURATION_PRESETS.map(p => (
              <ToggleChip
                key={p}
                pressed={timeSpent === p}
                onClick={() => setTimeSpent(p)}
              >
                {p}
              </ToggleChip>
            ))}
          </div>
        )}
        <SegmentedControl
          className="ml-auto"
          label={t("ui.logTime.mode")}
          value={timeAs.mode}
          onChange={switchMode}
          options={[
            { value: "duration", label: t("ui.logTime.byDuration") },
            { value: "end", label: t("ui.logTime.byEnd") },
          ]}
        />
      </div>
      {endNote && (
        <p
          role={endNote.tone === "muted" ? undefined : "alert"}
          className={cn(
            "text-body-sm",
            endNote.tone === "danger" ? "text-danger" : endNote.tone === "warning" ? "text-warning" : "text-muted-foreground"
          )}
        >
          {endNote.text}
        </p>
      )}
      {placed && (
        <p
          role={placed.ok ? undefined : "alert"}
          className={cn(
            "text-body-sm",
            placed.ok ? "text-muted-foreground" : "text-danger"
          )}
        >
          {!placed.ok
            ? t("ui.quickLog.noRoom", { reason: placed.reason })
            : placed.parts
              ? t("ui.logTime.splitAroundBreak", { parts: partsLabel(placed.parts) })
              : t("ui.quickLog.range", {
                  from: timeOfDay(placed.start),
                  to: timeOfDay(new Date(placed.start.getTime() + (parsed ?? 0) * 1000)),
                })}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input
          aria-label={t("ui.quickLog.comment")}
          placeholder={t("ui.quickLog.commentPlaceholder")}
          value={comment}
          onChange={e => setComment(e.target.value)}
        />
        <Button type="submit" disabled={!canSubmit} {...saveControl}>
          {create.isPending
            ? t("common.saving")
            : (parsed || timeAs.pending !== null) && !placement.ready
              ? t("ui.quickLog.computing")
              : t("ui.quickLog.submit")}
        </Button>
      </div>
      {placement.error && (
        <p role="alert" className="flex items-center gap-2 text-body-sm text-danger">
          {t("ui.logTime.placementFailed")}
          <Button type="button" variant="outline" size="sm" onClick={placement.retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
    </form>
  );
}
