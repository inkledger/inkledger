import type { TimerConflict } from "@contracts/timerLock";
import { deviceLabel } from "@contracts/device";
import { isNative } from "@/lib/native";
import { randomUUID } from "@/lib/randomId";

/** The details of a timer action refused by the server (held elsewhere, or changed meanwhile). */
export function timerConflictOf(e: unknown): TimerConflict | null {
  const timer = (e as { data?: { timer?: TimerConflict } } | null)?.data?.timer;
  return timer ?? null;
}

/**
 * An id for one user action: sent with it, so a retry of the same request
 * (network hiccup, double tap) is answered, not done twice.
 */
export function newOpId(): string {
  return randomUUID();
}

/** How this device is shown on a timer it runs ("Chrome · macOS"). */
export const thisDevice = () => deviceLabel(navigator.userAgent, isNative());
