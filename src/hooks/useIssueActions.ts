import { toastError } from "@/lib/errorText";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { branchName, copyLater, copyText } from "@/lib/issues";
import { dayAndTime } from "@/lib/dates";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Favorite / watch / hide / restore an issue, refreshing every list that shows it.
 * Calls go through the vanilla client: the row that started them may be gone
 * (hidden) by the time "Cancel" is clicked, and must still work.
 */
export function useIssueActions() {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState(false);
  const refresh = () =>
    Promise.all([
      utils.issues.list.invalidate(),
      utils.issues.all.invalidate(), utils.issues.favorites.invalidate(),
      utils.issues.get.invalidate(),
      utils.stats.invalidate(),
    ]);
  const run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    try {
      return await work();
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      setPending(false);
      await refresh();
    }
  };
  const api = utils.client.issues;

  /** Back to visible; a former favorite returns to its old place. */
  const restore = (key: string, connectionId?: number, favorite?: { rank: number }) =>
    run(async () => {
      await api.setHidden.mutate({ key, connectionId, hidden: false });
      if (!favorite) return;
      await api.toggleFavorite.mutate({ key, connectionId });
      const favorites = (await api.all.query())
        .filter(i => i.favorite === 1 && !(i.key === key && (connectionId === undefined || i.connectionId === connectionId)))
        .map(i => ({ key: i.key, connectionId: i.connectionId, rank: i.favoriteRank }));
      const at = favorites.findIndex(f => f.rank > favorite.rank);
      const items: { key: string; connectionId?: number }[] = favorites.map(f => ({
        key: f.key,
        connectionId: f.connectionId,
      }));
      items.splice(at === -1 ? items.length : at, 0, { key, connectionId });
      await api.reorderFavorites.mutate({ items });
    });

  const copy = async (text: string, what: string) => {
    if (await copyText(text))
      toast.success(t("ui.issueActions.copied", { what }), { description: text });
    else toast.error(t("ui.issueActions.copyFailed"));
  };

  /** The issue as Markdown for an agent, its attachments as links valid for `minutes` (docs/work/ideas/issue-copy.md). */
  const copyForAgent = async (key: string, connectionId: number | undefined, minutes: number) => {
    const made = api.copyForAgent.mutate({ key, connectionId, minutes });
    const copied = await copyLater(made.then(r => r.markdown));
    try {
      const { expiresAt } = await made;
      if (copied) toast.success(t("pages.issueDetail.copiedUntil", { time: dayAndTime(expiresAt) }));
      else toast.error(t("ui.issueActions.copyFailed"));
    } catch (e) {
      toastError(e);
    }
  };

  return {
    copyForAgent,
    copyKey: (key: string) => copy(key, t("ui.issueActions.key")),
    copyBranch: (key: string, summary: string) =>
      copy(branchName(key, summary), t("ui.issueActions.branch")),
    toggleFavorite: (key: string, connectionId?: number) =>
      run(() => api.toggleFavorite.mutate({ key, connectionId })),
    hide: (key: string, connectionId?: number) =>
      run(async () => {
        const r = await api.setHidden.mutate({ key, connectionId, hidden: true });
        toast.success(t("ui.issueActions.hidden", { key }), {
          description: t("ui.issueActions.hiddenHint"),
          action: {
            label: t("common.cancel"),
            onClick: () =>
              void restore(
                key,
                connectionId,
                r.wasFavorite ? { rank: r.previousRank } : undefined
              ),
          },
        });
      }),
    /** Follow / unfollow on Jira (its "Watch"): the issue joins "Following". */
    setWatching: (key: string, watch: boolean, connectionId?: number) =>
      run(async () => {
        await api.watch.mutate({ key, connectionId, watch });
        toast.success(t(watch ? "ui.issueActions.following" : "ui.issueActions.unfollowing", { key }), {
          description: watch
            ? t("ui.issueActions.followingHint")
            : undefined,
        });
      }),
    restore: (key: string, connectionId?: number) =>
      run(async () => {
        await api.setHidden.mutate({ key, connectionId, hidden: false });
        toast.success(t("ui.issueActions.visible", { key }));
      }),
    pending,
  };
}
