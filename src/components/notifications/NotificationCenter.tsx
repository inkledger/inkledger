import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { notificationCenter } from "@/lib/flag";

/**
 * The bell, "n", a toast's "View" and the phone's More raise the flag: each leads to the notifications
 * page (a page, not a sheet: what is opened from it comes back to the same place with Back).
 */
export function NotificationCenter() {
  const open = notificationCenter.useValue();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!open) return;
    notificationCenter.set(false);
    if (pathname !== "/notifications") void navigate("/notifications");
  }, [open, pathname, navigate]);
  return null;
}
