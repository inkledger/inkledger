import { describe, expect, it } from "vitest";
import { LEDGES_CAP, LEDGES_MAX, ledgeCap, ledgesOf } from "./ledges";
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

  it("the cap grows with the box: 64 per 1280 × 800, 256 at most", () => {
    expect(ledgeCap({ width: 800, height: 600 })).toBe(LEDGES_MAX);
    expect(ledgeCap({ width: 2560, height: 1600 })).toBe(4 * LEDGES_MAX);
    expect(ledgeCap({ width: 5120, height: 3200 })).toBe(LEDGES_CAP);
  });

  it("past the cap, narrow trim goes before any card top, then what lies farthest from the middle band", () => {
    const view = { left: 0, top: 0, width: 1280, height: 800 };
    const wide = { surfaces: [] as Surface[], viewport: { w: 1280, h: 800 } };
    // 60 card tops (wide), 30 narrow trims in the middle band, 20 more cards near the bottom.
    for (let i = 0; i < 60; i++) wide.surfaces.push(top((i % 4) * 300, 200 + Math.floor(i / 4) * 26, 280));
    for (let i = 0; i < 30; i++) wide.surfaces.push(top(1240, 250 + i * 10, 50));
    for (let i = 0; i < 20; i++) wide.surfaces.push(top((i % 4) * 300, 700 + Math.floor(i / 4) * 20, 280));
    const got = ledgesOf(wide, view);
    expect(got.length).toBe(64);
    expect(got.filter(l => l.w === 50)).toEqual([]);
    // The cards kept: the middle band's 60, then the 4 nearest it.
    expect(got.filter(l => l.y >= 700).length).toBe(4);
    expect(Math.max(...got.map(l => l.y))).toBe(700);
  });
});
