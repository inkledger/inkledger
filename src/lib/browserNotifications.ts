import { isNative, notifyNative } from "@/lib/native";
import { t } from "@contracts/i18n";

/** Read when asked (getters): the text follows the language. */
export const PERMISSION_LABEL: Record<string, string> = {
  get granted() {
    return t("ui.permission.granted");
  },
  get denied() {
    return t("ui.permission.denied");
  },
  get default() {
    return t("ui.permission.default");
  },
  get unsupported() {
    return t("ui.permission.unsupported");
  },
};

/** Browser notification permission, "unsupported" when the API is missing. */
export function currentPermission(): string {
  // The native app speaks to Notification Center itself (macOS asks once).
  if (isNative()) return "granted";
  return typeof Notification === "undefined"
    ? "unsupported"
    : Notification.permission;
}

export type ShowResult = "shown" | "error" | "unknown";

/**
 * Shows a system notification and reports what the browser did. "shown" means the browser
 * handed it to the OS: if nothing appears, the OS is hiding it (macOS → System Settings →
 * Notifications → the browser, or a Focus mode). Prefers the service worker when there is
 * one (installed app); falls back to the page constructor.
 */
export async function showBrowserNotification(
  title: string,
  options: NotificationOptions,
): Promise<ShowResult> {
  if (currentPermission() !== "granted") return "error";
  try {
    if (isNative()) {
      await notifyNative(title, options.body);
      return "shown";
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.active) {
      await reg.showNotification(title, options);
      return "shown";
    }
    return await new Promise<ShowResult>(resolve => {
      const n = new Notification(title, options);
      n.onshow = () => resolve("shown");
      n.onerror = () => resolve("error");
      // Some browsers never fire onshow: don't hang.
      setTimeout(() => resolve("unknown"), 3000);
    });
  } catch {
    return "error";
  }
}
