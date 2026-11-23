/**
 * How much the page needs what lies under a point ("page.importance"), so a
 * module drawn over it (a burrow, a creature) keeps off text, controls and
 * data. Worked out here, from the host's own page: the module gets a number
 * per point, never what is there. Fields where the person types (a password
 * above all) count as fully important and are never looked into.
 */

export type Importance = 0 | 0.8 | 1;
export const IMPORTANCE_MAX_POINTS = 600;

const INTERACTIVE =
  "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[role=slider],[role=progressbar],[role=meter],[role=textbox],[contenteditable]:not([contenteditable=false])";
const PICTURES = "svg,canvas,img,video,picture";

export type ImportancePage = Pick<Document, "elementFromPoint" | "documentElement" | "body" | "createRange"> & {
  width: number;
  height: number;
  style(e: Element): { cursor: string; backgroundColor: string };
};

/** One call's look at the page: each element's style and box read once. */
export function importanceOf(page: ImportancePage) {
  const known = new Map<Element, { fixed: Importance | null; text: Node[] }>();
  const about = (e: Element) => {
    let k = known.get(e);
    if (k) return k;
    let fixed: Importance | null = null;
    const text: Node[] = [];
    if (e.closest(INTERACTIVE) || e.closest(PICTURES)) fixed = 1;
    else {
      for (const n of Array.from(e.childNodes)) if (n.nodeType === 3 && n.textContent?.trim()) text.push(n);
      const s = page.style(e);
      if (s.cursor === "pointer") fixed = 1;
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
  return (x: number, y: number): Importance => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= page.width || y >= page.height) return 1;
    const e = page.elementFromPoint(x, y);
    if (!e || e === page.documentElement || e === page.body) return 0;
    const k = about(e);
    if (k.fixed === 1) return 1;
    // Text: only where its glyphs are, not the whole box around them.
    for (const n of k.text) {
      const r = page.createRange();
      r.selectNodeContents(n);
      for (const b of Array.from(r.getClientRects())) if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) return 1;
    }
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

export const browserPage = (): ImportancePage => ({
  elementFromPoint: (x, y) => document.elementFromPoint(x, y),
  documentElement: document.documentElement,
  body: document.body,
  createRange: () => document.createRange(),
  width: window.innerWidth,
  height: window.innerHeight,
  style: e => getComputedStyle(e),
});
