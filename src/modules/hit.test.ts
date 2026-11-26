import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAG_HOLD_MS, TOUCH_HOLD_MS, createHitAreas } from "./hit";
import type { HitDrag } from "./hostV2";

/** Just enough of a window: events on an EventTarget, an element under the point, the root's classes. */
function page(overlay = false, control = false) {
  const classes = new Set<string>();
  // Under the point: a dialog or menu (every closest() matches), a control marked above modules, or plain page.
  const under = overlay ? { closest: () => ({}) } : control ? { closest: (selector: string) => (selector.includes("data-above-modules") ? {} : null) } : { closest: () => null };
  const win = Object.assign(new EventTarget(), {
    document: {
      elementFromPoint: () => under,
      documentElement: {
        classList: {
          toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
          remove: (c: string) => classes.delete(c),
        },
      },
    },
  });
  // What the page under the module does with the events that reach it. Node's
  // EventTarget has no capture phase: the page listens after the host, as a
  // page's own handlers come after the host's capture listeners in a browser.
  const reached: string[] = [];
  const pageListens = () => {
    for (const type of ["pointerdown", "pointerup", "click"]) win.addEventListener(type, () => reached.push(type));
  };
  return { win: win as unknown as Window, reached, classes, pageListens, fire: (type: string, x: number, y: number, pointerType = "mouse") => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, pointerType })) };
}

/** A 100×100 box at (0, 0) whose shape is its left half. */
function box() {
  const attrs = new Map<string, string>();
  const keys = new EventTarget();
  return Object.assign(keys, {
    isConnected: true,
    tabIndex: -1,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    closest: () => null,
    contains: () => false,
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  }) as unknown as HTMLElement;
}
const leftHalf = (x: number) => x < 50;

describe("module hit areas", () => {
  it("takes a gesture that starts on the shape, and activates on its click", () => {
    const { win, reached, fire, pageListens } = page();
    let opened = 0;
    createHitAreas(win).add(box(), leftHalf, () => opened++);
    pageListens();
    fire("pointerdown", 20, 20);
    fire("pointerup", 20, 20);
    fire("click", 20, 20);
    expect(opened).toBe(1);
    expect(reached).toEqual([]);
  });

  it("leaves everything off the shape to the page (a gap under the tree)", () => {
    const { win, reached, fire, pageListens } = page();
    let opened = 0;
    createHitAreas(win).add(box(), leftHalf, () => opened++);
    pageListens();
    // In the box but off the shape, then outside the box.
    for (const x of [80, 300]) {
      fire("pointerdown", x, 20);
      fire("pointerup", x, 20);
      fire("click", x, 20);
    }
    expect(opened).toBe(0);
    expect(reached).toEqual(["pointerdown", "pointerup", "click", "pointerdown", "pointerup", "click"]);
  });

  it("over the whole window (a page overlay), any control of the app keeps its click; plain page does not", () => {
    const control = { closest: (s: string) => (s.includes("button") ? {} : null) };
    const plain = { closest: () => null };
    for (const [under, takes] of [[control, false], [plain, true]] as const) {
      const { win, fire } = page();
      (win.document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => under;
      let opened = 0;
      const b = Object.assign(box(), { closest: (s: string) => (s === "[data-page-overlay]" ? {} : null) });
      createHitAreas(win).add(b, leftHalf, () => opened++);
      fire("pointerdown", 20, 20);
      fire("pointerup", 20, 20);
      fire("click", 20, 20);
      expect(opened).toBe(takes ? 1 : 0);
    }
  });

  // The tree at the timeline's left end lay under the running timer's Pause and Stop: they could not be pressed (3 Nov).
  it("leaves a page control drawn over its shape to the page (Pause over the tree)", () => {
    const { win, reached, fire, pageListens } = page(false, true);
    let opened = 0;
    createHitAreas(win).add(box(), leftHalf, () => opened++);
    pageListens();
    fire("pointerdown", 20, 20);
    fire("pointerup", 20, 20);
    fire("click", 20, 20);
    expect(opened).toBe(0);
    expect(reached).toEqual(["pointerdown", "pointerup", "click"]);
  });

  // The bunny standing on the Dashboard's sticky header was drawn over it but could not be clicked (26 Nov).
  it("marked above modules inside the page's layer (its header): above in-page modules only, under a page overlay", () => {
    // The header's plain surface, in the page's layer; a banner outside it; a button in the header.
    const header = { closest: (s: string) => (s.includes("data-above-modules") || s.includes("data-page-layer") ? {} : null) };
    const banner = { closest: (s: string) => (s.includes("data-above-modules") ? {} : null) };
    const button = { closest: (s: string) => (s.includes("data-above-modules") || s.includes("data-page-layer") || s.includes("button") ? {} : null) };
    const overlay = (s: string) => (s === "[data-page-overlay]" ? {} : null);
    const inPage = (s: string) => (s === "[data-page-layer]" ? {} : null);
    // The panel's edge strip: no rule for controls there, the marks keep their points.
    const edge = () => null;
    const cases = [
      [header, overlay, true],
      [header, edge, false],
      [header, inPage, false],
      [banner, overlay, false],
      [button, overlay, false],
    ] as const;
    for (const [under, where, takes] of cases) {
      const { win, fire } = page();
      (win.document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => under;
      let opened = 0;
      createHitAreas(win).add(Object.assign(box(), { closest: where }), leftHalf, () => opened++);
      fire("pointerdown", 20, 20);
      fire("pointerup", 20, 20);
      fire("click", 20, 20);
      expect(opened).toBe(takes ? 1 : 0);
    }
  });

  // The bunny drawn over a dialog's backdrop took the click meant to close the search (23 Nov).
  it("a page overlay never takes a point on a dialog's backdrop", () => {
    const { win, fire } = page();
    (win.document as unknown as { elementFromPoint: () => unknown }).elementFromPoint = () => ({ closest: (s: string) => (s.includes("dialog-overlay") ? {} : null) });
    let opened = 0;
    const b = Object.assign(box(), { closest: (s: string) => (s === "[data-page-overlay]" ? {} : null) });
    createHitAreas(win).add(b, leftHalf, () => opened++);
    fire("pointerdown", 20, 20);
    fire("click", 20, 20);
    expect(opened).toBe(0);
  });

  it("never takes a point under a dialog or a menu opened over the page", () => {
    const { win, reached, fire, pageListens } = page(true);
    let opened = 0;
    createHitAreas(win).add(box(), leftHalf, () => opened++);
    pageListens();
    fire("pointerdown", 20, 20);
    fire("click", 20, 20);
    expect(opened).toBe(0);
    expect(reached).toEqual(["pointerdown", "click"]);
  });

  it("shows the pointer cursor over the shape only, and stops listening once undone", () => {
    const { win, reached, classes, fire, pageListens } = page();
    const undo = createHitAreas(win).add(box(), leftHalf, () => {});
    pageListens();
    fire("pointermove", 20, 20);
    expect(classes.has("ikl-hit-cursor")).toBe(true);
    fire("pointermove", 80, 20);
    expect(classes.has("ikl-hit-cursor")).toBe(false);
    fire("pointermove", 20, 20);
    undo();
    expect(classes.has("ikl-hit-cursor")).toBe(false);
    fire("pointerdown", 20, 20);
    expect(reached).toEqual(["pointerdown"]);
  });

  it("makes the element focusable: Enter activates", () => {
    const { win } = page();
    const el = box();
    let opened = 0;
    createHitAreas(win).add(el, leftHalf, () => opened++);
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute("role")).toBe("button");
    el.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Enter" }));
    expect(opened).toBe(1);
  });

  it("a framed module's area adds no Tab stop unless asked; asked, it is a button with the module's name", () => {
    const { win } = page();
    const areas = createHitAreas(win);
    const el = box();
    const quiet = areas.add(el, leftHalf, () => {}, { focusable: false, label: "Ignored" });
    expect([el.getAttribute("role"), el.getAttribute("aria-label")]).toEqual([null, null]);
    expect(el.tabIndex).toBe(-1);
    quiet();
    const named = areas.add(el, leftHalf, () => {}, { focusable: true, label: "Kanbunny" });
    expect([el.tabIndex, el.getAttribute("role"), el.getAttribute("aria-label")]).toEqual([0, "button", "Kanbunny"]);
    named();
    expect([el.getAttribute("role"), el.getAttribute("aria-label"), el.getAttribute("tabindex")]).toEqual([null, null, null]);
  });

  it("tells how it was activated: where a click fell in the box, or the keyboard", () => {
    const { win, fire } = page();
    const how: unknown[] = [];
    const el = box();
    createHitAreas(win).add(el, leftHalf, h => how.push(h), { focusable: true });
    fire("pointerdown", 20, 30);
    fire("click", 20, 30);
    el.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
    expect(how).toEqual([{ via: "pointer", x: 20, y: 30 }, { via: "keyboard" }]);
  });

  it("where two modules' shapes overlap, the older keeps its clicks, even after the newer sets its shape again", () => {
    const { win, fire } = page();
    const areas = createHitAreas(win);
    const opened: string[] = [];
    const older = box();
    const newer = box();
    areas.add(older, leftHalf, () => opened.push("older"));
    let undo = areas.add(newer, leftHalf, () => opened.push("newer"));
    fire("pointerdown", 20, 20);
    fire("click", 20, 20);
    undo();
    undo = areas.add(newer, leftHalf, () => opened.push("newer"));
    fire("pointerdown", 20, 20);
    fire("click", 20, 20);
    expect(opened).toEqual(["older", "older"]);
    // Its own shape alone is still its.
    undo();
    areas.add(newer, () => true, () => opened.push("newer"));
    fire("pointerdown", 80, 20);
    fire("click", 80, 20);
    expect(opened).toEqual(["older", "older", "newer"]);
  });

  it("a box in the page's main region never takes a point where the app's chrome outside it lies (the phone's header, the tab bar)", () => {
    const { win, reached, fire, pageListens } = page();
    const el = Object.assign(box(), { closest: (s: string) => (s === "main" ? { contains: () => false } : null) });
    let opened = 0;
    createHitAreas(win).add(el, leftHalf, () => opened++);
    pageListens();
    fire("pointerdown", 20, 20);
    fire("click", 20, 20);
    expect(opened).toBe(0);
    expect(reached).toEqual(["pointerdown", "click"]);
  });

  it("forwards its box taking and losing the focus, until undone", () => {
    const { win } = page();
    const heard: [boolean, boolean][] = [];
    const el = box();
    const undo = createHitAreas(win).add(el, leftHalf, () => {}, { focusable: true, onFocus: (f, v) => heard.push([f, v]) });
    el.dispatchEvent(new Event("focus"));
    el.dispatchEvent(new Event("blur"));
    undo();
    el.dispatchEvent(new Event("focus"));
    expect(heard).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});

describe("carrying a module's shape (drag)", () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    const p = page();
    const got: HitDrag[] = [];
    let opened = 0;
    let layers = 0;
    let released = 0;
    const hits = createHitAreas(p.win, { layer: () => (layers++, () => released++), frame: fn => fn() });
    hits.add(box(), leftHalf, () => opened++, { focusable: false }, d => got.push(d));
    p.pageListens();
    const key = (k: string) => p.win.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: k }));
    return { ...p, got, key, opened: () => opened, layers: () => layers, released: () => released };
  };

  it("a plain click still activates; nothing is carried", () => {
    vi.useFakeTimers();
    const s = setup();
    s.fire("pointerdown", 20, 20);
    s.fire("pointerup", 22, 21);
    s.fire("click", 22, 21);
    vi.advanceTimersByTime(1000);
    expect(s.opened()).toBe(1);
    expect(s.got).toEqual([]);
    expect(s.layers()).toBe(0);
  });

  it("a press that moves past a few px picks it up: it follows the pointer anywhere, the page hears nothing, its click is no click", () => {
    vi.useFakeTimers();
    const s = setup();
    s.fire("pointerdown", 20, 20);
    s.fire("pointermove", 24, 20);
    expect(s.got).toEqual([]);
    s.fire("pointermove", 30, 20);
    expect(s.got).toEqual([{ phase: "start", x: 20, y: 20 }]);
    expect(s.layers()).toBe(1);
    // Far past its box: still its.
    s.fire("pointermove", 400, 300);
    s.fire("pointerup", 400, 300);
    s.fire("click", 400, 300);
    expect(s.got.map(d => d.phase)).toEqual(["start", "move", "end"]);
    expect(s.got[1]).toEqual({ phase: "move", x: 400, y: 300 });
    expect(s.got[2]).toMatchObject({ phase: "end", x: 400, y: 300 });
    expect(s.opened()).toBe(0);
    expect(s.reached).toEqual([]);
    expect(s.released()).toBe(1);
  });

  it("held still a moment it is picked up (a mouse); a finger needs longer, and a swipe before that scrolls the page", () => {
    vi.useFakeTimers();
    const s = setup();
    s.fire("pointerdown", 20, 20);
    vi.advanceTimersByTime(DRAG_HOLD_MS);
    expect(s.got).toEqual([{ phase: "start", x: 20, y: 20 }]);
    s.fire("pointerup", 20, 20);
    const t = setup();
    t.fire("pointerdown", 20, 20, "touch");
    vi.advanceTimersByTime(DRAG_HOLD_MS);
    expect(t.got).toEqual([]);
    vi.advanceTimersByTime(TOUCH_HOLD_MS - DRAG_HOLD_MS);
    expect(t.got).toEqual([{ phase: "start", x: 20, y: 20 }]);
    const u = setup();
    u.fire("pointerdown", 20, 20, "touch");
    u.fire("pointermove", 20, 60, "touch");
    vi.advanceTimersByTime(TOUCH_HOLD_MS * 2);
    expect(u.got).toEqual([]);
    u.fire("pointercancel", 20, 60, "touch");
    expect(u.layers()).toBe(0);
  });

  it("Esc lets it go where it is, with no speed", () => {
    vi.useFakeTimers();
    const s = setup();
    s.fire("pointerdown", 20, 20);
    s.fire("pointermove", 80, 20);
    s.fire("pointermove", 200, 20);
    s.key("Escape");
    expect(s.got.at(-1)).toEqual({ phase: "end", x: 200, y: 20, vx: 0, vy: 0 });
    expect(s.released()).toBe(1);
  });

  it("let go with the pointer's speed over its last moves", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const s = setup();
    s.fire("pointerdown", 20, 20);
    s.fire("pointermove", 30, 20);
    vi.advanceTimersByTime(50);
    s.fire("pointermove", 130, 70);
    s.fire("pointerup", 130, 70);
    expect(s.got.at(-1)).toEqual({ phase: "end", x: 130, y: 70, vx: 2200, vy: 1000 });
  });

  it("a shape that never asked to be carried: a press that moves is still a click", () => {
    vi.useFakeTimers();
    const p = page();
    let opened = 0;
    createHitAreas(p.win, { layer: () => () => {}, frame: fn => fn() }).add(box(), leftHalf, () => opened++, { focusable: false });
    p.fire("pointerdown", 20, 20);
    p.fire("pointermove", 40, 20);
    vi.advanceTimersByTime(1000);
    p.fire("pointerup", 40, 20);
    p.fire("click", 40, 20);
    expect(opened).toBe(1);
  });
});
