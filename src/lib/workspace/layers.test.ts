import { describe, expect, it } from "vitest";
import { blockUse, DEFAULT_VIEW, formatLayerView, frictionByAnchor, layerStates, parseLayerView, pathsAround, pathsOf, shownLayers, toggleLayer } from "./layers";

const anchorOf = (controlId: string) => ({ "a.one": "A", "a.two": "A", "b.one": "B", "c.one": "C", "x.far": "X" } as Record<string, string>)[controlId];
const onPage = (anchorId: string) => anchorId !== "X";

describe("layer view setting", () => {
  it("falls back to the default on nothing, junk or unknown layers", () => {
    expect(parseLayerView(null)).toEqual(DEFAULT_VIEW);
    expect(parseLayerView("{not json")).toEqual(DEFAULT_VIEW);
    expect(parseLayerView(JSON.stringify({ layers: ["use", "bogus"], periods: { "dashboard:desktop": "e1", bad: 3 } }))).toEqual({ layers: ["use"], periods: { "dashboard:desktop": "e1" } });
  });

  it("round-trips and toggles one layer at a time, in a stable order", () => {
    const view = toggleLayer(toggleLayer(DEFAULT_VIEW, "paths"), "use");
    expect(view.layers).toEqual(["edit", "use", "paths", "news"]);
    expect(parseLayerView(formatLayerView(view))).toEqual(view);
    expect(toggleLayer(view, "edit").layers).toEqual(["use", "paths", "news"]);
  });
});

describe("layerStates", () => {
  it("disables the data layers with collection off, saying why", () => {
    const states = layerStates({ collecting: false, hasUse: true, hasPaths: true, hasFriction: true, news: 0 });
    expect(states.use).toEqual({ available: false, reason: "collectionOff" });
    expect(states.paths.reason).toBe("collectionOff");
    expect(states.edit).toEqual({ available: true, reason: null });
    expect(states.news).toEqual({ available: false, reason: "nothingNew" });
  });

  it("keeps a data layer off when its period has nothing to draw", () => {
    const states = layerStates({ collecting: true, hasUse: true, hasPaths: false, hasFriction: false, news: 2 });
    expect(states.use.available).toBe(true);
    expect(states.paths).toEqual({ available: false, reason: "noData" });
    expect(states.friction.reason).toBe("noData");
    expect(states.news.available).toBe(true);
  });

  it("shows only the chosen layers that can be drawn", () => {
    const states = layerStates({ collecting: true, hasUse: false, hasPaths: true, hasFriction: false, news: 0 });
    expect([...shownLayers(["edit", "use", "paths", "news"], states)]).toEqual(["edit", "paths"]);
  });
});

describe("pathsOf", () => {
  const flows = [
    { fromControlId: "a.one", toControlId: "b.one", count: 4 },
    { fromControlId: "a.two", toControlId: "b.one", count: 3 },
    { fromControlId: "b.one", toControlId: "c.one", count: 5 },
    { fromControlId: "a.one", toControlId: "a.two", count: 9 },
    { fromControlId: "c.one", toControlId: "x.far", count: 2 },
    { fromControlId: "x.far", toControlId: "a.one", count: 8 },
    { fromControlId: "unknown", toControlId: "a.one", count: 8 },
  ];

  it("adds up a block's controls, skips moves inside one block and starts only on this page", () => {
    expect(pathsOf(flows, anchorOf, onPage)).toEqual([
      { from: "A", to: "B", toControlId: "b.one", count: 7 },
      { from: "B", to: "C", toControlId: "c.one", count: 5 },
      { from: "C", to: null, toControlId: "x.far", count: 2 },
    ]);
  });

  it("keeps the busiest ones only", () => {
    expect(pathsOf(flows, anchorOf, onPage, 1).map(path => path.from)).toEqual(["A"]);
  });

  it("splits a block's paths into where it leads and where it is reached from", () => {
    const around = pathsAround(pathsOf(flows, anchorOf, onPage), "B");
    expect(around.out).toEqual([{ from: "B", to: "C", toControlId: "c.one", count: 5 }]);
    expect(around.in).toEqual([{ from: "A", to: "B", toControlId: "b.one", count: 7 }]);
  });
});

describe("frictionByAnchor", () => {
  it("adds up a block's trouble and leaves untroubled blocks out", () => {
    const friction = frictionByAnchor([
      { controlId: "a.one", abandoned: 1, failures: 2, backtracks: 0, loops: 0 },
      { controlId: "a.two", abandoned: 0, failures: 0, backtracks: 3, loops: 1 },
      { controlId: "b.one", abandoned: 0, failures: 0, backtracks: 0, loops: 0 },
    ], anchorOf);
    expect([...friction]).toEqual([["A", { abandoned: 1, failures: 2, backtracks: 3, loops: 1, total: 7 }]]);
  });
});

describe("blockUse", () => {
  it("counts clicks and how, and how often the block was seen", () => {
    const point = (controlId: string, activations: number, exposures: number, keyboard: number) => ({ controlId, anchorId: "A", semanticRevision: 1, activations, successes: 0, failures: 0, exposures, activationRate: 0, modalities: { pointer: activations - keyboard, touch: 0, keyboard, unknown: 0 }, cells: [] });
    expect(blockUse([point("a.one", 10, 30, 4), point("a.two", 2, 12, 0)], "A")).toEqual({ clicks: 12, seen: 30, modalities: { pointer: 8, touch: 0, keyboard: 4, unknown: 0 } });
    expect(blockUse([], "A")).toEqual({ clicks: 0, seen: 0, modalities: { pointer: 0, touch: 0, keyboard: 0, unknown: 0 } });
  });
});
