import { INSTALL_PATH } from "@contracts/downloads";
import { numberFormat } from "@contracts/i18n";

export type DevicePlatform = "android" | "ios" | "desktop";

/** Which install steps to show, from the browser's user agent. */
export function detectPlatform(ua: string, touchPoints = 0): DevicePlatform {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  // iPadOS Safari presents itself as a Mac, but has a touch screen.
  if (/macintosh/i.test(ua) && touchPoints > 1) return "ios";
  return "desktop";
}

/**
 * Where a new device opens the install page: the server's Tailscale address
 * (with its port) when there is one (a phone can't reach "localhost"), else
 * this origin.
 */
export function installUrl(tailnetOrigins: string[], origin: string): string {
  const here = new URL(origin);
  if (here.hostname.endsWith(".ts.net") || tailnetOrigins.length === 0) return `${here.origin}${INSTALL_PATH}`;
  return `${tailnetOrigins[0]}${INSTALL_PATH}`;
}

/** "12,4 MB" */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${numberFormat({ maximumFractionDigits: 1 }).format(n / 1024 / 1024)} MB`;
}
