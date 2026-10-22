import { describe, expect, it } from "vitest";
import { fitFloat } from "./pinboardFloat";

describe("the floating pinboard's place", () => {
  it("starts on the right, under the header", () => {
    expect(fitFloat(null, 1600, 1000)).toEqual({ x: 676, y: 72, w: 900, h: 640 });
  });

  it("stays inside the window and never below its minimum size", () => {
    expect(fitFloat({ x: -300, y: 5000, w: 100, h: 50 }, 1600, 1000)).toEqual({ x: 8, y: 672, w: 420, h: 320 });
    expect(fitFloat({ x: 1500, y: 10, w: 3000, h: 3000 }, 1600, 1000)).toEqual({ x: 8, y: 8, w: 1584, h: 984 });
  });

  it("follows a window made smaller: moved back in, then shrunk", () => {
    const wide = { x: 1000, y: 300, w: 560, h: 600 };
    expect(fitFloat(wide, 1200, 800)).toEqual({ x: 632, y: 192, w: 560, h: 600 });
    expect(fitFloat(wide, 400, 300)).toEqual({ x: 8, y: 8, w: 384, h: 284 });
  });
});
