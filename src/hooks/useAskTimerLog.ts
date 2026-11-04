import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";

/**
 * Asks again to log a stopped timer: the question opens on every page of the
 * user (DecisionHost), the one already open if another page asked.
 */
export function useAskTimerLog() {
  const utils = trpc.useUtils();
  const ask = trpc.decisions.askTimerLog.useMutation({
    onSuccess: () => void utils.decisions.list.invalidate(),
    onError: e => toastError(e),
  });
  return (t: { issueKey: string; connectionId?: number | null }) => ask.mutate({ issueKey: t.issueKey, connectionId: t.connectionId ?? undefined });
}
