// One replay of a queue at a time, and edits of queued worklogs never
// alongside one: on globalThis so dev module reloads share them.
import { keyedLock, singleFlight } from "../lib/locks";

export type ReplayResult = { synced: number; failed: number; remaining: number };

const g = globalThis as {
  __iklOutboxInFlight?: Map<string, Promise<ReplayResult>>;
  __iklOutboxLocks?: Map<number, Promise<unknown>>;
};
const replays = singleFlight((g.__iklOutboxInFlight ??= new Map<string, Promise<ReplayResult>>()));

/**
 * Runs `fn` after the user's previous replay / pending edit, never alongside: an edit of a
 * pending worklog during a replay would be lost (the replay posts the old values, then
 * lands the placeholder).
 */
export const withOutboxLock: <T>(userId: number, fn: () => Promise<T>) => Promise<T> = keyedLock(
  (g.__iklOutboxLocks ??= new Map<number, Promise<unknown>>()),
);

/** The replay of `key` under way, or a new one: concurrent asks share one run (two would double-post creates). */
export function oneReplay(key: string, run: () => Promise<ReplayResult>): Promise<ReplayResult> {
  return replays.run(key, run);
}

/** Replays still running (graceful shutdown waits for them). */
export function pendingReplays(): Promise<ReplayResult>[] {
  return replays.pending();
}
