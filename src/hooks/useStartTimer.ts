import { trpc } from "@/lib/trpc";
import { timerLog } from "@/lib/timerLog";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Start (or resume) a timer. Switching issue stops the previous timer, whose
 * time is queued for logging in the global "Log time" dialog.
 */
export function useStartTimer(opts: { announce?: boolean } = {}) {
  const utils = trpc.useUtils();
  return trpc.timers.start.useMutation({
    onSuccess: (r, { issueKey }) => {
      void utils.timers.list.invalidate();
      if (opts.announce) toast.success(t("ui.startTimer.started", { key: issueKey }));
      if (r.switchedFrom) {
        timerLog.push({ ...r.switchedFrom, end: r.switchedFrom.stoppedAt });
        toast.info(
          t("ui.startTimer.switched", { key: r.switchedFrom.issueKey })
        );
      }
    },
    onError: e => toast.error(e.message),
  });
}
