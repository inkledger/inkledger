// One replay of a queue at a time, and edits of queued worklogs never
// alongside one: on globalThis so dev module reloads share them.
export type ReplayResult = { synced: number; failed: number; remaining: number };

const g = globalThis as {
  __iklOutboxInFlight?: Map<string, Promise<ReplayResult>>;
  __iklOutboxLocks?: Map<number, Promise<unknown>>;
};
const inFlight = (g.__iklOutboxInFlight ??= new Map<string, Promise<ReplayResult>>());
const locks = (g.__iklOutboxLocks ??= new Map<number, Promise<unknown>>());

/**
 * Runs `fn` after the user's previous replay / pending edit, never alongside: an edit of a
 * pending worklog during a replay would be lost (the replay posts the old values, then
 * lands the placeholder).
 */
export function withOutboxLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(userId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(userId, tail);
  void tail.then(() => {
    if (locks.get(userId) === tail) locks.delete(userId);
  });
  return run;
}

/** The replay of `key` under way, or a new one: concurrent asks share one run (two would double-post creates). */
export function oneReplay(key: string, run: () => Promise<ReplayResult>): Promise<ReplayResult> {
  const running = inFlight.get(key);
  if (running) return running;
  const job = run().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/** Replays still running (graceful shutdown waits for them). */
export function pendingReplays(): Promise<ReplayResult>[] {
  return [...inFlight.values()];
}
