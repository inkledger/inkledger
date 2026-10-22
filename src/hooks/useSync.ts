import { failureText } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { t } from "@/i18n";
import { useProviderName } from "@/hooks/useConnections";

/** Everything that comes from Jira, worklogs, the offline queue and the pinboards' issues included. */
export function invalidateJiraData(utils: ReturnType<typeof trpc.useUtils>) {
  void utils.issues.invalidate();
  // A board that follows a tag shows the open issues the sync just brought.
  void utils.pinboard.invalidate();
  void utils.stats.invalidate();
  void utils.outbox.invalidate();
  void utils.worklogs.invalidate();
}

/**
 * "Sync Jira", wherever it is asked from (sidebar, command palette):
 * one behaviour, one refresh.
 */
export function useSync() {
  const utils = trpc.useUtils();
  const provider = useProviderName();
  return trpc.issues.sync.useMutation({
    onSuccess: r => {
      toast.success(t("ui.sync.done", { count: r.synced, provider }));
      invalidateJiraData(utils);
    },
    onError: e => toast.error(t("ui.sync.failed", { message: failureText(e) })),
    onSettled: () => void utils.issues.syncStatus.invalidate(),
  });
}
