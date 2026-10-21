import type { TimerConflict } from "@contracts/timerLock";
import { deviceLabel } from "@contracts/device";
import { isNative } from "@/lib/native";

/** The details of a timer action refused by the server (held elsewhere, or changed meanwhile). */
export function timerConflictOf(e: unknown): TimerConflict | null {
  const timer = (e as { data?: { timer?: TimerConflict } } | null)?.data?.timer;
  return timer ?? null;
}

/**
 * An id for one user action: sent with it, so a retry of the same request
 * (network hiccup, double tap) is answered, not done twice. Plain HTTP pages
 * (LAN) have no crypto.randomUUID.
 */
export function newOpId(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** How this device is shown on a timer it runs ("Chrome · macOS"). */
export const thisDevice = () => deviceLabel(navigator.userAgent, isNative());
