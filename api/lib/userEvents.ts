/**
 * What changed for a user, told to every page they have open (GET /api/events,
 * server-sent events): a page refetches what the event names instead of
 * waiting for its next poll. In memory, one process: inkledger runs one. A
 * page with no stream left keeps polling, so nothing depends on delivery.
 */

export type UserEvent = { type: "timers"; epoch: number };

type Listener = (e: UserEvent) => void;

const listeners = new Map<number, Set<Listener>>();
const closers = new Set<() => void>();

export function publish(userId: number, e: UserEvent) {
  for (const l of listeners.get(userId) ?? []) {
    try {
      l(e);
    } catch {
      // One broken stream never stops the others.
    }
  }
}

/** Listen to a user's events until the returned function is called. */
export function subscribe(userId: number, l: Listener, close: () => void): () => void {
  const set = listeners.get(userId) ?? new Set<Listener>();
  set.add(l);
  listeners.set(userId, set);
  closers.add(close);
  return () => {
    set.delete(l);
    if (set.size === 0) listeners.delete(userId);
    closers.delete(close);
  };
}

/** At shutdown: every open stream ends, so the server can close. */
export function closeAllStreams() {
  for (const c of [...closers]) c();
}

export const streamCount = () => closers.size;
