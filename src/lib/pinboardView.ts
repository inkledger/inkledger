import { NOTE_SIZE } from "@contracts/pinboard";

export type Edge = "up" | "down" | "left" | "right";
export type View = { left: number; top: number; width: number; height: number };
type Point = { x: number; y: number };

/**
 * Notes outside the visible part of the canvas, by the edge they lie
 * beyond, with the nearest one (to bring into view). Partly visible notes
 * count as visible; a diagonal note goes to the side it is farthest past.
 */
export function offscreenByEdge<T extends Point>(
  notes: T[],
  view: View
): Record<Edge, { count: number; nearest: T | null }> {
  const out: Record<Edge, { count: number; nearest: T | null; dist: number }> = {
    up: { count: 0, nearest: null, dist: Infinity },
    down: { count: 0, nearest: null, dist: Infinity },
    left: { count: 0, nearest: null, dist: Infinity },
    right: { count: 0, nearest: null, dist: Infinity },
  };
  const right = view.left + view.width;
  const bottom = view.top + view.height;
  for (const n of notes) {
    const past: [Edge, number][] = [
      ["left", view.left - (n.x + NOTE_SIZE)],
      ["right", n.x - right],
      ["up", view.top - (n.y + NOTE_SIZE)],
      ["down", n.y - bottom],
    ];
    const [edge, dist] = past.reduce((a, b) => (b[1] > a[1] ? b : a));
    if (dist <= 0) continue; // overlaps the view
    const slot = out[edge];
    slot.count++;
    if (dist < slot.dist) {
      slot.dist = dist;
      slot.nearest = n;
    }
  }
  return {
    up: { count: out.up.count, nearest: out.up.nearest },
    down: { count: out.down.count, nearest: out.down.nearest },
    left: { count: out.left.count, nearest: out.left.nearest },
    right: { count: out.right.count, nearest: out.right.nearest },
  };
}

/** Scroll position (canvas px) that centres `n` in a view of that size. */
export function centreOn(n: Point, view: Pick<View, "width" | "height">): Point {
  return {
    x: Math.max(0, n.x + NOTE_SIZE / 2 - view.width / 2),
    y: Math.max(0, n.y + NOTE_SIZE / 2 - view.height / 2),
  };
}

/** Bounding box of all notes, to frame them ("Centra"). */
export function notesBounds(notes: Point[]): View | null {
  if (notes.length === 0) return null;
  const xs = notes.map(n => n.x);
  const ys = notes.map(n => n.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    left,
    top,
    width: Math.max(...xs) + NOTE_SIZE - left,
    height: Math.max(...ys) + NOTE_SIZE - top,
  };
}
