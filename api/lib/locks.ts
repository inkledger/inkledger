/**
 * A queue per key: `run(key, fn)` starts `fn` once everything queued before it under the
 * same key has settled (a failure does not stop the queue), never alongside. The map holds
 * each key's tail only while something is queued; pass one to share it (e.g. across dev
 * module reloads).
 */
export function keyedLock<K>(tails: Map<K, Promise<unknown>> = new Map()) {
  return function run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/**
 * One run per key at a time: asked while one is under way, `run(key, start)` answers with
 * that same promise; once it settles, the next ask starts anew. `pending()` lists the runs
 * under way (a graceful shutdown waits for them). Pass a map to share it.
 */
export function singleFlight<K, T>(inFlight: Map<K, Promise<T>> = new Map()) {
  return {
    run(key: K, start: () => Promise<T>): Promise<T> {
      const running = inFlight.get(key);
      if (running) return running;
      const job = start().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
      return job;
    },
    pending: (): Promise<T>[] => [...inFlight.values()],
  };
}
