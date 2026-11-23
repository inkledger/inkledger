import { describe, expect, it } from "vitest";
import { importanceAround, type ImportancePage } from "./importance";

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
    } as unknown as Element;
    els.set(f, e);
    return e;
  };
  const p: ImportancePage = {
    width: 1000,
    height: 800,
    documentElement: {} as HTMLElement,
    body: body as HTMLElement,
    elementFromPoint: (x, y) => {
      const f = at(x, y);
      return f === "body" ? body : f ? el(f) : null;
    },
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
