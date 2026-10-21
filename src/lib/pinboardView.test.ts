import { describe, it, expect } from "vitest";
import { centreOn, notesBounds, offscreenByEdge } from "./pinboardView";

const view = { left: 200, top: 100, width: 400, height: 300 }; // x 200–600, y 100–400

describe("offscreenByEdge", () => {
  it("counts notes beyond each edge, keeps the nearest, ignores partly visible ones", () => {
    const notes = [
      { id: "in", x: 300, y: 200 },
      { id: "partly", x: 560, y: 380 }, // overlaps the corner
      { id: "r1", x: 700, y: 200 },
      { id: "r2", x: 1200, y: 150 },
      { id: "l", x: 0, y: 200 },
      { id: "d", x: 300, y: 900 },
      { id: "u", x: 300, y: -500 },
    ];
    const r = offscreenByEdge(notes, view);
    expect(r.right.count).toBe(2);
    expect(r.right.nearest?.id).toBe("r1");
    expect(r.left.count).toBe(1);
    expect(r.down.count).toBe(1);
    expect(r.up.count).toBe(1);
  });

  it("a diagonal note goes to the side it is farthest past", () => {
    const r = offscreenByEdge([{ x: 1400, y: 450 }], view); // far right, a bit below
    expect(r.right.count).toBe(1);
    expect(r.down.count).toBe(0);
  });
});

describe("framing", () => {
  it("centres a note and frames them all", () => {
    expect(centreOn({ x: 1000, y: 800 }, { width: 400, height: 300 })).toEqual({ x: 884, y: 734 });
    expect(centreOn({ x: 10, y: 10 }, { width: 400, height: 300 })).toEqual({ x: 0, y: 0 });
    expect(notesBounds([{ x: 100, y: 50 }, { x: 400, y: 300 }])).toEqual({ left: 100, top: 50, width: 468, height: 418 });
    expect(notesBounds([])).toBeNull();
  });
});
