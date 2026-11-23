import { useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { newOpId, timerConflictOf } from "@/lib/timerConflict";
import { toastError } from "@/lib/errorText";
import { timerOf } from "@/lib/timerLog";

/**
 * "Log time" on an issue whose own timer runs or waits to be logged: that
 * timer's question opens, as Stop+log does (DecisionHost), so its time is never
 * logged twice nor over itself; `true` then. Without one, `false`: the usual
 * dialog opens. A refused stop (held elsewhere) says why and opens nothing.
 */
export function useLogTime() {
  const utils = trpc.useUtils();
  const { mutate: stop } = trpc.timers.stop.useMutation({
    onSuccess: () => {
      void utils.timers.list.invalidate();
      void utils.decisions.list.invalidate();
    },
    onError: e => {
      if (timerConflictOf(e)) void utils.timers.list.invalidate();
      toastError(e);
    },
  });
  // The timers as the app last read them (the sidebar keeps them fresh): read on the click, no re-render per poll.
  return useCallback(
    (issue: { key: string; connectionId?: number | null }): boolean => {
      const timer = timerOf(utils.timers.list.getData() ?? [], issue);
      if (!timer) return false;
      // A stop of a stopped (paused) timer asks again, ending where it was stopped.
      stop({ issueKey: issue.key, connectionId: timer.connectionId, epoch: timer.epoch, opId: newOpId() });
      return true;
    },
    [utils, stop]
  );
}
