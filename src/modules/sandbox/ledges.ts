/**
 * Where a creature drawn over the page may stand ("page.ledges"): the top
 * edges of the cards and section headers in sight, as rectangles in the
 * module's box. Only where they are, never what they hold; an edge something
 * covers (a sticky header, a dialog) is left out.
 */

export type Ledge = { x: number; y: number; w: number };
/** At most this many edges an answer, and elements looked at a call. */
export const LEDGES_MAX = 24;
const SCAN_MAX = 160;
/** Narrower than this, nothing stands on it. */
const MIN_W = 96;

/** What a ledge is read from: an element's box, and whether the page's top element at a point is part of it. */
export type LedgeEl = { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number }; contains(other: Node | null): boolean };
export type LedgePage<E extends LedgeEl = LedgeEl> = {
  candidates(): Iterable<E>;
  elementFromPoint(x: number, y: number): Node | null;
  width: number;
  height: number;
};

/** The ledges in sight inside a box at (left, top), w × h on the page; in the box's px, top to bottom. */
export function ledgesAround<E extends LedgeEl>(page: LedgePage<E>, box: { left: number; top: number; width: number; height: number }): Ledge[] {
  const out: Ledge[] = [];
  let seen = 0;
  for (const el of page.candidates()) {
    if (++seen > SCAN_MAX) break;
    const r = el.getBoundingClientRect();
    const top = Math.round(r.top);
    // The edge itself in the window and in the box (room above it for whatever stands there).
    if (top < 0 || top >= page.height || top < box.top || top >= box.top + box.height) continue;
    const l = Math.max(r.left, 0, box.left);
    const rt = Math.min(r.right, page.width, box.left + box.width);
    if (rt - l < MIN_W) continue;
    // Covered at its middle (a sticky header, a sheet over it): not in sight.
    const probe = page.elementFromPoint((l + rt) / 2, Math.min(r.bottom - 1, top + 2));
    if (!probe || !el.contains(probe)) continue;
    const ledge = { x: Math.round(l - box.left), y: top - Math.round(box.top), w: Math.round(rt - l) };
    // A card in a card on the same line: one ledge, the wider.
    const same = out.findIndex(o => Math.abs(o.y - ledge.y) <= 1 && o.x < ledge.x + ledge.w && ledge.x < o.x + o.w);
    if (same >= 0) {
      if (ledge.w > (out[same]?.w ?? 0)) out[same] = ledge;
      continue;
    }
    out.push(ledge);
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, LEDGES_MAX);
}

/** The cards and section headers of the main region. */
const CANDIDATES = 'main [data-surface="card"], main [data-surface="panel"], main h2, main h3';

export const browserLedges = (): LedgePage<HTMLElement> => ({
  candidates: () => document.querySelectorAll<HTMLElement>(CANDIDATES),
  elementFromPoint: (x, y) => document.elementFromPoint(x, y),
  width: window.innerWidth,
  height: window.innerHeight,
});
