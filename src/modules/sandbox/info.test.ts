import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXED, INFO_MARGIN, createInfoSource, mergeSurfaces, scanInfo, scrollerIds, type InfoEl, type InfoEnv, type InfoPage, type InfoStyle, type ScrollEvent } from "./info";

type Box = [left: number, top: number, w: number, h: number];
type F = { tag?: string; role?: string; editable?: boolean; r: Box; st?: Partial<InfoStyle>; text?: Box[]; kids?: F[]; scroll?: { w: number; h: number; x?: number; y?: number } };
const STYLE: InfoStyle = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  position: "static",
  overflowX: "visible",
  overflowY: "visible",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  boxShadow: "none",
  borderTopWidth: "0px",
  borderTopStyle: "none",
  borderTopColor: "rgb(0, 0, 0)",
  borderBottomWidth: "0px",
  borderBottomStyle: "none",
  borderBottomColor: "rgb(0, 0, 0)",
  color: "rgb(0, 0, 0)",
  cursor: "auto",
};
const rectOf = ([l, t, w, h]: Box) => ({ left: l, top: t, right: l + w, bottom: t + h });
function el(f: F): InfoEl {
  return {
    key: f,
    tag: f.tag ?? "div",
    role: f.role ?? null,
    editable: f.editable ?? false,
    style: () => ({ ...STYLE, ...f.st }),
    rect: () => rectOf(f.r),
    client: () => ({ ...rectOf(f.r), scrollW: f.scroll?.w ?? f.r[2], scrollH: f.scroll?.h ?? f.r[3], clientW: f.r[2], clientH: f.r[3], scrollX: f.scroll?.x ?? 0, scrollY: f.scroll?.y ?? 0 }),
    textRects: () => (f.text ?? []).map(rectOf),
    *children() {
      for (const k of f.kids ?? []) yield el(k);
    },
  };
}
const pageOf = (kids: F[], w = 1280, h = 800): InfoPage => ({ root: el({ r: [0, 0, w, h], kids }), width: w, height: h, scrollX: 0, scrollY: 0 });
const now = { t: 0 };
const fast = { now: () => now.t, yield: () => Promise.resolve() };
const scan = (kids: F[]) => scanInfo(pageOf(kids), scrollerIds(), fast);
const CARD = { backgroundColor: "rgb(255, 255, 255)", borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "rgb(220, 220, 220)", borderBottomWidth: "1px", borderBottomStyle: "solid", borderBottomColor: "rgb(220, 220, 220)" };

describe("page.info", () => {
  it("text: one rect per line box, tight to it; fragments side by side on a line are one", async () => {
    const got = await scan([{ r: [100, 100, 400, 60], text: [[110, 110, 80, 18], [110, 130, 50, 18]], kids: [{ tag: "b", r: [192, 111, 40, 17], st: { display: "inline" }, text: [[192, 111, 40, 17]] }] }]);
    expect(got.rects.filter(r => r.kind === "text")).toEqual([
      { x: 110, y: 110, w: 122, h: 18, kind: "text", interactive: false, s: 0 },
      { x: 110, y: 130, w: 50, h: 18, kind: "text", interactive: false, s: 0 },
    ]);
  });

  it("fills, stripes and empty blocks are never rects; their faces are surfaces", async () => {
    const got = await scan([{ r: [100, 200, 600, 300], st: CARD, kids: [{ r: [120, 260, 200, 180], st: { backgroundColor: "rgb(250, 230, 220)", backgroundImage: "repeating-linear-gradient(45deg, red, blue)" } }] }]);
    expect(got.rects).toEqual([]);
    expect(got.surfaces).toEqual(
      expect.arrayContaining([
        { x: 100, y: 200, w: 600, kind: "top", s: 0 },
        { x: 100, y: 499, w: 600, kind: "top", s: 0 },
        { x: 100, y: 500, w: 600, kind: "bottom", s: 0 },
        { x: 120, y: 260, w: 200, kind: "top", s: 0 },
        { x: 120, y: 440, w: 200, kind: "bottom", s: 0 },
      ]),
    );
  });

  it("a control-sized button is one interactive rect (what it holds is not read again); a big clickable card is read by its ink", async () => {
    const got = await scan([
      { tag: "button", r: [900, 20, 120, 36], st: { backgroundColor: "rgb(80, 40, 30)" }, text: [[930, 29, 70, 18]], kids: [{ tag: "svg", r: [910, 30, 16, 16] }] },
      { tag: "a", r: [100, 300, 500, 120], text: [[120, 320, 200, 18]] },
    ]);
    expect(got.rects).toEqual([
      { x: 120, y: 320, w: 200, h: 18, kind: "text", interactive: true, s: 0 },
      { x: 900, y: 20, w: 120, h: 36, kind: "control", interactive: true, s: 0 },
    ]);
    // The button's own top is a surface (it stands out from the page).
    expect(got.surfaces).toContainEqual({ x: 900, y: 20, w: 120, kind: "top", s: 0 });
  });

  it("a wide clickable row is read by its ink: what inherits its pointer cursor is no control of its own", async () => {
    const got = await scan([{ r: [100, 100, 900, 40], st: { cursor: "pointer" }, kids: [{ r: [110, 110, 30, 20], st: { cursor: "pointer" } }, { r: [200, 110, 100, 20], st: { cursor: "pointer" }, text: [[200, 111, 80, 18]] }] }]);
    expect(got.rects).toEqual([{ x: 200, y: 111, w: 80, h: 18, kind: "text", interactive: true, s: 0 }]);
  });

  it("a rich-text editor is one control, never looked into", async () => {
    const got = await scan([{ r: [100, 100, 400, 40], editable: true, kids: [{ tag: "p", r: [100, 100, 400, 20], text: [[100, 101, 300, 18]] }] }]);
    expect(got.rects).toEqual([{ x: 100, y: 100, w: 400, h: 40, kind: "control", interactive: true, s: 0 }]);
  });

  it("pictures and icons are media; small coloured shapes are data marks; a 1 px divider is a surface only", async () => {
    const got = await scan([
      { tag: "svg", r: [40, 40, 16, 16] },
      { r: [100, 100, 60, 20], st: { backgroundColor: "rgb(240, 240, 240)" } },
      { r: [100, 200, 400, 1], st: { backgroundColor: "rgb(200, 200, 200)" } },
    ]);
    expect(got.rects).toEqual([
      { x: 40, y: 40, w: 16, h: 16, kind: "media", interactive: false, s: 0 },
      { x: 100, y: 100, w: 60, h: 20, kind: "mark", interactive: false, s: 0 },
    ]);
    expect(got.surfaces).toContainEqual({ x: 100, y: 200, w: 400, kind: "top", s: 0 });
  });

  it("clipped to what shows: overflow hidden cuts; a scroller has its id, its items carry it and stop at its margin", async () => {
    const card = (i: number): F => ({ r: [520, 120 + i * 100, 300, 80], st: CARD, text: [[530, 130 + i * 100, 100, 18]] });
    const got = await scan([
      { r: [100, 100, 200, 40], st: { overflowX: "hidden", overflowY: "hidden" }, text: [[110, 110, 400, 18]] },
      { r: [500, 100, 340, 500], st: { overflowX: "hidden", overflowY: "auto" }, scroll: { w: 340, h: 3000 }, kids: Array.from({ length: 28 }, (_, i) => card(i)) },
    ]);
    expect(got.rects[0]).toEqual({ x: 110, y: 110, w: 190, h: 18, kind: "text", interactive: false, s: 0 });
    const sc = got.scrollers.find(s => s.id !== 0);
    expect(sc).toMatchObject({ x: 500, y: 100, w: 340, h: 500 });
    const inside = got.rects.filter(r => r.s === sc?.id);
    expect(inside.length).toBeGreaterThan(0);
    // Read down to the scroller's bottom plus the margin, not the whole list.
    expect(Math.max(...inside.map(r => r.y))).toBeLessThanOrEqual(600 + INFO_MARGIN);
    expect(inside.length).toBe(7);
  });

  it("hidden things count for nothing; an inline run has no surfaces; fixed things scroll with nothing", async () => {
    const got = await scan([
      { r: [0, 0, 400, 40], st: { display: "none" }, text: [[0, 0, 100, 18]] },
      { r: [0, 50, 400, 40], st: { opacity: "0" }, text: [[0, 50, 100, 18]] },
      { r: [0, 100, 400, 40], st: { visibility: "hidden" }, text: [[0, 100, 100, 18]] },
      { tag: "mark", r: [0, 150, 300, 18], st: { display: "inline", backgroundColor: "rgb(255, 255, 0)" }, text: [[0, 150, 300, 18]] },
      { r: [0, 700, 1280, 60], st: { position: "fixed", ...CARD } },
    ]);
    expect(got.rects).toEqual([{ x: 0, y: 150, w: 300, h: 18, kind: "text", interactive: false, s: 0 }]);
    expect(got.surfaces.every(f => f.y >= 700 && f.s === FIXED)).toBe(true);
  });

  it("faces at one height are merged where they touch, never across a gap", () => {
    expect(
      mergeSurfaces([
        { x: 0, y: 10, w: 100, kind: "top", s: 0 },
        { x: 100, y: 10.2, w: 50, kind: "top", s: 0 },
        { x: 200, y: 10, w: 50, kind: "top", s: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 10, w: 150, kind: "top", s: 0 },
      { x: 200, y: 10, w: 50, kind: "top", s: 0 },
    ]);
  });

  it("read in slices: it yields between them and finds the same", async () => {
    const kids = Array.from({ length: 300 }, (_, i): F => ({ r: [10 + (i % 10) * 120, 10 + Math.floor(i / 10) * 26, 110, 24], st: CARD, text: [[12 + (i % 10) * 120, 12 + Math.floor(i / 10) * 26, 60, 16]] }));
    let t = 0;
    let yields = 0;
    let longest = 0;
    let from = 0;
    const sliced = await scanInfo(pageOf(kids), scrollerIds(), {
      now: () => (t += 0.1),
      yield: () => {
        yields++;
        longest = Math.max(longest, t - from);
        from = t;
        return Promise.resolve();
      },
    });
    expect(yields).toBeGreaterThan(3);
    expect(longest).toBeLessThan(4.5);
    expect(sliced).toEqual(await scan(kids));
  });
});

function env(kids: F[]) {
  let watcher: Parameters<InfoEnv["watch"]>[0] | null = null;
  const frames: (() => void)[] = [];
  let scans = 0;
  const e: InfoEnv = {
    page: () => {
      scans++;
      return pageOf(kids);
    },
    ...fast,
    requestAnimationFrame: fn => frames.push(fn),
    watch(on) {
      watcher = on;
      return () => (watcher = null);
    },
  };
  return { e, frames, scans: () => scans, on: () => watcher };
}

describe("page.info source", () => {
  const list: F = { r: [500, 100, 340, 500], st: { overflowX: "hidden", overflowY: "auto" }, scroll: { w: 340, h: 3000 }, kids: [{ r: [520, 150, 300, 80], st: CARD, text: [[530, 160, 100, 18]] }] };

  it("held, it reads the page once until it changes; unheld, every time", async () => {
    const t = env([list]);
    const src = createInfoSource(t.e);
    await src.get();
    await src.get();
    expect(t.scans()).toBe(2);
    const release = src.hold();
    const a = await src.get();
    await src.get();
    expect(t.scans()).toBe(3);
    t.on()?.change();
    const b = await src.get();
    expect(t.scans()).toBe(4);
    expect(b.v).toBeGreaterThan(a.v);
    release();
    expect(t.on()).toBeNull();
  });

  it("a scroll shifts what scrolls with it and is told once a frame; far enough, the page is read again", async () => {
    const t = env([list]);
    const src = createInfoSource(t.e);
    const heard: ScrollEvent[] = [];
    const off = src.onScroll(e => heard.push(e));
    const a = await src.get();
    const id = a.scrollers.find(s => s.id !== 0)?.id ?? -9;
    const text = (s: typeof a) => s.rects.find(r => r.kind === "text");
    t.on()?.scroll(list, 0, 10);
    t.on()?.scroll(list, 0, 30);
    t.frames.splice(0).forEach(fn => fn());
    expect(heard).toEqual([{ kind: "scroll", s: id, dx: 0, dy: -30 }]);
    const b = await src.get();
    expect(t.scans()).toBe(1);
    expect(b.v).toBe(a.v);
    expect(text(b)?.y).toBe((text(a)?.y ?? 0) - 30);
    t.on()?.scroll(list, 0, 30 + INFO_MARGIN);
    await src.get();
    expect(t.scans()).toBe(2);
    off();
  });

  it("watches with observers and listeners only, and yields without timers", () => {
    for (const f of ["./info.ts", "./ledges.ts", "./importance.ts"]) expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(/setInterval|setTimeout/);
  });
});
