import { describe, expect, it } from "vitest";
import { createGestures, GESTURE_MS } from "./gesture";

function setup() {
  let t = 10_000;
  let active = true;
  const g = createGestures({ now: () => t, active: () => active });
  const frame = { name: "the module's view frame" };
  const box = { name: "its host box" };
  const other = { name: "another module's frame" };
  return { g, frame, box, other, tick: (ms: number) => (t += ms), setActive: (on: boolean) => (active = on) };
}

describe("whose gesture it was", () => {
  it("never a click anywhere on the app", () => {
    const { g, frame, box } = setup();
    g.app();
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("a click on the module's own host box, for a while, until the person acts elsewhere", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    g.box(box);
    expect(g.has(frame, box, false)).toBe(true);
    tick(GESTURE_MS + 1);
    expect(g.has(frame, box, false)).toBe(false);
    g.box(box);
    tick(10);
    g.app();
    expect(g.has(frame, box, false)).toBe(false);
    // Another module's box is an act elsewhere too.
    g.box(box);
    tick(10);
    g.box({});
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("a pointer down in the module's own frame, as its bootstrap saw it; another frame's is not this one's", () => {
    const { g, frame, box, other, tick } = setup();
    g.app();
    tick(10);
    g.own(other, "pointer");
    expect(g.has(frame, box, false)).toBe(false);
    g.own(frame, "pointer");
    expect(g.has(frame, box, false)).toBe(true);
    tick(10);
    g.app();
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("a frame that takes the focus by itself gets nothing from the keys typed into it", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    tick(10);
    g.focusIn(frame);
    g.own(frame, "key");
    expect(g.has(frame, box, true)).toBe(false);
  });

  it("the keyboard: a key in a frame the person moved into by Tab, while it keeps the focus", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    g.tab();
    tick(5);
    g.focusIn(frame);
    tick(2000);
    g.own(frame, "key");
    expect(g.has(frame, box, true)).toBe(true);
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("only while the browser still counts the person's activation", () => {
    const { g, frame, box, setActive } = setup();
    g.box(box);
    g.own(frame, "pointer");
    setActive(false);
    expect(g.has(frame, box, true)).toBe(false);
  });
});
