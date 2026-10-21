import { describe, expect, it } from "vitest";
import { createHitAreas } from "./hit";

/** Just enough of a window: events on an EventTarget, an element under the point, the root's classes. */
function page(overlay = false) {
  const classes = new Set<string>();
  const win = Object.assign(new EventTarget(), {
    document: {
      elementFromPoint: () => (overlay ? { closest: () => ({}) } : { closest: () => null }),
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
});
