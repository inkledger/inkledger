import type { Pt } from "@/lib/pinboardString";

/**
 * Where post-its are while being dragged, for the red strings only: a tiny
 * store outside React state, so a drag redraws the strings' SVG and nothing
 * else on the board.
 */
const live = new Map<number, Pt>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<number, Pt> = new Map();

export const pinboardLive = {
  set: (id: number, p: Pt | null) => {
    if (p) live.set(id, p);
    else if (!live.delete(id)) return;
    snapshot = new Map(live);
    listeners.forEach((fn) => fn());
  },
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  get: (): ReadonlyMap<number, Pt> => snapshot,
};
