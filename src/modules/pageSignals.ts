import type { PageSignal } from "./sandbox/anchors";

// What the page itself tells framed modules ("page.events"): moves made on
// the Board, notifications that land. Host ids only (a card's connection and
// key, a column's id): the module hears rects, never these.
type Told = Extract<PageSignal, { kind: "card-moved" }> | { kind: "notification" };

const listeners = new Set<(s: Told) => void>();

export const pageSignals = {
  emit(s: Told) {
    for (const fn of listeners) fn(s);
  },
  subscribe(fn: (s: Told) => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** A card's host id, the same on the Board's element and in the hub's events. */
export const cardId = (connectionId: number | null | undefined, key: string) => `${connectionId ?? ""}:${key}`;
