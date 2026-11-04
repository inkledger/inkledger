/**
 * What changed for a user, told to every page they have open (GET /api/events,
 * server-sent events): a page refetches what the event names instead of
 * waiting for its next poll. In memory, one process: inkledger runs one. A
 * page with no stream left keeps polling, so nothing depends on delivery.
 */

import type { UserEvent } from "@contracts/liveEvents";

export type { UserEvent };

/** An event as it goes out: numbered per user, so a page that reconnects gets what it missed. */
export type Sent = { seq: number; e: UserEvent; origin?: string };

type Listener = (s: Sent) => void;

const listeners = new Map<number, Set<Listener>>();
const closers = new Set<() => void>();

/** This process's run: a page's last id from another run means "missed everything". */
export const RUN = Math.random().toString(36).slice(2, 10);
/** How many recent events per user a reconnecting page can catch up on. */
const KEEP = 500;
const recent = new Map<number, Sent[]>();
const seqs = new Map<number, number>();

/** Tells every open page of the user; `origin` is the page that caused it (its own echo, known as such). */
export function publish(userId: number, e: UserEvent, origin?: string) {
  const seq = (seqs.get(userId) ?? 0) + 1;
  seqs.set(userId, seq);
  const sent: Sent = origin ? { seq, e, origin } : { seq, e };
  const kept = recent.get(userId) ?? [];
  kept.push(sent);
  if (kept.length > KEEP) kept.splice(0, kept.length - KEEP);
  recent.set(userId, kept);
  for (const l of listeners.get(userId) ?? []) {
    try {
      l(sent);
    } catch {
      // One broken stream never stops the others.
    }
  }
}

/** The user's last event number (0: none yet). */
export const lastSeq = (userId: number) => seqs.get(userId) ?? 0;

/**
 * What a page that last saw `id` ("run:seq") missed: the events after it, or
 * null when they can't be told (another run, or older than what is kept).
 */
export function missedSince(userId: number, id: string): Sent[] | null {
  const [run, n] = id.split(":");
  const seq = Number(n);
  if (run !== RUN || !Number.isInteger(seq) || seq < 0) return null;
  const last = lastSeq(userId);
  if (seq > last) return null;
  if (seq === last) return [];
  const kept = recent.get(userId) ?? [];
  if (kept.length === 0 || kept[0].seq > seq + 1) return null;
  return kept.filter(s => s.seq > seq);
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
