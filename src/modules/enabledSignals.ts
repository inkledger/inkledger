import type { AnchorEl } from "./sandbox/anchors";

// A module just switched on or installed from its Store card ("page.events"
// "enabled"): told to that module's frames only, with where its card is, so
// what it draws can come out of it. Its frames are often made by that very
// switch: the word waits for them a while, and the card is measured when heard.

/** How long the word waits for the module's frames (made when the page is idle, then loaded). */
export const ENABLED_HOLD_MS = 15_000;

const NONE = { left: 0, top: 0, right: 0, bottom: 0 };
/** The card as it is when measured (a card gone from the page has no size: nothing to point at). */
const live = (find: () => AnchorEl | null): AnchorEl => ({ getBoundingClientRect: () => find()?.getBoundingClientRect() ?? NONE, getAttribute: () => null });

export function createEnabledSignals(now: () => number = () => Date.now()) {
  const held = new Map<string, { card: AnchorEl; at: number }>();
  const listeners = new Map<string, Set<(card: AnchorEl | null) => void>>();
  return {
    tell(moduleId: string, find: () => AnchorEl | null) {
      const card = live(find);
      const fns = listeners.get(moduleId);
      if (fns?.size) {
        held.delete(moduleId);
        for (const fn of fns) fn(card);
      } else held.set(moduleId, { card, at: now() });
    },
    /** The module's frames listening: a word told before they did comes once, to the first, if recent. */
    subscribe(moduleId: string, fn: (card: AnchorEl | null) => void): () => void {
      const fns = listeners.get(moduleId) ?? new Set();
      listeners.set(moduleId, fns);
      fns.add(fn);
      const h = held.get(moduleId);
      if (h) {
        held.delete(moduleId);
        if (now() - h.at <= ENABLED_HOLD_MS) fn(h.card);
      }
      return () => void fns.delete(fn);
    },
  };
}

export const enabledSignals = createEnabledSignals();

/** A module switched on or installed from the Store: its card (the one `from` is in, else its card on the page). */
export function tellEnabled(moduleId: string, from: Element | null) {
  const own = from?.closest("[data-store-item]") ?? null;
  enabledSignals.tell(moduleId, () => (own?.isConnected ? own : document.querySelector(`[data-store-item="${CSS.escape(moduleId)}"]`)));
}
