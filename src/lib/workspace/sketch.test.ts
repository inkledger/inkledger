import { describe, expect, it } from "vitest";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import type { ResolvedPlacement, Scope } from "@contracts/workspace/model";
import { applyLocally, blocksIn, insertionIndex, sketchFor } from "./sketch";

const scopes: Scope[] = [
  { surfaceId: "dashboard", deviceClass: "desktop" },
  { surfaceId: "dashboard", deviceClass: "mobile" },
  { surfaceId: "shell-desktop", deviceClass: "desktop" },
  { surfaceId: "mobile-tabs", deviceClass: "mobile" },
];

const dashboard = (): ResolvedPlacement[] => productDefaultFor(PRODUCT_DEFAULTS_V1, "dashboard").placements.map(placement => ({ ...placement, origin: "product" as const }));

describe("page sketches", () => {
  it("draw every area of every editable page, each once", () => {
    for (const scope of scopes) {
      const sketch = sketchFor(scope);
      expect(sketch, `${scope.surfaceId}:${scope.deviceClass}`).not.toBeNull();
      const drawn = sketch!.areas.map(area => area.areaId).sort();
      expect(drawn).toEqual(CATALOG_V1.areas.filter(area => area.surfaceId === scope.surfaceId).map(area => area.id).sort());
    }
  });
});

describe("where a dragged block lands", () => {
  const column = [{ left: 0, top: 0, width: 100, height: 40 }, { left: 0, top: 50, width: 100, height: 40 }];
  it("goes before the first block whose middle is below the pointer in a column", () => {
    expect(insertionIndex(column, { x: 10, y: 5 }, "column")).toBe(0);
    expect(insertionIndex(column, { x: 10, y: 30 }, "column")).toBe(1);
    expect(insertionIndex(column, { x: 10, y: 99 }, "column")).toBe(2);
  });
  it("reads a row left to right, and tiles (or a wrapped row) by line then along it", () => {
    const row = [{ left: 0, top: 0, width: 40, height: 20 }, { left: 50, top: 0, width: 40, height: 20 }];
    expect(insertionIndex(row, { x: 45, y: 10 }, "row")).toBe(1);
    // A row wrapped on a phone: the second line's first block comes after the whole first line.
    const wrapped = [...row, { left: 0, top: 30, width: 40, height: 20 }, { left: 50, top: 30, width: 40, height: 20 }];
    expect(insertionIndex(wrapped, { x: 52, y: 40 }, "row")).toBe(3);
    const tiles = [{ left: 0, top: 0, width: 40, height: 20 }, { left: 50, top: 0, width: 40, height: 20 }, { left: 0, top: 30, width: 40, height: 20 }];
    expect(insertionIndex(tiles, { x: 80, y: 10 }, "tiles")).toBe(2);
    expect(insertionIndex(tiles, { x: 5, y: 35 }, "tiles")).toBe(2);
    expect(insertionIndex(tiles, { x: 35, y: 40 }, "tiles")).toBe(3);
  });
});

describe("the change drawn before the server answers", () => {
  it("reorders within an area and renumbers it", () => {
    const next = applyLocally(dashboard(), { kind: "place", anchorId: "dashboard.recap", areaId: "dashboard.primary", index: 0 });
    expect(blocksIn(next, "dashboard.primary").map(placement => [placement.anchorId, placement.order])).toEqual([
      ["dashboard.recap", 0], ["dashboard.timeline", 1], ["dashboard.summary", 2], ["dashboard.tasks", 3], ["dashboard.activity", 4],
    ]);
  });
  it("moves into another area and closes the gap it left", () => {
    const next = applyLocally(dashboard(), { kind: "place", anchorId: "dashboard.timeline", areaId: "dashboard.secondary", index: 1 });
    expect(blocksIn(next, "dashboard.secondary").map(placement => placement.anchorId)).toEqual(["dashboard.stats", "dashboard.timeline"]);
    expect(blocksIn(next, "dashboard.primary").map(placement => placement.order)).toEqual([0, 1, 2, 3]);
  });
  it("shows, hides, pins and resizes a block in place", () => {
    const hidden = applyLocally(dashboard(), { kind: "visible", anchorId: "dashboard.stats", visible: false });
    expect(hidden.find(placement => placement.anchorId === "dashboard.stats")).toMatchObject({ visible: false, areaId: "dashboard.secondary", order: 0 });
    expect(applyLocally(hidden, { kind: "variant", anchorId: "dashboard.stats", variant: "compact" }).find(placement => placement.anchorId === "dashboard.stats")?.variant).toBe("compact");
    expect(applyLocally(hidden, { kind: "pinned", anchorId: "dashboard.stats", pinned: true }).find(placement => placement.anchorId === "dashboard.stats")?.pinned).toBe(true);
  });
});
