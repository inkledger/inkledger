import { timeOfDay } from "@/lib/dates";
import { toastError } from "@/lib/errorText";
import { useId, useState } from "react";
import { trpc } from "@/lib/trpc";
import { visibleIssues } from "@/lib/issues";
import { formatDuration, parseDurationToSeconds } from "@contracts/time";
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
import { t } from "@/i18n";


/**
 * Fastest path to log time: pick an issue (themed searchable picker),
 * tap a duration preset, optionally add a comment, done.
 */
export function QuickLog({
  onLogged,
  day,
}: {
  onLogged?: () => void;
  /** Another day than today: the block goes after that day's last one. */
  day?: Date;
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

  const create = trpc.worklogs.create.useMutation({
    onSuccess: w => {
      toast.success(
        t("ui.quickLog.logged", {
          duration: formatDuration(w.timeSpentSeconds),
          key: w.issueKey,
        })
      );
      setTimeSpent("");
      setComment("");
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
  const parsed = parseDurationToSeconds(timeSpent, { daySeconds: targetFor(day ?? openedAt) });
  const placed =
    parsed && parsed > 0 && placement.ready
      ? placement.place(parsed, { now: openedAt })
      : null;
  const canSubmit =
    !!matched && !!parsed && parsed > 0 && !!placed?.ok && !create.isPending;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit || !matched || !placed?.ok) return;
    create.mutate({
      issueKey: matched.key,
      connectionId: matched.connectionId,
      seconds: parsed,
      started: placed.start.toISOString(),
      comment,
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-issue`}>{t("ui.quickLog.issue")}</Label>
          <IssuePicker
            id={`${id}-issue`}
            issues={list}
            value={issueKey}
            onChange={setIssueKey}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-time`}>{t("ui.quickLog.duration")}</Label>
          <Input
            id={`${id}-time`}
            placeholder="2h 30m"
            value={timeSpent}
            onChange={e => setTimeSpent(e.target.value)}
            aria-invalid={timeSpent.trim() !== "" && !parsed}
          />
        </div>
      </div>

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
      {placed && (
        <p
          role={placed.ok ? undefined : "alert"}
          className={cn(
            "text-body-sm",
            placed.ok ? "text-muted-foreground" : "text-danger"
          )}
        >
          {placed.ok
            ? t("ui.quickLog.range", {
                from: timeOfDay(placed.start),
                to: timeOfDay(new Date(placed.start.getTime() + (parsed ?? 0) * 1000)),
              })
            : t("ui.quickLog.noRoom", { reason: placed.reason })}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input
          aria-label={t("ui.quickLog.comment")}
          placeholder={t("ui.quickLog.commentPlaceholder")}
          value={comment}
          onChange={e => setComment(e.target.value)}
        />
        <Button type="submit" disabled={!canSubmit}>
          {create.isPending
            ? t("common.saving")
            : parsed && !placement.ready
              ? t("ui.quickLog.computing")
              : t("ui.quickLog.submit")}
        </Button>
      </div>
    </form>
  );
}
