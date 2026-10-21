import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";
import { newOpId, thisDevice, timerConflictOf } from "@/lib/timerConflict";
import { toast } from "sonner";
import { t } from "@/i18n";

type StartInput = { issueKey: string; connectionId?: number; force?: boolean };

/**
 * Start (or resume) a timer. Switching issue stops the previous timer, whose
 * time is queued for logging in the global "Log time" dialog. When another
 * device holds the running timer, the refusal says where and offers to take
 * it over (it keeps its time: nothing is counted twice).
 */
export function useStartTimer(opts: { announce?: boolean } = {}) {
  const utils = trpc.useUtils();
  const m = trpc.timers.start.useMutation({
    onSuccess: (r, { issueKey }) => {
      void utils.timers.list.invalidate();
      if (r.tookOver) toast.success(t("ui.timer.tookOver", { key: issueKey }));
      else if (opts.announce) toast.success(t("ui.startTimer.started", { key: issueKey }));
      if (r.switchedFrom) {
        timerLog.push({ ...r.switchedFrom, end: r.switchedFrom.stoppedAt });
        toast.info(t("ui.startTimer.switched", { key: r.switchedFrom.issueKey }));
      }
    },
    onError: (e, input) => {
      const c = timerConflictOf(e);
      void utils.timers.list.invalidate();
      if (c?.reason === "held") {
        toast.error(e.message, {
          action: { label: t("ui.timer.takeOver"), onClick: () => mutate({ ...input, force: true }) },
        });
      } else toast.error(e.message);
    },
  });
  const mutate = (input: StartInput) => m.mutate({ ...input, opId: newOpId(), device: thisDevice() });
  return { mutate, isPending: m.isPending };
}
