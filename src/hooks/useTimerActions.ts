import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";
import { useTimers } from "@/hooks/useTimers";
import { useStartTimer } from "@/hooks/useStartTimer";
import { newOpId, timerConflictOf } from "@/lib/timerConflict";
import { toastError } from "@/lib/errorText";
import { toast } from "sonner";
import { t } from "@/i18n";
import { quickStart } from "@/lib/quickStart";

/**
 * Start / pause / stop / discard for one issue's timer (`connectionId`: when
 * its key may live on two connections). Each action carries the timer's
 * epoch as this page saw it and an op id: an action on an older view, or
 * one another device holds, is refused and the page refreshed, never applied
 * twice.
 */
export function useTimerActions(issueKey: string, connectionId?: number | null) {
  const utils = trpc.useUtils();
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(
    t =>
      t.issueKey === issueKey &&
      (connectionId == null || t.connectionId === connectionId)
  );
  const on = { issueKey, connectionId: connectionId ?? undefined };
  const guarded = () => ({ ...on, epoch: timer?.epoch, opId: newOpId() });

  const invalidate = () => utils.timers.list.invalidate();
  const onError = (e: unknown) => {
    // Held elsewhere or changed meanwhile: the fresh view shows why.
    if (timerConflictOf(e)) void invalidate();
    toastError(e);
  };
  const start = useStartTimer();
  const pause = trpc.timers.pause.useMutation({
    onSuccess: invalidate,
    onError,
  });
  const discard = trpc.timers.discard.useMutation({
    onSuccess: () => {
      void invalidate();
      toast.success(t("ui.timer.discarded"));
    },
    onError,
  });
  const move = trpc.timers.move.useMutation({
    onSuccess: (r, to) => {
      void invalidate();
      void utils.todos.invalidate();
      toast.success(t(r.merged ? "ui.timer.movedMerged" : "ui.timer.moved", { from: issueKey, key: to.toIssueKey }));
      // A stopped timer waiting to be logged: its request follows it to the new issue.
      if (timerLog.drop(on) && !r.running)
        timerLog.push({ issueKey: to.toIssueKey, connectionId: to.toConnectionId, seconds: r.toLog, note: r.note });
    },
    onError,
  });
  const stop = trpc.timers.stop.useMutation({
    onSuccess: r => {
      void invalidate();
      if (r.found)
        timerLog.push({
          issueKey,
          connectionId: on.connectionId,
          seconds: r.seconds,
          note: r.note,
          end: r.stoppedAt ?? undefined,
        });
    },
    onError,
  });

  return {
    timer,
    fetchedAt,
    running: timer?.state === "running",
    paused: timer?.state === "paused",
    /** Another device controls it now: this one may only take it over. */
    heldElsewhere: !!timer?.heldElsewhere,
    pending:
      start.isPending || pause.isPending || stop.isPending || discard.isPending || move.isPending,
    start: () => start.mutate(on),
    takeOver: () => start.mutate({ ...on, force: true }),
    pause: () => pause.mutate(guarded()),
    stop: () => stop.mutate(guarded()),
    /** `then`: after it is gone (a dialog waiting on it closes only then: on a conflict it stays). */
    discard: (then?: { onSuccess?: () => void; onError?: () => void }) => discard.mutate(guarded(), then),
    /** To another issue with its count: the issue is picked in the usual picker. */
    move: () =>
      quickStart.pick(
        to => move.mutate({ ...guarded(), toIssueKey: to.key, toConnectionId: to.connectionId }),
        t("ui.timer.movePick", { key: issueKey })
      ),
  };
}
