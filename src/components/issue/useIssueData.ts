import { useEffect, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { toastError } from "@/lib/errorText";
import { useInvalidateWorklogs } from "@/hooks/useInvalidateWorklogs";
import { useInvalidateIssues } from "@/hooks/useInvalidateIssues";
import { useManageable } from "@/hooks/useManageable";
import {
  useConnections,
  useKeepsTimeHere,
  useProviderName,
  useTrackerOffers,
} from "@/hooks/useConnections";
import { useIssueEstimate } from "@/components/issue/estimateQuery";
import type { TransitionTarget } from "@/components/issue/TransitionDialog";
import { t } from "@/i18n";

/**
 * What an issue's page or pane reads and does: the issue, its worklogs (mine and the
 * team's), history, description and estimate, and the mutations on it. `markSeen`
 * reads its news once it is true (the page at once, a pane once it is shown).
 */
export function useIssueData({
  issueKey: key,
  connectionId,
  markSeen: shouldMarkSeen,
}: {
  issueKey: string;
  connectionId?: number;
  markSeen: boolean;
}) {
  const invalidateWorklogs = useInvalidateWorklogs();
  const issue = trpc.issues.get.useQuery({ key, connectionId });
  const provider = useProviderName(issue.data?.connectionId);
  // Only what the issue's tracker can do is offered; time it doesn't keep is counted here.
  const offers = useTrackerOffers(issue.data?.connectionId);
  const timeHere = useKeepsTimeHere(issue.data?.connectionId);
  // "Me" on the issue's tracker: the user's own id on its connection.
  const ownConnection = useConnections().data?.find(
    c => c.id === issue.data?.connectionId
  );

  // Opening the issue reads its news (unread dot, sidebar counter).
  const seenUtils = trpc.useUtils();
  const invalidateIssues = useInvalidateIssues();
  const seen = trpc.issues.markSeen.useMutation({
    onSuccess: () => {
      void invalidateIssues();
      void seenUtils.issues.unreadCount.invalidate();
    },
  });
  const markSeen = seen.mutate;
  // Live from Jira, not in the catalog: nothing local to mark as read.
  const loaded = !!issue.data && !issue.data.remote;
  useEffect(() => {
    if (loaded && shouldMarkSeen) markSeen({ key, connectionId });
  }, [loaded, shouldMarkSeen, key, connectionId, markSeen]);
  // Its own worklogs: the key on its connection (another tracker may have the same key). When
  // its link names the connection, read at once beside the issue (the same query either way).
  const logsOn = connectionId ?? issue.data?.connectionId;
  const logs = trpc.worklogs.list.useQuery({ issueKey: key, connectionId: logsOn }, { enabled: logsOn !== undefined });
  // Everyone's on its tracker (time kept here is all mine): the others' beside mine.
  const team = trpc.worklogs.team.useQuery(
    { issueKey: key, connectionId: issue.data?.connectionId },
    { enabled: !!issue.data && !timeHere, retry: false }
  );
  // How long it likely takes, from my closed issues: only for an issue in the catalog.
  const estimateQuery = useIssueEstimate(key, issue.data?.connectionId ?? connectionId, loaded);

  // What its tracker lets the app change (GitHub: assignees, labels, title and body).
  const manage = useManageable({ issueKey: key, connectionId });
  // The reason of the last update, next to its date (same query as the dialog).
  const history = trpc.issues.history.useQuery(
    { key, connectionId },
    { retry: false, staleTime: 60_000 }
  );
  const description = trpc.issues.description.useQuery(
    { key, connectionId },
    { retry: false, staleTime: 60_000 }
  );
  const utils = trpc.useUtils();

  const importIssue = trpc.issues.import.useMutation({
    onSuccess: async r => {
      toast.success(t("pages.issueDetail.imported", { key: r.imported }));
      await Promise.all([utils.issues.get.invalidate({ key }), invalidateIssues(), utils.issues.search.invalidate()]);
    },
    onError: e => toastError(e),
  });

  const syncLogs = trpc.worklogs.syncIssue.useMutation({
    onSuccess: r => {
      toast.success(t("pages.issueDetail.synced", { count: r.synced }));
      invalidateWorklogs();
    },
    onError: e => toastError(e),
  });
  const del = trpc.worklogs.delete.useMutation({
    onSuccess: () => {
      toast.success(t("pages.issueDetail.worklogDeleted"));
      invalidateWorklogs();
    },
    onError: e => toastError(e),
  });

  return {
    issue,
    provider,
    offers,
    timeHere,
    ownConnection,
    logs,
    team,
    estimateQuery,
    manage,
    history,
    description,
    importIssue,
    syncLogs,
    del,
  };
}

export type IssueData = ReturnType<typeof useIssueData>;
/** The issue as loaded. */
export type Issue = NonNullable<IssueData["issue"]["data"]>;

/** Moving the issue on: the ways out of its status (read once the Select opens) and the move itself. */
export function useIssueTransitions(key: string, connectionId: number | undefined) {
  const utils = trpc.useUtils();
  const invalidateIssues = useInvalidateIssues();
  const [transOpen, setTransOpen] = useState(false);
  // Calls Jira, so only fetch once the user opens the Select. Always fresh:
  // the available transitions depend on the current status.
  const transitions = trpc.issues.transitions.useQuery(
    { key, connectionId },
    { enabled: transOpen, retry: false, staleTime: 0 }
  );
  // A way on that asks for fields (or that inkledger can't take) opens its form.
  const [asking, setAsking] = useState<TransitionTarget | null>(null);
  const transitionDone = async (r: { moved: string; to: string }) => {
    toast.success(`${r.moved} → ${r.to}`);
    // The old list belongs to the previous status: drop it.
    void utils.issues.transitions.reset({ key });
    await Promise.all([utils.issues.get.invalidate(), invalidateIssues()]);
  };
  const transition = trpc.issues.transition.useMutation({
    onSuccess: transitionDone,
    onError: e => toastError(e),
  });
  return { transOpen, setTransOpen, transitions, asking, setAsking, transitionDone, transition };
}
