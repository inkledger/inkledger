import { describe, expect, it } from "vitest";
import { IMPORTANCE_SLICE_MS, importanceAround, importanceInSlices, type ImportancePage } from "./importance";

type Fake = { tag: string; bg?: string; cursor?: string; h?: number; text?: { left: number; right: number; top: number; bottom: number } };

/** Elements by rectangle; `closest` knows only the element's own tag (enough for these). */
function page(at: (x: number, y: number) => Fake | "body" | null) {
  const styled: Fake[] = [];
  const els = new Map<Fake, Element>();
  const body = {} as Element;
  const el = (f: Fake): Element => {
    let e = els.get(f);
    if (e) return e;
    e = {
      closest: (sel: string) => (sel.split(",").includes(f.tag) ? e : null),
      childNodes: f.text ? [{ nodeType: 3, textContent: "Hello", rect: f.text }] : [],
      getBoundingClientRect: () => ({ height: f.h ?? 100 }),
      getClientRects: () => [{ left: -1e6, top: -1e6, right: 1e6, bottom: 1e6 }],
    } as unknown as Element;
    els.set(f, e);
    return e;
  };
  const p: ImportancePage = {
    width: 1000,
    height: 800,
    documentElement: {} as HTMLElement,
    body: body as HTMLElement,
    activeElement: body,
    elementFromPoint: (x, y) => {
      const f = at(x, y);
      return f === "body" ? body : f ? el(f) : null;
    },
    elementsFromPoint: () => [],
    createRange: () => {
      let rect: Fake["text"];
      return { selectNodeContents: (n: { rect: Fake["text"] }) => void (rect = n.rect), getClientRects: () => (rect ? [rect] : []) } as unknown as Range;
    },
    style: e => {
      const f = [...els].find(([, v]) => v === e)?.[0];
      if (f) styled.push(f);
      return { cursor: f?.cursor ?? "auto", backgroundColor: f?.bg ?? "rgba(0, 0, 0, 0)" };
    },
  };
  return { p, styled };
}

describe("page.importance, worked out by the host", () => {
  it("off the page and on controls: important; on the bare page: free", () => {
    const password: Fake = { tag: "input" };
    const editable: Fake = { tag: "[contenteditable]:not([contenteditable=false])" };
    const { p, styled } = page(x => (x < 100 ? password : x < 200 ? editable : "body"));
    expect(importanceAround(p, { left: 0, top: 0, width: 1000, height: 800 }, [[50, 10], [150, 10], [500, 10], [-1, 10], [10, 900]])).toEqual([1, 1, 0, 1, 1]);
    // A field where the person types is never looked into.
    expect(styled).toEqual([]);
  });

  it("small coloured shapes are data, big ones cards; text only where its glyphs are", () => {
    const chip: Fake = { tag: "span", bg: "rgb(200, 80, 40)", h: 20 };
    const card: Fake = { tag: "div", bg: "rgb(255, 255, 255)", h: 300 };
    const label: Fake = { tag: "p", text: { left: 300, right: 400, top: 0, bottom: 20 } };
    const { p } = page(x => (x < 100 ? chip : x < 200 ? card : label));
    expect(importanceAround(p, { left: 0, top: 0, width: 1000, height: 800 }, [[50, 5], [150, 5], [350, 10], [500, 100]])).toEqual([0.8, 0, 1, 0]);
  });

  it("points are the module's box's own, at most 600, each element read once a call", () => {
    const card: Fake = { tag: "div", bg: "rgb(255, 255, 255)", h: 300 };
    const { p, styled } = page(x => (x >= 500 ? card : "body"));
    const points = Array.from({ length: 700 }, (): [number, number] => [10, 10]);
    const out = importanceAround(p, { left: 495, top: 0, width: 100, height: 100 }, points);
    expect(out).toHaveLength(600);
    expect(new Set(out)).toEqual(new Set([0]));
    expect(styled).toHaveLength(1);
    expect(importanceAround(p, { left: 0, top: 0, width: 100, height: 100 }, [[10, 10]])).toEqual([0]);
  });

  it("only within the module's own box: a point past it is important, never looked at", () => {
    const card: Fake = { tag: "div", bg: "rgb(255, 255, 255)", h: 300 };
    const looked: [number, number][] = [];
    const { p } = page((x, y) => (looked.push([x, y]), x >= 0 ? card : "body"));
    const box = { left: 100, top: 100, width: 40, height: 40 };
    expect(importanceAround(p, box, [[10, 10], [-50, -50], [40, 10], [10, 600], [39.5, 39.5]])).toEqual([0, 1, 1, 1, 0]);
    expect(looked).toEqual([[110, 110], [139.5, 139.5]]);
  });
});

type Box = { left: number; top: number; right: number; bottom: number };
type Node2 = { tag: string; box: Box; paint?: Box; parent?: Node2; text?: Box[]; bg?: string; cursor?: string; focus?: boolean };
const inside = (b: Box, x: number, y: number) => x >= b.left && x < b.right && y >= b.top && y < b.bottom;

/** Laid-out elements, later ones painted on top; `paint` is what a pseudo-element adds past the own box. */
function laidOut(nodes: Node2[], active: Node2 | null = null) {
  const els = new Map<Node2, Element>();
  const looked: Node2[] = [];
  const of = (e: Element) => [...els].find(([, v]) => v === e)?.[0];
  const el = (n: Node2): Element => {
    let e = els.get(n);
    if (e) return e;
    e = {
      closest: (sel: string) => {
        const tags = sel.split(",");
        for (let c: Node2 | undefined = n; c; c = c.parent) if (tags.includes(c.tag)) return el(c);
        return null;
      },
      matches: () => !!n.focus,
      childNodes: (n.text ?? []).map(rect => ({ nodeType: 3, textContent: "ink", rect })),
      getClientRects: () => [n.box],
      getBoundingClientRect: () => ({ ...n.box, width: n.box.right - n.box.left, height: n.box.bottom - n.box.top }),
    } as unknown as Element;
    els.set(n, e);
    return e;
  };
  const stack = (x: number, y: number) => nodes.filter(n => inside(n.paint ?? n.box, x, y)).reverse();
  const body = {} as HTMLElement;
  const p: ImportancePage = {
    width: 1000,
    height: 800,
    documentElement: {} as HTMLElement,
    body,
    activeElement: active ? el(active) : body,
    elementFromPoint: (x, y) => {
      const top = stack(x, y)[0];
      return top ? el(top) : body;
    },
    elementsFromPoint: (x, y) => [...stack(x, y).map(el), body],
    createRange: () => {
      let rect: Box | undefined;
      return { selectNodeContents: (t: { rect: Box }) => void (rect = t.rect), getClientRects: () => (rect ? [rect] : []) } as unknown as Range;
    },
    style: e => {
      const n = of(e);
      if (n) looked.push(n);
      return { cursor: n?.cursor ?? "auto", backgroundColor: n?.bg ?? "rgba(0, 0, 0, 0)" };
    },
  };
  return { p, looked };
}
const whole = { left: 0, top: 0, width: 1000, height: 800 };

describe("page.importance: the ink, not the boxes", () => {
  // A Board card: title, key link stretched over the card by its ::after, a start button, padding.
  const card: Node2 = { tag: "div", box: { left: 100, top: 100, right: 400, bottom: 220 }, bg: "rgb(255, 255, 255)", cursor: "grab" };
  const title: Node2 = { tag: "p", box: { left: 110, top: 110, right: 390, bottom: 130 }, parent: card, text: [{ left: 110, top: 112, right: 240, bottom: 128 }] };
  const key: Node2 = { tag: "a", box: { left: 110, top: 134, right: 160, bottom: 150 }, paint: card.box, parent: card, text: [{ left: 110, top: 134, right: 160, bottom: 150 }] };
  const start: Node2 = { tag: "button", box: { left: 370, top: 190, right: 394, bottom: 214 }, parent: card };

  it("a card's padding and the room between its title and its bottom row are free", () => {
    const { p } = laidOut([card, title, key, start]);
    // padding, between title and badge row, beside the title's glyphs, the title, the key, the button
    expect(importanceAround(p, whole, [[104, 104], [250, 175], [300, 120], [150, 120], [130, 142], [380, 200]])).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("a big clickable row counts by its ink, a control-sized one whole", () => {
    const row: Node2 = { tag: "[role=button]", box: { left: 0, top: 300, right: 900, bottom: 360 } };
    const label: Node2 = { tag: "span", box: { left: 20, top: 320, right: 200, bottom: 340 }, parent: row, text: [{ left: 20, top: 322, right: 120, bottom: 338 }] };
    const nav: Node2 = { tag: "a", box: { left: 0, top: 400, right: 240, bottom: 428 } };
    const { p } = laidOut([row, label, nav]);
    expect(importanceAround(p, whole, [[500, 330], [150, 330], [60, 330], [200, 414]])).toEqual([0, 0, 1, 1]);
  });

  it("a field where the person types stays whole and unread, even under a stretched link", () => {
    const field: Node2 = { tag: "input", box: { left: 0, top: 500, right: 900, bottom: 560 } };
    const cover: Node2 = { tag: "a", box: { left: 0, top: 600, right: 10, bottom: 610 }, paint: field.box };
    const { p, looked } = laidOut([field, cover]);
    expect(importanceAround(p, whole, [[450, 530]])).toEqual([1]);
    expect(looked).toEqual([]);
  });

  it("a focus ring around the focused control is important", () => {
    const btn: Node2 = { tag: "button", box: { left: 100, top: 700, right: 140, bottom: 730 }, focus: true };
    const { p } = laidOut([btn], btn);
    expect(importanceAround(p, whole, [[98, 715], [150, 715]])).toEqual([1, 0]);
    // A focused card: its edge, not its inside.
    const big: Node2 = { tag: "div", box: { left: 300, top: 300, right: 600, bottom: 420 }, focus: true };
    const { p: q } = laidOut([big], big);
    expect(importanceAround(q, whole, [[298, 360], [450, 360], [450, 421]])).toEqual([1, 0, 1]);
  });

  it("a long call yields between slices of a few milliseconds, with the same answers", async () => {
    const { p } = laidOut([card, title, key, start]);
    const points: [number, number][] = Array.from({ length: 50 }, (_, i) => [100 + i * 6, 104 + (i % 12) * 9]);
    let ms = 0;
    let yields = 0;
    // Each point costs a millisecond of the clock.
    const clock = { now: () => ms++, yield: async () => void yields++ };
    const out = await importanceInSlices(() => p, () => whole, points, clock);
    expect(out).toEqual(importanceAround(p, whole, points));
    expect(yields).toBeGreaterThanOrEqual(Math.floor(50 / (IMPORTANCE_SLICE_MS + 1)) - 1);
  });
});
