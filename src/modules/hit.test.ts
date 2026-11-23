import { describe, expect, it } from "vitest";
import { createHitAreas } from "./hit";

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
