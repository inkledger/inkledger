import { describe, expect, it } from "vitest";
import type { LayoutState, PointerState } from "../hostV2";
import { createLayoutChangedFeed, createLayoutFeed, createPointerFeed, POINTER_RANGE_PX, createScrollingFlag, watchBlur, watchContent, type LayoutChangedWin, type PointerWin } from "./feeds";

function fakeWin() {
  const on = new Map<string, Set<(e: unknown) => void>>();
  const frames: (() => void)[] = [];
  const target = () => ({
    addEventListener: (t: string, fn: (e: unknown) => void) => void (on.get(t) ?? on.set(t, new Set()).get(t))?.add(fn),
    removeEventListener: (t: string, fn: (e: unknown) => void) => void on.get(t)?.delete(fn),
  });
  const doc = { hidden: false, ...target() };
  const win = { ...target(), innerWidth: 800, innerHeight: 600, document: doc, requestAnimationFrame: (fn: () => void) => frames.push(fn) };
  return {
    win: win as unknown as PointerWin,
    doc,
    fire: (t: string, e: unknown) => on.get(t)?.forEach(fn => fn(e)),
    frame: () => frames.splice(0).forEach(fn => fn()),
    listeners: () => [...on.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("the pointer feed", () => {
  it("one value per frame, relative to the box, nothing twice", () => {
    const w = fakeWin();
    const feed = createPointerFeed(w.win);
    const got: PointerState[] = [];
    const off = feed.watch(() => ({ left: 100, top: 50, right: 200, bottom: 150 }), v => got.push(v));
    w.fire("pointermove", { clientX: 110, clientY: 60 });
    w.fire("pointermove", { clientX: 120, clientY: 70 });
    w.frame();
    w.frame();
    w.fire("pointermove", { clientX: 120.2, clientY: 70 });
    w.frame();
    expect(got).toEqual([null, { x: 20, y: 20 }]);
    off();
    expect(w.listeners()).toBe(0);
  });

  it("null while the page is hidden, the box off screen or the pointer out of the window", () => {
    const w = fakeWin();
    const feed = createPointerFeed(w.win);
    const got: PointerState[] = [];
    let box = { left: 0, top: 0, right: 10, bottom: 10 };
    feed.watch(() => box, v => got.push(v));
    w.fire("pointermove", { clientX: 5, clientY: 5 });
    w.frame();
    w.doc.hidden = true;
    w.fire("visibilitychange", {});
    w.frame();
    w.doc.hidden = false;
    w.fire("pointermove", { clientX: 6, clientY: 6 });
    w.frame();
    box = { left: 0, top: 700, right: 10, bottom: 710 };
    w.fire("pointermove", { clientX: 7, clientY: 7 });
    w.frame();
    box = { left: 0, top: 0, right: 10, bottom: 10 };
    w.fire("pointermove", { clientX: 7, clientY: 7 });
    w.frame();
    w.fire("pointerout", { relatedTarget: {} });
    w.frame();
    w.fire("pointerout", { relatedTarget: null });
    w.frame();
    expect(got).toEqual([null, { x: 5, y: 5 }, null, { x: 6, y: 6 }, null, { x: 7, y: 7 }, null]);
  });

  it("the page-wide pointer (range Infinity): anywhere in the window, in the box's px", () => {
    const w = fakeWin();
    const feed = createPointerFeed(w.win);
    const near: PointerState[] = [];
    const far: PointerState[] = [];
    const rect = () => ({ left: 100, top: 100, right: 120, bottom: 120 });
    feed.watch(rect, v => near.push(v));
    feed.watch(rect, v => far.push(v), Infinity);
    w.fire("pointermove", { clientX: 700, clientY: 500 });
    w.frame();
    expect(near).toEqual([null]);
    expect(far).toEqual([null, { x: 600, y: 400 }]);
  });

  it("only in range of the box: a move across the rest of the window is not the module's", () => {
    const w = fakeWin();
    const feed = createPointerFeed(w.win);
    const got: PointerState[] = [];
    feed.watch(() => ({ left: 0, top: 0, right: 40, bottom: 40 }), v => got.push(v));
    w.fire("pointermove", { clientX: 30, clientY: 30 });
    w.frame();
    w.fire("pointermove", { clientX: 40 + POINTER_RANGE_PX, clientY: 30 });
    w.frame();
    w.fire("pointermove", { clientX: 700, clientY: 500 });
    w.frame();
    w.fire("pointermove", { clientX: 30, clientY: 40 + POINTER_RANGE_PX + 1 });
    w.frame();
    expect(got).toEqual([null, { x: 30, y: 30 }, { x: 40 + POINTER_RANGE_PX, y: 30 }, null]);
  });
});

describe("the layout feed", () => {
  it("the sidebar and the dock, told when they change", () => {
    let rail = false;
    let docked = false;
    let changed = () => {};
    const feed = createLayoutFeed({ rail: () => rail, docked: () => docked, subscribe: fn => ((changed = fn), () => (changed = () => {})) });
    const got: LayoutState[] = [];
    const off = feed.watch(v => got.push(v));
    rail = true;
    changed();
    changed();
    docked = true;
    feed.poke();
    off();
    expect(got).toEqual([
      { sidebar: "full", docked: false },
      { sidebar: "rail", docked: false },
      { sidebar: "rail", docked: true },
    ]);
  });
});

describe("the backdrop's blur", () => {
  it("read where the host sets it, again when that changes", () => {
    let px = "5px";
    let changed = () => {};
    const source = {} as Element;
    const box = { closest: () => source } as unknown as Element;
    const got: number[] = [];
    watchBlur(box, v => got.push(v), { style: () => ({ getPropertyValue: () => px }), observe: (_e, fn) => ((changed = fn), () => {}) });
    px = "3px";
    changed();
    changed();
    expect(got).toEqual([5, 3]);
  });
});

describe("the layout-changed feed", () => {
  it("one nudge once scrolls, resizes and switches settle, in a frame; nothing heard while unwatched", () => {
    const w = fakeWin();
    const timers = new Map<number, () => void>();
    let next = 0;
    const win = Object.assign(w.win, {
      setTimeout: (fn: () => void) => (timers.set(++next, fn), next),
      clearTimeout: (id: number) => void timers.delete(id),
    }) as unknown as LayoutChangedWin;
    const runTimers = () => [...timers.entries()].forEach(([id, fn]) => (timers.delete(id), fn()));
    const switches = new Set<() => void>();
    const feed = createLayoutChangedFeed(win, [fn => (switches.add(fn), () => void switches.delete(fn))]);
    let told = 0;
    w.fire("scroll", {});
    expect(timers.size).toBe(0);
    const off = feed.watch(() => told++);
    w.fire("scroll", {});
    w.fire("scroll", {});
    w.fire("resize", {});
    switches.forEach(fn => fn());
    expect(timers.size).toBe(1);
    w.frame();
    expect(told).toBe(0);
    runTimers();
    expect(told).toBe(0);
    w.frame();
    expect(told).toBe(1);
    off();
    expect(w.listeners()).toBe(0);
    expect(switches.size).toBe(0);
  });
});

describe("what Desk Radio reads of the layout", () => {
  const timed = () => {
    const w = fakeWin();
    const timers = new Map<number, () => void>();
    let next = 0;
    const win = Object.assign(w.win, {
      setTimeout: (fn: () => void) => (timers.set(++next, fn), next),
      clearTimeout: (id: number) => void timers.delete(id),
    }) as unknown as LayoutChangedWin;
    return { ...w, win, runTimers: () => [...timers.entries()].forEach(([id, fn]) => (timers.delete(id), fn())) };
  };

  it("the page scrolling: two changes a gesture, not one per scroll event", () => {
    const w = timed();
    const flag = createScrollingFlag(w.win);
    const seen: boolean[] = [];
    const off = flag.subscribe(() => seen.push(flag.get()));
    for (let i = 0; i < 5; i++) w.fire("scroll", {});
    w.runTimers();
    expect(seen).toEqual([true, false]);
    off();
    expect(w.listeners()).toBe(0);
  });

  it("the window's size, the sidebar's overflow and the scrolling, each pushed when it changes", () => {
    let fn: () => void = () => {};
    let size = { width: 390, height: 700 };
    let more = false;
    const feed = createLayoutFeed({ rail: () => false, docked: () => false, subscribe: f => ((fn = f), () => {}), viewport: () => size, navMore: () => more, scrolling: () => false });
    const got: LayoutState[] = [];
    feed.watch(v => got.push(v));
    fn();
    more = true;
    fn();
    size = { width: 390, height: 900 };
    fn();
    expect(got).toEqual([
      { sidebar: "full", docked: false, viewport: { width: 390, height: 700 }, navMore: false, scrolling: false },
      { sidebar: "full", docked: false, viewport: { width: 390, height: 700 }, navMore: true, scrolling: false },
      { sidebar: "full", docked: false, viewport: { width: 390, height: 900 }, navMore: true, scrolling: false },
    ]);
  });
});

describe("the page's content changing", () => {
  it("tells elements added or removed under the root, never text alone (a ticking timer), until undone", () => {
    let records: (r: { addedNodes: { nodeType: number }[]; removedNodes: { nodeType: number }[] }[]) => void = () => {};
    let watched: unknown = null;
    let disconnected = 0;
    class Observer {
      constructor(cb: typeof records) {
        records = cb;
      }
      observe(root: unknown, opts: unknown) {
        watched = [root, opts];
      }
      disconnect() {
        disconnected++;
      }
    }
    let told = 0;
    const root = {} as Node;
    const off = watchContent(root, () => void told++, Observer as unknown as typeof MutationObserver);
    expect(watched).toEqual([root, { childList: true, subtree: true }]);
    records([{ addedNodes: [{ nodeType: 3 }], removedNodes: [{ nodeType: 3 }] }]);
    expect(told).toBe(0);
    records([{ addedNodes: [{ nodeType: 1 }], removedNodes: [] }]);
    records([{ addedNodes: [], removedNodes: [{ nodeType: 1 }] }]);
    expect(told).toBe(2);
    off();
    expect(disconnected).toBe(1);
  });
});
