import { describe, expect, it } from "vitest";
import { LEDGES_MAX, ledgesOf } from "./ledges";
import type { Surface } from "./info";

const top = (x: number, y: number, w: number, s = 0): Surface => ({ x, y, w, kind: "top", s });
const page = (surfaces: Surface[]) => ({ surfaces, viewport: { w: 1200, h: 800 } });
const box = { left: 200, top: 50, width: 1000, height: 2000 };

describe("page.ledges", () => {
  it("every top face in sight, in the box's px, top to bottom; undersides are no ledges", () => {
    expect(ledgesOf(page([top(600, 400, 400), top(240, 120, 320), { x: 240, y: 300, w: 320, kind: "bottom", s: 0 }]), box)).toEqual([
      { x: 40, y: 70, w: 320 },
      { x: 400, y: 350, w: 400 },
    ]);
  });

  it("leaves out faces above or below the window, or outside the box, and narrow ones; clips to the window and the box", () => {
    expect(ledgesOf(page([top(300, -20, 400), top(300, 820, 400), top(300, 100, 30), top(900, 300, 600), top(0, 200, 150), top(300, 30, 400)]), box)).toEqual([{ x: 700, y: 250, w: 300 }]);
  });

  it("faces touching at one height are one ledge; a gap keeps them two (the Board's columns)", () => {
    expect(ledgesOf(page([top(300, 100, 200), top(500, 100.4, 100), top(640, 100, 200)]), box)).toEqual([
      { x: 100, y: 50, w: 300 },
      { x: 440, y: 50, w: 200 },
    ]);
  });

  it("capped, the widest kept, however busy the page", () => {
    const many = Array.from({ length: 150 }, (_, i) => top(200 + (i % 10) * 100, 60 + Math.floor(i / 10) * 50, 60 + (i % 3)));
    const got = ledgesOf(page(many), box);
    expect(got.length).toBe(LEDGES_MAX);
    expect(got.every(l => l.w >= 61)).toBe(true);
  });
});
