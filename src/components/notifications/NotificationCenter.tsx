import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { notificationCenter } from "@/lib/flag";
import { useChatUnread, useInboxCount } from "@/hooks/useNotifications";

/**
 * The bell, "n", a toast's "View" and the phone's More raise the flag: each leads to the notifications
 * page (a page, not a sheet: what is opened from it comes back to the same place with Back). When only
 * chats wait, to its Chat tab.
 */
export function NotificationCenter() {
  const open = notificationCenter.useValue();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const inbox = useInboxCount();
  const chats = useChatUnread();
  useEffect(() => {
    if (!open) return;
    notificationCenter.set(false);
    if (pathname !== "/notifications") void navigate(inbox === 0 && chats > 0 ? "/notifications?tab=chat&chats=unread" : "/notifications");
  }, [open, pathname, navigate, inbox, chats]);
  return null;
}
