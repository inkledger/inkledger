import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { announceSwitched } from "@/lib/timerLog";
import { newOpId, thisDevice, timerConflictOf } from "@/lib/timerConflict";
import { toastError } from "@/lib/errorText";
import { t } from "@/i18n";

/** The TODO worked on now (its stretch), or null; follows the timers' events. */
export function useTodoWorking() {
  return trpc.todos.working.useQuery(undefined, { staleTime: 30_000 });
}

type Working = NonNullable<ReturnType<typeof useTodoWorking>["data"]>;

/**
 * Start and stop work on a TODO. With its issue, the issue's timer starts and
 * stops as from its own button (a switch or a stop queues the time to log);
 * without one, only the TODO's own time runs, which is never logged.
 */
export function useTodoWork() {
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.timers.list.invalidate(), utils.todos.invalidate()]);
  const start = (x: { id: number; text: string }, force = false): Promise<void> =>
    utils.client.todos.startWork.mutate({ id: x.id, force, opId: newOpId(), device: thisDevice() }).then(
      r => {
        void refresh();
        if (r.tookOver) toast.success(t("views.todos.workTookOver", { text: x.text }));
        announceSwitched(r.switchedFromAll);
      },
      (e: unknown) => {
        void refresh();
        if (timerConflictOf(e)?.reason === "held" && e instanceof Error)
          toast.error(e.message, { action: { label: t("ui.timer.takeOver"), onClick: () => void start(x, true) } });
        else toastError(e);
      }
    );
  const stop = (w: Working): Promise<void> =>
    w.linked && w.issueKey
      ? utils.client.timers.stop.mutate({ issueKey: w.issueKey, connectionId: w.connectionId ?? undefined, opId: newOpId() }).then(() => {
          // Asked to be logged by the server, on every page (DecisionHost).
          void refresh();
        }, toastError)
      : utils.client.todos.stopWork.mutate().then(() => void refresh(), toastError);
  /** A TODO done while its issue's timer runs for it: that timer stops too, its time to log. */
  const finish = (todoId: number): Promise<void> =>
    utils.todos.working
      .fetch(undefined, { staleTime: 30_000 })
      .catch(() => null)
      .then(w => (w && w.todoId === todoId && w.linked ? stop(w) : undefined));
  return { start, stop, finish };
}
