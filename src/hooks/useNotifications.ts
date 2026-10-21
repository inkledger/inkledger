import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { showBrowserNotification } from "@/lib/browserNotifications";
import { notificationCenter } from "@/lib/flag";
import { t } from "@/i18n";
import { issuePath } from "@/lib/issues";

/** One line per kind, used by toasts and the "For you" card (read when asked: it follows the language). */
export const KIND_TITLE: Record<string, string> = {
  get assigned() {
    return t("ui.notify.assigned");
  },
  get unassigned() {
    return t("ui.notify.unassigned");
  },
  get priority() {
    return t("ui.notify.priority");
  },
  get due() {
    return t("ui.notify.due");
  },
  get watch_added() {
    return t("ui.notify.watchAdded");
  },
  get watch_removed() {
    return t("ui.notify.watchRemoved");
  },
  get mentioned() {
    return t("ui.notify.mentioned");
  },
  get commented() {
    return t("ui.notify.commented");
  },
  get review() {
    return t("ui.notify.review");
  },
  get changed() {
    return t("ui.notify.changed");
  },
};

type NotificationLike = { kind: string; issueKey: string; detail: string };

/** Toast / browser title for one notification ("Assigned to you: AB-1"). */
export function notificationTitle(n: NotificationLike): string {
  const what = `${KIND_TITLE[n.kind] ?? t("ui.notify.news")}${n.kind === "priority" ? ` ${n.detail}` : ""}`;
  return `${what}: ${n.issueKey}`;
}

/** Undismissed notifications (sidebar badge); shares the polled query. */
export function useNotificationCount(): number {
  const count = trpc.notifications.count.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
  return count.data?.count ?? 0;
}

/**
 * Mount once (AppLayout). Polls the persistent notifications; when new ones land, a toast (and a
 * browser notification, when allowed) points at the new work.
 */
export function useNotificationAlerts(): void {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const count = trpc.notifications.count.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  // The Settings switch governs browser notifications; the in-app toast always shows.
  const notifyEnabled = settings.data?.notifyEnabled === 1;
  const latest = count.data?.latestId ?? null;
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (latest === null) return;
    const before = seen.current;
    seen.current = latest;
    // First load: what is already there is not "new".
    if (before === null || latest <= before) return;
    void utils.notifications.list.invalidate();
    void utils.client.notifications.list.query().then(list => {
      const fresh = list.filter(n => n.id > before);
      if (fresh.length === 0) return;
      const first = fresh[0];
      const title =
        fresh.length === 1
          ? notificationTitle(first)
          : t("ui.notify.newsCount", { count: fresh.length });
      toast(title, {
        description:
          fresh.length === 1 ? (first.summary ?? undefined) : undefined,
        duration: 10_000,
        action: {
          label: fresh.length === 1 ? t("ui.notify.open") : t("ui.notify.view"),
          onClick: () => {
            if (fresh.length > 1) {
              notificationCenter.set(true);
              return;
            }
            // Opened = read: it leaves the list.
            void navigate(issuePath({ key: first.issueKey, connectionId: first.connectionId }));
            void utils.client.notifications.dismiss
              .mutate({ id: first.id })
              .then(() =>
                Promise.all([
                  utils.notifications.list.invalidate(),
                  utils.notifications.count.invalidate(),
                ])
              );
          },
        },
      });
      if (
        notifyEnabled &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        document.visibilityState !== "visible"
      ) {
        void showBrowserNotification(title, {
          body: fresh.length === 1 ? (first.summary ?? "") : undefined,
          tag: `ikl-notification-${latest}`,
        });
      }
    });
  }, [latest, navigate, utils, notifyEnabled]);
}
