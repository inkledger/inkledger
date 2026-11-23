/**
 * How much the page needs what lies under a point ("page.importance"), so a
 * module drawn over it (a burrow, a creature) keeps off text, controls and
 * data. Worked out here, from the host's own page: the module gets a number
 * per point, never what is there. Fields where the person types (a password
 * above all) count as fully important and are never looked into.
 *
 * Its ink, not its boxes: text where its glyphs are, pictures, controls and the
 * focus ring count; a card's padding, the room between its lines, a big
 * clickable row's empty columns and what a pseudo-element stretches over a
 * card (a whole-card link) do not.
 */

import { yieldToPage } from "./info";

export type Importance = 0 | 0.8 | 1;
export const IMPORTANCE_MAX_POINTS = 600;
/** The page's thread a call may take before it yields (a quarter of a frame). */
export const IMPORTANCE_SLICE_MS = 4;

const TYPING = "input,select,textarea,[role=textbox],[contenteditable]:not([contenteditable=false])";
const INTERACTIVE =
  "a,button,label,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=slider],[role=progressbar],[role=meter]";
const PICTURES = "svg,canvas,img,video,picture";
// Up to a touch target's height and a wide button's width a control counts whole; past it, by its ink.
const CONTROL_H = 48;
const CONTROL_W = 480;
// A focus ring's reach past its control's box.
const RING = 4;

export type ImportancePage = Pick<Document, "elementFromPoint" | "elementsFromPoint" | "documentElement" | "body" | "createRange" | "activeElement"> & {
  width: number;
  height: number;
  style(e: Element): { cursor: string; backgroundColor: string };
};

type Rect = { left: number; top: number; right: number; bottom: number };
const within = (r: Rect, x: number, y: number, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

/** One call's look at the page: each element's style, boxes and text lines read once. */
export function importanceOf(page: ImportancePage) {
  const known = new Map<Element, { fixed: Importance | null; text: Rect[] }>();
  const boxes = new Map<Element, Rect[]>();
  const own = (e: Element) => {
    let b = boxes.get(e);
    if (!b) boxes.set(e, (b = Array.from(e.getClientRects())));
    return b;
  };
  const small = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.height <= CONTROL_H && r.width <= CONTROL_W;
  };
  const about = (e: Element) => {
    let k = known.get(e);
    if (k) return k;
    let fixed: Importance | null = null;
    const text: Rect[] = [];
    const control = e.closest(INTERACTIVE);
    if (e.closest(TYPING) || e.closest(PICTURES) || (control && small(control))) fixed = 1;
    else {
      for (const n of Array.from(e.childNodes))
        if (n.nodeType === 3 && n.textContent?.trim()) {
          const r = page.createRange();
          r.selectNodeContents(n);
          text.push(...Array.from(r.getClientRects()));
        }
      const s = page.style(e);
      if (s.cursor === "pointer" && small(e)) fixed = 1;
      else {
        // Small coloured shapes are data (bars, chips, dots); big ones are cards.
        const bg = s.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
        const alpha = bg.length === 4 ? (bg[3] ?? 0) : bg.length === 3 ? 1 : 0;
        if (alpha > 0.15 && e.getBoundingClientRect().height <= 24) fixed = 0.8;
      }
    }
    k = { fixed, text };
    known.set(e, k);
    return k;
  };
  const inked = (k: { text: Rect[] }, x: number, y: number) => k.text.some(b => within(b, x, y, 2));
  const active = page.activeElement;
  // The ring only, a band round the box (a module's own frame has none worth keeping off).
  const ring = active && active !== page.body && active.tagName !== "IFRAME" && active.matches(":focus-visible") ? own(active) : [];
  const onRing = (x: number, y: number) =>
    ring.some(b => within(b, x, y, RING) && !(x > b.left + RING && x < b.right - RING && y > b.top + RING && y < b.bottom - RING));
  return (x: number, y: number): Importance => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= page.width || y >= page.height) return 1;
    if (onRing(x, y)) return 1;
    let e = page.elementFromPoint(x, y);
    if (!e || e === page.documentElement || e === page.body) return 0;
    // Hit past its own boxes: a pseudo-element stretched over others, or text spilling out.
    if (!e.closest(TYPING) && !own(e).some(b => within(b, x, y))) {
      const k = about(e);
      if (k.fixed === null && inked(k, x, y)) return 1;
      e = page.elementsFromPoint(x, y).find(u => u === page.documentElement || u === page.body || u.closest(TYPING) || own(u).some(b => within(b, x, y))) ?? null;
      if (!e || e === page.documentElement || e === page.body) return 0;
    }
    const k = about(e);
    if (k.fixed === 1) return 1;
    // Text: only where its glyphs are, not the whole box around them.
    if (inked(k, x, y)) return 1;
    return k.fixed ?? 0;
  };
}

/** Points relative to the module's box on the page; one past the box is important, never looked at (it maps the box, not the page). */
export function importanceAround(
  page: ImportancePage,
  box: { left: number; top: number; width: number; height: number },
  points: readonly (readonly [number, number])[],
): Importance[] {
  const at = importanceOf(page);
  return points.slice(0, IMPORTANCE_MAX_POINTS).map(([x, y]) => (x >= 0 && y >= 0 && x < box.width && y < box.height ? at(box.left + x, box.top + y) : 1));
}

/** Like importanceAround, a few milliseconds of the page's thread at a time: it yields between slices, so no long task. */
export async function importanceInSlices(
  page: () => ImportancePage,
  box: () => { left: number; top: number; width: number; height: number },
  points: readonly (readonly [number, number])[],
  clock: { now(): number; yield(): Promise<void> } = { now: () => performance.now(), yield: yieldToPage },
): Promise<Importance[]> {
  const todo = points.slice(0, IMPORTANCE_MAX_POINTS);
  const out: Importance[] = [];
  for (;;) {
    // Read afresh each slice: the page may have scrolled or changed meanwhile.
    const b = box();
    const at = importanceOf(page());
    const from = clock.now();
    while (out.length < todo.length) {
      const [x, y] = todo[out.length] ?? [-1, -1];
      out.push(x >= 0 && y >= 0 && x < b.width && y < b.height ? at(b.left + x, b.top + y) : 1);
      if (clock.now() - from >= IMPORTANCE_SLICE_MS) break;
    }
    if (out.length >= todo.length) return out;
    await clock.yield();
  }
}

export const browserPage = (): ImportancePage => ({
  elementFromPoint: (x, y) => document.elementFromPoint(x, y),
  elementsFromPoint: (x, y) => document.elementsFromPoint(x, y),
  documentElement: document.documentElement,
  body: document.body,
  activeElement: document.activeElement,
  createRange: () => document.createRange(),
  width: window.innerWidth,
  height: window.innerHeight,
  style: e => getComputedStyle(e),
});
