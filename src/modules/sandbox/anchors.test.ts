import { describe, expect, it } from "vitest";
import { ANCHORS_MAX, EVENTS_PER_SECOND, anchorsAround, createPageEvents, eventOf, watchTransitions, type AnchorEl, type PageSignal, type SignalPage } from "./anchors";
import type { PageEvent } from "../hostV2";

const el = (attrs: Record<string, string>, r: { left: number; top: number; right: number; bottom: number }): AnchorEl => ({
  getBoundingClientRect: () => r,
  getAttribute: k => attrs[k] ?? null,
});
const box = { left: 100, top: 50, width: 800, height: 600 };

describe("page.anchors", () => {
  it("landmarks in the box's px; columns by place and coarse category, never their names", () => {
    const page = {
      width: 1200,
      height: 800,
      anchors: () => [
        el({ "data-anchor": "board-column", "data-anchor-category": "done", "data-anchor-column": "s:1:Done" }, { left: 700, top: 100, right: 900, bottom: 700 }),
        el({ "data-anchor": "notifications" }, { left: 10, top: 20, right: 40, bottom: 50 }),
        el({ "data-anchor": "board-column", "data-anchor-category": "backlog" }, { left: 200, top: 100, right: 400, bottom: 700 }),
        el({ "data-anchor": "board-column", "data-anchor-category": "doing" }, { left: 450, top: 100, right: 650, bottom: 700 }),
      ],
    };
    expect(anchorsAround(page, box)).toEqual([
      { kind: "notifications", x: -90, y: -30, w: 30, h: 30 },
      { kind: "board-column", index: 0, category: "todo", x: 100, y: 50, w: 200, h: 600 },
      { kind: "board-column", index: 1, category: "doing", x: 350, y: 50, w: 200, h: 600 },
      { kind: "board-column", index: 2, category: "done", x: 600, y: 50, w: 200, h: 600 },
    ]);
    expect(JSON.stringify(anchorsAround(page, box))).not.toContain("Done");
  });

  it("only what shows: a hidden twin (no size), one out of the window, an unknown kind are left out; one of each", () => {
    const page = {
      width: 1200,
      height: 800,
      anchors: () => [
        el({ "data-anchor": "search" }, { left: 0, top: 0, right: 0, bottom: 0 }),
        el({ "data-anchor": "search" }, { left: 5, top: 5, right: 50, bottom: 25 }),
        el({ "data-anchor": "search" }, { left: 5, top: 30, right: 50, bottom: 50 }),
        el({ "data-anchor": "timer" }, { left: 5, top: 900, right: 50, bottom: 950 }),
        el({ "data-anchor": "password" }, { left: 5, top: 5, right: 50, bottom: 25 }),
      ],
    };
    expect(anchorsAround(page, { left: 0, top: 0, width: 1200, height: 800 })).toEqual([{ kind: "search", x: 5, y: 5, w: 45, h: 20 }]);
  });

  it("a few dozen at most", () => {
    const many = Array.from({ length: 80 }, (_, i) => el({ "data-anchor": "board-column" }, { left: i * 10, top: 0, right: i * 10 + 9, bottom: 10 }));
    expect(anchorsAround({ width: 2000, height: 800, anchors: () => many }, box)).toHaveLength(ANCHORS_MAX);
  });
});

const signalPage = (over: Partial<SignalPage> = {}): SignalPage => ({
  card: () => null,
  column: id => (id === "to" ? el({}, { left: 500, top: 100, right: 700, bottom: 700 }) : id === "from" ? el({}, { left: 200, top: 100, right: 400, bottom: 700 }) : null),
  anchor: kind => (kind === "timer" ? el({}, { left: 10, top: 700, right: 250, bottom: 760 }) : null),
  width: 1200,
  height: 800,
  ...over,
});

describe("transitions", () => {
  it("pending at the first sign of a change, ready once it settles; one pair per change", () => {
    const got: PageSignal[] = [];
    let start: (() => void) | null = null;
    let settle: (() => void) | null = null;
    let pokes = 0;
    const off = watchTransitions(s => got.push(s), [p => ((start = p), () => (start = null))], f => ((settle = f), () => (settle = null)), () => pokes++);
    settle!();
    expect(got).toEqual([]);
    start!();
    start!();
    settle!();
    settle!();
    expect(got).toEqual([{ kind: "transition", phase: "pending" }, { kind: "transition", phase: "ready" }]);
    expect(pokes).toBe(2);
    off();
    expect(start).toBeNull();
    expect(settle).toBeNull();
  });

  it("a transition's words are never dropped by the events' cap", () => {
    const frames: (() => void)[] = [];
    let fire: ((s: PageSignal) => void) | null = null;
    const feed = createPageEvents({ requestAnimationFrame: fn => frames.push(fn), now: () => 0 }, [fn => ((fire = fn), () => {})]);
    const got: PageEvent[] = [];
    feed.watch(() => box, () => signalPage(), e => got.push(e));
    for (let i = 0; i < 12; i++) fire!({ kind: "goal-reached" });
    fire!({ kind: "transition", phase: "pending" });
    frames.splice(0).forEach(f => f());
    frames.splice(0).forEach(f => f());
    expect(got.at(-1)).toEqual({ kind: "transition", phase: "pending" });
  });
});

describe("page.events", () => {
  it("a move says where from and where to (and the card, when it shows), in the box's px", () => {
    const card = el({}, { left: 510, top: 120, right: 690, bottom: 180 });
    expect(eventOf({ kind: "card-moved", card: "1:AB-1", from: "from", to: "to" }, signalPage({ card: id => (id === "1:AB-1" ? card : null) }), box)).toEqual({
      kind: "card-moved",
      from: { x: 100, y: 50, w: 200, h: 600 },
      to: { x: 400, y: 50, w: 200, h: 600 },
      card: { x: 410, y: 70, w: 180, h: 60 },
    });
    // Closed off screen: the event still comes, with nothing to point at.
    expect(eventOf({ kind: "card-closed", card: "1:AB-2" }, signalPage(), box)).toEqual({ kind: "card-closed", card: null });
    expect(eventOf({ kind: "timer-started" }, signalPage(), box)).toEqual({ kind: "timer-started", at: { x: -90, y: 650, w: 240, h: 60 } });
  });

  it("switched on from its Store card: the card in the box's px, never held back by the cap", () => {
    const card = el({}, { left: 300, top: 200, right: 500, bottom: 400 });
    expect(eventOf({ kind: "enabled", from: card }, signalPage(), box)).toEqual({ kind: "enabled", from: { x: 200, y: 150, w: 200, h: 200 } });
    expect(eventOf({ kind: "enabled", from: null }, signalPage(), box)).toEqual({ kind: "enabled", from: null });
    const frames: (() => void)[] = [];
    let fire: ((s: PageSignal) => void) | null = null;
    const feed = createPageEvents({ requestAnimationFrame: fn => frames.push(fn), now: () => 0 }, [fn => ((fire = fn), () => {})]);
    const got: PageEvent[] = [];
    feed.watch(() => box, () => signalPage(), e => got.push(e));
    for (let i = 0; i < 12; i++) fire!({ kind: "goal-reached" });
    fire!({ kind: "enabled", from: card });
    frames.splice(0).forEach(f => f());
    frames.splice(0).forEach(f => f());
    expect(got.at(-1)).toEqual({ kind: "enabled", from: { x: 200, y: 150, w: 200, h: 200 } });
  });

  it("a keyboard command: its id, never held back by the cap", () => {
    expect(eventOf({ kind: "command", id: "kanbunny.showWays" }, signalPage(), box)).toEqual({ kind: "command", id: "kanbunny.showWays" });
    const frames: (() => void)[] = [];
    let fire: ((s: PageSignal) => void) | null = null;
    const feed = createPageEvents({ requestAnimationFrame: fn => frames.push(fn), now: () => 0 }, [fn => ((fire = fn), () => {})]);
    const got: PageEvent[] = [];
    feed.watch(() => box, () => signalPage(), e => got.push(e));
    for (let i = 0; i < 12; i++) fire!({ kind: "goal-reached" });
    fire!({ kind: "command", id: "kanbunny.showWays" });
    frames.splice(0).forEach(f => f());
    frames.splice(0).forEach(f => f());
    expect(got.at(-1)).toEqual({ kind: "command", id: "kanbunny.showWays" });
  });

  it("a search field that takes the focus is where the search is; the palette points at the app's search", () => {
    const field = el({}, { left: 300, top: 60, right: 500, bottom: 90 });
    expect(eventOf({ kind: "search", focused: true, field }, signalPage(), box)).toEqual({ kind: "search", focused: true, at: { x: 200, y: 10, w: 200, h: 30 } });
    expect(eventOf({ kind: "search", focused: false }, signalPage(), box)).toEqual({ kind: "search", focused: false, at: null });
  });

  it("measured two frames later (the page has drawn it), eight a second at most, sources only while watched", () => {
    const frames: (() => void)[] = [];
    let now = 0;
    let fire: ((s: PageSignal) => void) | null = null;
    const feed = createPageEvents({ requestAnimationFrame: fn => frames.push(fn), now: () => now }, [
      fn => {
        fire = fn;
        return () => (fire = null);
      },
    ]);
    const frame = () => frames.splice(0).forEach(fn => fn());
    expect(fire).toBeNull();
    const got: PageEvent[] = [];
    const off = feed.watch(() => box, () => signalPage(), e => got.push(e));
    for (let i = 0; i < 12; i++) fire!({ kind: "goal-reached" });
    frame();
    expect(got).toHaveLength(0);
    frame();
    expect(got).toHaveLength(EVENTS_PER_SECOND);
    now = 1500;
    fire!({ kind: "notification" });
    frame();
    frame();
    expect(got.at(-1)).toEqual({ kind: "notification", at: null });
    off();
    expect(fire).toBeNull();
  });
});
