import { t } from "@/i18n";

/**
 * Bridge to the native shell (Tauri, src-tauri/). The same web app runs in the
 * browser and inside the app's window; there `window.__TAURI__` exists and the
 * system features (tray, notifications, shortcuts, idle) go through it. In the
 * browser every function here is a no-op, so no Tauri package is bundled.
 */

type TauriGlobal = {
  core: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  event?: {
    listen: <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;
  };
};

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

/** Running inside the native app's window. */
export function isNative(): boolean {
  return typeof window !== "undefined" && window.__TAURI__ !== undefined;
}

/** Calls a native command; `undefined` in the browser. */
export async function invokeNative<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  const tauri = window.__TAURI__;
  return tauri ? tauri.core.invoke<T>(cmd, args) : undefined;
}

/**
 * Subscribes to an event the app sends (`native-command`, `system-away`);
 * returns the unsubscribe. A no-op in the browser.
 */
export function onNativeEvent<T>(event: string, cb: (payload: T) => void): () => void {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  let stop: (() => void) | undefined;
  let cancelled = false;
  void listen<T>(event, e => cb(e.payload)).then(unlisten => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

/** Commands from the menu bar and the global shortcuts. */
export type NativeCommand = "toggle" | "stop" | "quick-start";

export type TrayTimer = {
  issueKey: string;
  summary: string | null;
  elapsedSeconds: number;
  running: boolean;
};

/** The timer the menu bar shows (null: none). */
export async function setTrayTimer(timer: TrayTimer | null): Promise<void> {
  await invokeNative("set_tray_state", { timer });
}

/** A system notification through the app (Notification Center). */
export async function notifyNative(title: string, body?: string): Promise<void> {
  await invokeNative("notify", { title, body });
}

export async function showNativeWindow(): Promise<void> {
  await invokeNative("show_window");
}

export type NativeInfo = {
  version: string;
  platform: "macos" | "windows" | "linux" | "ios" | "android";
  desktop: boolean;
  autostart: boolean | null;
  shortcuts: { keys: string; label: string; ok: boolean }[];
};

export async function nativeInfo(): Promise<NativeInfo | undefined> {
  return invokeNative<NativeInfo>("native_info");
}

export async function setAutostart(enabled: boolean): Promise<void> {
  await invokeNative("set_autostart", { enabled });
}

/**
 * Sign-out from the app (after the session is ended): this server's profile
 * is removed, the others stay; back to the profiles page.
 */
export async function forgetServer(): Promise<void> {
  await invokeNative("forget_server");
}

/** A server the app knows: its own Jira and user. `url` is also the id. */
export type ServerProfile = { url: string; name: string; user: string | null; jira: string | null };
export type ServerProfiles = { list: ServerProfile[]; active: string | null };

export async function listProfiles(): Promise<ServerProfiles | undefined> {
  return invokeNative<ServerProfiles>("list_profiles");
}

/** Switch the window to another profile (checked first: rejects if down). */
export async function openProfile(url: string): Promise<void> {
  await invokeNative("open_profile", { url });
}

/** Checks a server, saves it as a profile and opens it (rejects if down). */
export async function addProfile(url: string, name: string | null): Promise<void> {
  await invokeNative("add_profile", { url, name });
}

export async function renameProfile(url: string, name: string): Promise<void> {
  await invokeNative("rename_profile", { url, name });
}

export async function removeProfile(url: string): Promise<void> {
  await invokeNative("remove_profile", { url });
}

/** Sharing this Mac's server on the Wi-Fi (desktop app, src-tauri/src/lan.rs). */
export type LanStatus = {
  running: boolean;
  target: string | null;
  /** https://<name or ip>:47843 */
  addresses: string[];
  /** http://<ip>:47844: certificate and steps for a phone's first visit */
  welcome: string | null;
  fingerprint: string | null;
  error: string | null;
};

export async function lanStatus(): Promise<LanStatus | undefined> {
  return invokeNative<LanStatus>("lan_status");
}

/** Shares the server this window shows (must be on this Mac); `names`: the user's DNS names for it. */
export async function lanStart(names: string[] = []): Promise<LanStatus | undefined> {
  return invokeNative<LanStatus>("lan_start", { names });
}

/** Tailscale on this Mac, as the desktop app sees it. */
export type TailscaleInfo = {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  https: boolean;
  /** What `serve` publishes: https://<name>:<port>/ → target ("http://127.0.0.1:47823") */
  serves: { port: number; target: string }[];
};

export async function tailscaleInfo(): Promise<TailscaleInfo | undefined> {
  return invokeNative<TailscaleInfo>("tailscale_info");
}

/** Publishes this Mac's server (port) on its Tailscale name, same port. Rejects with what to do. */
export async function tailscaleServe(port: number): Promise<TailscaleInfo | undefined> {
  return invokeNative<TailscaleInfo>("tailscale_serve", { port });
}

export async function lanStop(): Promise<LanStatus | undefined> {
  return invokeNative<LanStatus>("lan_stop");
}

/** The app's start page (first server, or when none answers). */
export async function manageProfiles(): Promise<void> {
  await invokeNative("manage_profiles");
}

/** Tells the app who is signed in here, shown next to the profile. */
export async function setProfileInfo(user: string, jira: string): Promise<void> {
  await invokeNative("set_profile_info", { user, jira });
}

/**
 * Notification permission as the system reports it: "granted", "denied",
 * "prompt" (not asked yet) or "unknown" (macOS doesn't tell apps).
 */
export type NativePermission = "granted" | "denied" | "prompt" | "unknown";

export async function notificationPermission(): Promise<NativePermission | undefined> {
  return invokeNative<NativePermission>("notification_permission");
}

export async function requestNotificationPermission(): Promise<NativePermission | undefined> {
  return invokeNative<NativePermission>("request_notification_permission");
}

/** System settings panes the permissions guide opens. */
export type SettingsPane = "notifications" | "login-items" | "keyboard" | "focus";

export async function openSystemSettings(pane: SettingsPane): Promise<void> {
  await invokeNative("open_system_settings", { pane });
}

/** A link that leaves the app: another origin over http(s), or mailto. */
export function isExternalHref(href: string, origin: string): boolean {
  try {
    const url = new URL(href, origin);
    if (url.protocol === "mailto:") return true;
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin;
  } catch {
    return false;
  }
}

/** Opens a link outside the app: the system browser in the native app, a new tab otherwise. */
export function openExternal(url: string): void {
  if (isNative()) void invokeNative("plugin:opener|open_url", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Native window setup: a `native` class on <html> for styling, and links to
 * other sites (Jira, attachments elsewhere) open in the system browser — the
 * app window never navigates away from the server.
 */
export function installNativeShell(): void {
  if (!isNative()) return;
  document.documentElement.classList.add("native");
  document.addEventListener(
    "click",
    e => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if (!isExternalHref(a.href, window.location.origin)) return;
      e.preventDefault();
      void invokeNative("plugin:opener|open_url", { url: a.href });
    },
    true
  );
}

/** Shortcuts taken by another app: "Active", "1 taken", "2 taken". */
export function busyLabel(n: number): string {
  return n === 0 ? t("settings.permissions.shortcutsActive") : t("settings.permissions.shortcutsBusy", { count: n });
}
