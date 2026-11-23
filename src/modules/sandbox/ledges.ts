/**
 * Where a creature drawn over the page may stand ("page.ledges"): the top
 * faces in sight (box tops, borders, dividers) from the page's info, in the
 * module's box, one per height where they touch. Only where they are, never
 * what they hold.
 */
import type { InfoSnapshot } from "./info";

export type Ledge = { x: number; y: number; w: number };
/** At most this many edges an answer per 1280 × 800 of box, and in all. */
export const LEDGES_MAX = 64;
export const LEDGES_CAP = 256;
/** Narrower than this a ledge is trim, dropped before any card top. */
const CARD_W = 96;

/** How many ledges a box this size gets. */
export const ledgeCap = (box: { width: number; height: number }) => Math.min(LEDGES_CAP, Math.max(LEDGES_MAX, Math.round((LEDGES_MAX * box.width * box.height) / (1280 * 800))));
/** Narrower than this, nothing stands on it. */
const MIN_W = 48;

/** The ledges in sight inside a box at (left, top), w × h on the page; in the box's px, top to bottom. */
export function ledgesOf(snap: Pick<InfoSnapshot, "surfaces" | "viewport">, box: { left: number; top: number; width: number; height: number }): Ledge[] {
  const spans: Ledge[] = [];
  for (const f of snap.surfaces) {
    if (f.kind !== "top") continue;
    // The edge itself in the window and in the box.
    if (f.y < 0 || f.y >= snap.viewport.h || f.y < box.top || f.y >= box.top + box.height) continue;
    const l = Math.max(f.x, 0, box.left);
    const r = Math.min(f.x + f.w, snap.viewport.w, box.left + box.width);
    if (r - l < 1) continue;
    spans.push({ x: l - box.left, y: Math.round(f.y - box.top), w: r - l });
  }
  spans.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: Ledge[] = [];
  for (const s of spans) {
    const o = merged[merged.length - 1];
    if (o && o.y === s.y && s.x <= o.x + o.w + 0.5) o.w = Math.max(o.w, s.x + s.w - o.x);
    else merged.push({ ...s });
  }
  const wide = merged.filter(s => s.w >= MIN_W).map(s => ({ x: Math.round(s.x), y: s.y, w: Math.round(s.w) }));
  const cap = ledgeCap(box);
  // Past the cap, the trim goes first, then what lies farthest from the box's middle band.
  const band = (y: number) => Math.max(0, box.height / 4 - y, y - (box.height * 3) / 4);
  const kept = wide.length > cap ? [...wide].sort((a, b) => Number(a.w < CARD_W) - Number(b.w < CARD_W) || band(a.y) - band(b.y) || b.w - a.w).slice(0, cap) : wide;
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}
