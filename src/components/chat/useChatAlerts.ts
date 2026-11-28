import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { chatPreview } from "@contracts/chat";
import { trpc } from "@/lib/trpc";
import { showBrowserNotification } from "@/lib/browserNotifications";
import { useAuth } from "@/hooks/useAuth";
import { t } from "@/i18n";
import { threadOnScreen, useChatEvents, type ChatEvent } from "./chatLive";
import { chatPath, nameIn } from "./chatText";


/**
 * Mount once (the shell). Someone else's new message in a chat that isn't on screen: a toast with
 * "Open", and a system notification when the page is hidden and notifications are on (Settings);
 * muted chats stay quiet. A click on the system notification opens the chat (the service worker
 * hands the path to this page).
 */
export function useChatAlerts(): void {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const self = useAuth().user?.id ?? null;
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const notifyEnabled = settings.data?.notifyEnabled === 1;

  useChatEvents(
    useCallback(
      (e: ChatEvent) => {
        if (e.change !== "message" || self === null || e.by === self || e.messageId === undefined || threadOnScreen(e.threadId)) return;
        const messageId = e.messageId;
        void Promise.all([utils.client.chat.thread.query({ threadId: e.threadId }), utils.client.chat.messages.query({ threadId: e.threadId, around: messageId })])
          .then(([thread, page]) => {
            if (thread.muted || threadOnScreen(e.threadId)) return;
            const m = page.messages.find((x) => x.id === messageId);
            if (!m || m.deleted) return;
            const title = t("pages.chat.notify.title", { name: nameIn(thread.members, m.authorId, self), key: thread.issue.key });
            const body = m.body ? chatPreview(m.body, 160) : t("pages.chat.notify.files", { count: m.files.length });
            const url = chatPath(e.threadId);
            // One toast per chat: a burst of lines replaces it instead of piling up.
            toast(title, { id: `chat-${e.threadId}`, description: body, duration: 8000, action: { label: t("pages.chat.notify.open"), onClick: () => void navigate(url) } });
            if (notifyEnabled && document.visibilityState !== "visible") void showBrowserNotification(title, { body, tag: `ikl-chat-${e.threadId}`, data: { url } }, () => void navigate(url));
          })
          .catch(() => undefined);
      },
      [self, utils, navigate, notifyEnabled],
    ),
  );

  // A click on a system notification, handed over by the service worker: go where it leads.
  useEffect(() => {
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const on = (ev: MessageEvent<unknown>) => {
      const d = ev.data;
      if (typeof d === "object" && d !== null && "type" in d && d.type === "ikl-open" && "url" in d && typeof d.url === "string" && d.url.startsWith("/") && !d.url.startsWith("//")) void navigate(d.url);
    };
    sw.addEventListener("message", on);
    return () => sw.removeEventListener("message", on);
  }, [navigate]);
}
