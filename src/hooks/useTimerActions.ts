import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";
import { useTimers } from "@/hooks/useTimers";
import { useStartTimer } from "@/hooks/useStartTimer";
import { newOpId, timerConflictOf } from "@/lib/timerConflict";
import { toast } from "sonner";
import { t } from "@/i18n";

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
  const onError = (e: { message: string }) => {
    // Held elsewhere or changed meanwhile: the fresh view shows why.
    if (timerConflictOf(e)) void invalidate();
    toast.error(e.message);
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
      start.isPending || pause.isPending || stop.isPending || discard.isPending,
    start: () => start.mutate(on),
    takeOver: () => start.mutate({ ...on, force: true }),
    pause: () => pause.mutate(guarded()),
    stop: () => stop.mutate(guarded()),
    discard: () => discard.mutate(guarded()),
  };
}
