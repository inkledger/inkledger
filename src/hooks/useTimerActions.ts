import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";
import { useTimers } from "@/hooks/useTimers";
import { useStartTimer } from "@/hooks/useStartTimer";
import { toast } from "sonner";
import { t } from "@/i18n";

/** Start / pause / stop / discard mutations for one issue's timer (`connectionId`: when its key may live on two connections). */
export function useTimerActions(issueKey: string, connectionId?: number | null) {
  const utils = trpc.useUtils();
  const { timers, fetchedAt } = useTimers();
  const timer = timers.find(
    t =>
      t.issueKey === issueKey &&
      (connectionId == null || t.connectionId === connectionId)
  );
  const on = { issueKey, connectionId: connectionId ?? undefined };

  const onError = (e: { message: string }) => toast.error(e.message);
  const invalidate = () => utils.timers.list.invalidate();
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
    pending:
      start.isPending || pause.isPending || stop.isPending || discard.isPending,
    start: () => start.mutate(on),
    pause: () => pause.mutate(on),
    stop: () => stop.mutate(on),
    discard: () => discard.mutate(on),
  };
}
