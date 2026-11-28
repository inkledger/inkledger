// How often one person may do a chat thing (in memory, one process: inkledger runs one). A burst
// past the limit is refused with a clear message, never queued.
import { TRPCError } from "@trpc/server";
import { t } from "@contracts/i18n";

type Window = { at: number[] };
const windows = new Map<string, Window>();

/** At most `max` times per `ms` per key: true when this one fits (and counts it). */
export function fits(key: string, max: number, ms: number, now = Date.now()): boolean {
  const w = windows.get(key) ?? { at: [] };
  w.at = w.at.filter((at) => at > now - ms);
  if (w.at.length >= max) {
    windows.set(key, w);
    return false;
  }
  w.at.push(now);
  windows.set(key, w);
  // Forget idle keys now and then, so the map never grows with every person who ever typed.
  if (windows.size > 10_000) for (const [k, v] of windows) if (v.at.every((at) => at <= now - 3_600_000)) windows.delete(k);
  return true;
}

/** Messages per person: a person writes, a script floods. */
export const SEND_PER_MINUTE = 30;
/** Uploads per person per minute. */
export const UPLOADS_PER_MINUTE = 20;

/** Refused with "slow down" past the limit. */
export function limit(key: string, max: number, ms: number): void {
  if (!fits(key, max, ms)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: t("server.chat.slowDown") });
}

/** Starts a key's window afresh (a message sent ends its writer's typing: the next keystroke says it again at once). */
export function forget(key: string): void {
  windows.delete(key);
}

/** Test helper: forget every window. */
export function resetChatLimits() {
  windows.clear();
}
