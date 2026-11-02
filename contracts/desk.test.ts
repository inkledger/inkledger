import { describe, expect, it } from "vitest";
import {
  DESK_MAX_PANES,
  DESK_MAX_PARKED,
  MIN_TRACK,
  PRESET_IDS,
  PRESETS,
  addPane,
  applySnap,
  defaultPreset,
  defaultTracks,
  dividersOf,
  dropIssue,
  edgeTarget,
  emptyDesk,
  fitPreset,
  isEmptySlot,
  maximize,
  minTrackOf,
  moveTargets,
  normalizeDesk,
  openTogether,
  pagePresets,
  park,
  paneId,
  placeIssue,
  presetsFor,
  removePane,
  sameTarget,
  resizeDivider,
  resizeTracks,
  setPreset,
  sideBySide,
  slotRects,
  snapTargets,
  tracksOf,
  unpark,
  zoneAt,
  type DeskLayout,
  type DeskPane,
} from "./desk";

const pane = (key: string, connectionId = 1): DeskPane => ({ connectionId, key, remoteId: null });
/** The desk's slots in order: each issue's key, "_" for an empty slot. */
const shape = (desk: DeskLayout) => desk.panes.map(item => (isEmptySlot(item) ? "_" : item.key));
const keys = shape;
const deskWith = (...names: string[]) => names.reduce((desk, name) => addPane(desk, pane(name)), emptyDesk());

describe("the arrangements", () => {
  it.each(PRESET_IDS)("%s covers the desk exactly once, whatever the sizes", id => {
    for (const tracks of [defaultTracks(id), { cols: defaultTracks(id).cols.map((_, i, all) => (i === 0 ? 0.6 : 0.4 / (all.length - 1 || 1))), rows: defaultTracks(id).rows.map((_, i, all) => (i === 0 ? 0.3 : 0.7 / (all.length - 1 || 1))) }]) {
      if (tracks.cols.length === 1) tracks.cols = [1];
      if (tracks.rows.length === 1) tracks.rows = [1];
      const rects = slotRects(id, tracks);
      expect(rects).toHaveLength(PRESETS[id].slots);
      expect(rects.reduce((sum, rect) => sum + rect.w * rect.h, 0)).toBeCloseTo(1);
      for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1)) {
        const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(overlap).toBeCloseTo(0);
      }
    }
  });

  it("offers each count its own arrangements, the default first among them", () => {
    expect(presetsFor(2)).toEqual(["cols-2", "rows-2"]);
    expect(presetsFor(3)).toEqual(["cols-3", "rows-3", "main-left", "main-right", "main-top", "main-bottom"]);
    expect(presetsFor(4)).toEqual(["cols-4", "rows-4", "quad", "main-left-3", "main-right-3", "main-top-3", "main-bottom-3"]);
    expect(presetsFor(5)).toEqual(["main-left-4", "main-right-4", "top-3-bottom-2", "top-2-bottom-3"]);
    expect(presetsFor(6)).toEqual(["grid-3x2", "grid-2x3"]);
    expect(presetsFor(7)).toEqual([]);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(presetsFor(n)).toContain(defaultPreset(n));
    expect(defaultPreset(5)).toBe("main-left-4");
    expect(defaultPreset(6)).toBe("grid-3x2");
    expect(defaultPreset(9)).toBe("grid-3x2");
  });

  it("draws the new arrangements where their names say", () => {
    const round = (id: (typeof PRESET_IDS)[number]) => slotRects(id).map(r => [r.x, r.y, r.w, r.h].map(v => Math.round(v * 1000) / 1000));
    expect(round("rows-3")).toEqual([[0, 0, 1, 0.333], [0, 0.333, 1, 0.333], [0, 0.667, 1, 0.333]]);
    // One big on the left, three stacked on the right.
    expect(round("main-left-3")).toEqual([[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.333], [0.5, 0.333, 0.5, 0.333], [0.5, 0.667, 0.5, 0.333]]);
    expect(round("main-top-3")[0]).toEqual([0, 0, 1, 0.5]);
    // Big on the left, a 2×2 beside it.
    expect(round("main-left-4")).toEqual([[0, 0, 0.333, 1], [0.333, 0, 0.333, 0.5], [0.667, 0, 0.333, 0.5], [0.333, 0.5, 0.333, 0.5], [0.667, 0.5, 0.333, 0.5]]);
    expect(round("main-right-4")[0]).toEqual([0.667, 0, 0.333, 1]);
    // Two rows of different counts: cells span the six columns.
    expect(round("top-3-bottom-2")).toEqual([[0, 0, 0.333, 0.5], [0.333, 0, 0.333, 0.5], [0.667, 0, 0.333, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
    expect(round("top-2-bottom-3").map(r => r[2])).toEqual([0.5, 0.5, 0.333, 0.333, 0.333]);
    expect(round("grid-3x2")).toHaveLength(6);
    expect(round("grid-2x3").map(r => r[3])).toEqual(Array(6).fill(0.333));
  });

  it("draws a line only where it separates two panes", () => {
    expect(dividersOf("single")).toEqual([]);
    expect(dividersOf("cols-3")).toEqual([{ axis: "cols", index: 0, from: 0, to: 1 }, { axis: "cols", index: 1, from: 0, to: 1 }]);
    // One big on the left: the column line runs the whole height, the row line only on the right.
    expect(dividersOf("main-left")).toEqual([{ axis: "cols", index: 0, from: 0, to: 2 }, { axis: "rows", index: 0, from: 1, to: 2 }]);
    expect(dividersOf("quad")).toHaveLength(2);
    // Three above two: a line between each two on top, one between the two below, one across.
    expect(dividersOf("top-3-bottom-2")).toEqual([
      { axis: "cols", index: 1, from: 0, to: 1 },
      { axis: "cols", index: 2, from: 1, to: 2 },
      { axis: "cols", index: 3, from: 0, to: 1 },
      { axis: "rows", index: 0, from: 0, to: 6 },
    ]);
    expect(dividersOf("main-left-4")).toEqual([
      { axis: "cols", index: 0, from: 0, to: 2 },
      { axis: "cols", index: 1, from: 0, to: 2 },
      { axis: "rows", index: 0, from: 1, to: 3 },
    ]);
    expect(dividersOf("grid-3x2")).toHaveLength(3);
  });
});

describe("sizes", () => {
  it("moves a line within its two tracks, never under the minimum", () => {
    const moved = resizeTracks([0.5, 0.5], 0, 0.1);
    expect(moved[0]).toBeCloseTo(0.6);
    expect(moved[1]).toBeCloseTo(0.4);
    const pinned = resizeTracks([0.5, 0.5], 0, 0.9);
    expect(pinned[0]).toBeCloseTo(1 - MIN_TRACK);
    expect(pinned[1]).toBeCloseTo(MIN_TRACK);
    const three = resizeTracks([0.3, 0.3, 0.4], 1, -0.5);
    expect(three[0]).toBe(0.3);
    expect(three[1]).toBe(MIN_TRACK);
    expect(three.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("keeps the sizes of each arrangement apart, so going back to one finds its sizes", () => {
    let desk = deskWith("A", "B");
    desk = resizeDivider(desk, "cols", 0, 0.2);
    desk = setPreset(desk, "rows-2");
    expect(tracksOf(desk).cols).toEqual([1]);
    desk = setPreset(desk, "cols-2");
    expect(tracksOf(desk).cols[0]).toBeCloseTo(0.7);
  });

  it("resizes the new arrangements, every pane kept at least the minimum share", () => {
    let desk = setPreset(deskWith("A", "B", "C", "D", "E"), "top-3-bottom-2");
    // Spanning cells: a column may be half the minimum, since each pane covers two or more.
    expect(minTrackOf("top-3-bottom-2", "cols")).toBeCloseTo(MIN_TRACK / 2);
    expect(minTrackOf("top-3-bottom-2", "rows")).toBe(MIN_TRACK);
    expect(minTrackOf("quad", "cols")).toBe(MIN_TRACK);
    // The line between the two below moves them, the three on top stay.
    const top = slotRects("top-3-bottom-2").slice(0, 3);
    desk = resizeDivider(desk, "cols", 2, 0.05);
    let rects = slotRects(desk.preset, tracksOf(desk));
    expect(rects[3].w).toBeCloseTo(0.55);
    expect(rects[4].w).toBeCloseTo(0.45);
    for (const [i, rect] of top.entries()) expect(rects[i].w).toBeCloseTo(rect.w);
    // Pushed past the end: each pane still has at least the minimum.
    for (const [index, delta] of [[1, -1], [3, 1], [2, 1], [0, 1], [4, -1]] as const) desk = resizeDivider(desk, "cols", index, delta);
    rects = slotRects(desk.preset, tracksOf(desk));
    for (const rect of rects) expect(rect.w).toBeGreaterThanOrEqual(MIN_TRACK - 1e-9);
    expect(tracksOf(desk).cols.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    let grid = setPreset(deskWith("A", "B", "C", "D", "E", "F"), "grid-2x3");
    grid = resizeDivider(grid, "rows", 1, 0.1);
    expect(tracksOf(grid).rows.map(share => Math.round(share * 1000) / 1000)).toEqual([0.333, 0.433, 0.233]);
    const big = resizeDivider(setPreset(deskWith("A", "B", "C", "D"), "main-left-3"), "cols", 0, 0.2);
    expect(slotRects(big.preset, tracksOf(big))[0].w).toBeCloseTo(0.7);
  });
});

describe("panes", () => {
  it("opens an issue once, picking the arrangement for the new count", () => {
    let desk = deskWith("A", "B");
    expect(desk.preset).toBe("cols-2");
    desk = addPane(desk, pane("A"));
    expect(keys(desk)).toEqual(["A", "B"]);
    desk = addPane(desk, pane("C"));
    expect(desk.preset).toBe("main-left");
    desk = setPreset(desk, "cols-3");
    desk = removePane(desk, paneId(pane("B")));
    expect(desk.preset).toBe("cols-2");
  });

  it("tells the same key on two connections apart", () => {
    const desk = addPane(addPane(emptyDesk(), pane("A", 1)), pane("A", 2));
    expect(desk.panes).toHaveLength(2);
  });

  it("takes a fifth and a sixth issue, each in the default arrangement for the count", () => {
    expect(DESK_MAX_PANES).toBe(6);
    let desk = deskWith("A", "B", "C", "D");
    expect(desk.preset).toBe("quad");
    desk = addPane(desk, pane("E"));
    expect(keys(desk)).toEqual(["A", "B", "C", "D", "E"]);
    expect(desk.preset).toBe("main-left-4");
    expect(desk.parked).toEqual([]);
    desk = addPane(desk, pane("F"));
    expect(keys(desk)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(desk.preset).toBe("grid-3x2");
    // A five-pane arrangement chosen by hand is kept while the count stays; down to four and back, the default.
    desk = setPreset(removePane(desk, "1:F"), "top-2-bottom-3");
    expect(desk.preset).toBe("top-2-bottom-3");
    expect(applySnap(desk, 0, { kind: "swap", index: 4 }).preset).toBe("top-2-bottom-3");
    expect(addPane(park(desk, "1:E"), pane("E")).preset).toBe("main-left-4");
  });

  it("parks the last pane when a seventh issue opens, and brings a parked one back", () => {
    let desk = deskWith("A", "B", "C", "D", "E", "F");
    desk = addPane(desk, pane("G"));
    expect(keys(desk)).toEqual(["A", "B", "C", "D", "E", "G"]);
    expect(desk.parked.map(item => item.key)).toEqual(["F"]);
    expect(desk.preset).toBe("grid-3x2");
    desk = unpark(desk, paneId(pane("F")), paneId(pane("A")));
    expect(keys(desk)).toEqual(["F", "B", "C", "D", "E", "G"]);
    expect(desk.parked.map(item => item.key)).toEqual(["A"]);
  });

  it("parks a pane on request, which frees its slot", () => {
    let desk = deskWith("A", "B", "C");
    desk = park(desk, paneId(pane("B")));
    expect(keys(desk)).toEqual(["A", "C"]);
    expect(desk.preset).toBe("cols-2");
    desk = unpark(desk, paneId(pane("B")));
    expect(keys(desk)).toEqual(["A", "C", "B"]);
  });

  it("maximizes only a shown pane, and forgets it when the pane goes", () => {
    let desk = maximize(deskWith("A", "B"), paneId(pane("B")));
    expect(desk.maximized).toBe("1:B");
    expect(maximize(desk, "1:Z").maximized).toBeNull();
    desk = removePane(desk, "1:B");
    expect(desk.maximized).toBeNull();
  });
});

describe("snapping", () => {
  it("puts the dragged pane in the slot and keeps the others in order", () => {
    const desk = deskWith("A", "B", "C");
    const snapped = applySnap(desk, 2, { kind: "slot", preset: "main-right", slot: 0 });
    expect(snapped.preset).toBe("main-right");
    expect(keys(snapped)).toEqual(["C", "A", "B"]);
    expect(keys(applySnap(desk, 0, { kind: "swap", index: 2 }))).toEqual(["C", "B", "A"]);
    // A slot of an arrangement for another count is refused.
    expect(applySnap(desk, 0, { kind: "slot", preset: "quad", slot: 3 })).toBe(desk);
  });

  it("gives edges halves or the big pane, and corners a meaning from 3 panes up", () => {
    expect(edgeTarget("right", 2)).toEqual({ kind: "slot", preset: "cols-2", slot: 1 });
    expect(edgeTarget("top-left", 2)).toBeNull();
    expect(edgeTarget("left", 3)).toEqual({ kind: "slot", preset: "main-left", slot: 0 });
    expect(edgeTarget("bottom-right", 4)).toEqual({ kind: "slot", preset: "quad", slot: 3 });
    expect(edgeTarget("left", 4)).toEqual({ kind: "slot", preset: "main-left-3", slot: 0 });
    expect(edgeTarget("bottom", 4)).toEqual({ kind: "slot", preset: "main-bottom-3", slot: 0 });
    expect(edgeTarget("right", 5)).toEqual({ kind: "slot", preset: "main-right-4", slot: 0 });
    expect(edgeTarget("top-right", 5)).toEqual({ kind: "slot", preset: "main-left-4", slot: 2 });
    expect(edgeTarget("bottom-left", 6)).toEqual({ kind: "slot", preset: "grid-3x2", slot: 3 });
    expect(edgeTarget("top", 6)).toEqual({ kind: "slot", preset: "grid-3x2", slot: 1 });
    expect(edgeTarget("left", 7)).toBeNull();
    // Every target named for an edge is a real slot of an arrangement for that many panes, where the edge says.
    const edges = ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] as const;
    for (const n of [2, 3, 4, 5, 6]) for (const edge of edges) {
      const target = edgeTarget(edge, n);
      if (target?.kind !== "slot") continue;
      expect(PRESETS[target.preset].slots).toBe(n);
      const rect = slotRects(target.preset)[target.slot];
      if (edge.includes("left")) expect(rect.x).toBeCloseTo(0);
      if (edge.includes("right")) expect(rect.x + rect.w).toBeCloseTo(1);
      if (edge.includes("top")) expect(rect.y).toBeCloseTo(0);
      if (edge.includes("bottom")) expect(rect.y + rect.h).toBeCloseTo(1);
    }
    // From four panes up, every edge and corner means something, no two the same.
    for (const n of [4, 5, 6]) {
      const targets = edges.map(edge => edgeTarget(edge, n));
      expect(targets.every(Boolean)).toBe(true);
      expect(new Set(targets.map(target => JSON.stringify(target))).size).toBe(edges.length);
    }
  });

  it("reads the pointer: a band at the edges, a corner where two meet, the middle of another pane to swap", () => {
    const rects = slotRects("cols-2");
    expect(zoneAt({ x: 0.95, y: 0.5 }, 2, rects, 0)).toEqual({ kind: "slot", preset: "cols-2", slot: 1 });
    // A corner with 2 panes falls back to its side.
    expect(zoneAt({ x: 0.02, y: 0.02 }, 2, rects, 1)).toEqual({ kind: "slot", preset: "cols-2", slot: 0 });
    expect(zoneAt({ x: 0.75, y: 0.5 }, 2, rects, 0)).toEqual({ kind: "swap", index: 1 });
    // Over itself, or in the gap between the band and the middle: nothing.
    expect(zoneAt({ x: 0.25, y: 0.5 }, 2, rects, 0)).toBeNull();
  });

  it("lists every place a pane can go, for the keyboard", () => {
    expect(snapTargets(2)).toHaveLength(4);
    expect(snapTargets(4)).toHaveLength(28);
    expect(snapTargets(5)).toHaveLength(20);
    expect(snapTargets(6)).toHaveLength(12);
    expect(snapTargets(1)).toEqual([{ kind: "slot", preset: "single", slot: 0 }]);
  });

  it("lets the keyboard reach each different desk once, where the pane is now among its arrangement's slots", () => {
    // Swapping two side by side is the right half: said once.
    expect(moveTargets(deskWith("A", "B"), 0)).toEqual(snapTargets(2));
    const three = moveTargets(deskWith("A", "B", "C"), 0);
    expect(three.slice(0, snapTargets(3).length)).toEqual(snapTargets(3));
    expect(three.filter(target => target.kind === "swap")).toEqual([{ kind: "swap", index: 2 }]);
    expect(moveTargets(deskWith("A"), 3)).toEqual([]);
    expect(sameTarget({ kind: "slot", preset: "quad", slot: 1 }, { kind: "slot", preset: "quad", slot: 1 })).toBe(true);
    expect(sameTarget({ kind: "swap", index: 1 }, { kind: "slot", preset: "quad", slot: 1 })).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    // Six panes: a pane goes to any slot of either grid; a spanning arrangement keeps the others' order.
    const six = deskWith("A", "B", "C", "D", "E", "F");
    expect(keys(applySnap(six, 5, { kind: "slot", preset: "grid-2x3", slot: 0 }))).toEqual(["F", "A", "B", "C", "D", "E"]);
    const five = applySnap(deskWith("A", "B", "C", "D", "E"), 0, { kind: "slot", preset: "top-3-bottom-2", slot: 4 });
    expect(five.preset).toBe("top-3-bottom-2");
    expect(keys(five)).toEqual(["B", "C", "D", "E", "A"]);
  });

  it("reads the pointer on the new arrangements: a pane spanning columns swaps from its middle", () => {
    const rects = slotRects("top-3-bottom-2");
    expect(zoneAt({ x: 0.25, y: 0.75 }, 5, rects, 0)).toEqual({ kind: "swap", index: 3 });
    expect(zoneAt({ x: 0.75, y: 0.75 }, 5, rects, 0)).toEqual({ kind: "swap", index: 4 });
    expect(zoneAt({ x: 0.02, y: 0.5 }, 5, rects, 0)).toEqual({ kind: "slot", preset: "main-left-4", slot: 0 });
    expect(zoneAt({ x: 0.98, y: 0.98 }, 6, slotRects("grid-3x2"), 0)).toEqual({ kind: "slot", preset: "grid-3x2", slot: 5 });
  });
});

describe("a desk too small for its arrangement", () => {
  it("draws the closest one that fits, else the chosen one", () => {
    expect(fitPreset("cols-4", 1200, 800, 320, 240)).toBe("quad");
    expect(fitPreset("cols-3", 800, 800, 320, 240)).toBe("main-left");
    expect(fitPreset("cols-2", 1200, 800, 320, 240)).toBe("cols-2");
    expect(fitPreset("quad", 300, 300, 320, 240)).toBe("quad");
  });

  it("falls back from the arrangements with many columns or rows", () => {
    // Three columns of 320 need 960: six panes on a narrower desk stand in two columns, if the height allows.
    expect(fitPreset("grid-3x2", 1600, 700, 320, 224)).toBe("grid-3x2");
    expect(fitPreset("grid-3x2", 900, 800, 320, 224)).toBe("grid-2x3");
    expect(fitPreset("grid-2x3", 1600, 600, 320, 224)).toBe("grid-3x2");
    // Three above two is three columns wide, not six.
    expect(fitPreset("top-3-bottom-2", 1000, 500, 320, 224)).toBe("top-3-bottom-2");
    // Four rows on a short desk: quarters.
    expect(fitPreset("rows-4", 1200, 600, 320, 224)).toBe("quad");
    expect(fitPreset("main-left-3", 1200, 600, 320, 224)).toBe("main-top-3");
    expect(fitPreset("rows-3", 1200, 500, 320, 224)).toBe("main-top");
    // Nothing fits: the one closest to fitting (its smallest pane the least short), the chosen one on a tie.
    expect(fitPreset("grid-3x2", 700, 450, 320, 224)).toBe("grid-3x2");
    expect(fitPreset("grid-3x2", 600, 600, 320, 224)).toBe("grid-2x3");
    for (const id of PRESET_IDS) expect(PRESETS[fitPreset(id, 400, 300, 320, 224)].slots).toBe(PRESETS[id].slots);
  });
});

describe("a stored or sent desk", () => {
  it("is made safe to draw", () => {
    const raw = {
      ...emptyDesk(),
      preset: "quad",
      panes: [pane("A"), pane("B"), pane("A"), pane("C"), pane("D"), pane("E"), pane("F"), pane("G")],
      parked: [pane("B"), ...Array.from({ length: 12 }, (_, i) => pane(`P${i}`))],
      tracks: { "cols-2": { cols: [0.99, 0.01], rows: [1] }, quad: { cols: [1], rows: [0.5, 0.5] } },
      maximized: "1:Z",
    };
    const desk = normalizeDesk(raw);
    expect(keys(desk)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(desk.parked[0].key).toBe("G");
    expect(desk.parked).toHaveLength(DESK_MAX_PARKED);
    expect(desk.panes).toHaveLength(DESK_MAX_PANES);
    expect(desk.preset).toBe("grid-3x2");
    expect(desk.tracks["cols-2"]?.cols[1]).toBeCloseTo(MIN_TRACK);
    expect(desk.tracks.quad).toBeUndefined();
    expect(desk.maximized).toBeNull();
  });

  it("falls back to an empty desk when it can't be read, and fixes an arrangement that doesn't match", () => {
    expect(normalizeDesk("nope")).toEqual(emptyDesk());
    expect(normalizeDesk({ ...emptyDesk(), preset: "quad", panes: [pane("A"), pane("B")] }).preset).toBe("cols-2");
  });

  it("keeps a desk stored before six panes as it was, and reads one with an arrangement it doesn't know", () => {
    const old = {
      v: 1,
      preset: "main-left",
      tracks: { "main-left": { cols: [0.6, 0.4], rows: [0.5, 0.5] }, "cols-4": { cols: [0.25, 0.25, 0.25, 0.25], rows: [1] } },
      panes: [pane("A"), { empty: true, id: "1" }, pane("B")],
      parked: [pane("C")],
      maximized: null,
      compare: false,
      onlyDifferences: false,
      noteId: null,
    };
    expect(normalizeDesk(JSON.parse(JSON.stringify(old)))).toEqual(old);
    for (const id of ["single", "cols-2", "rows-2", "cols-3", "cols-4", "main-left", "main-right", "main-top", "main-bottom", "quad"]) expect(PRESET_IDS).toContain(id);
    // An arrangement from a later version: the issues stay, in the default for their count; its sizes are dropped.
    const later = normalizeDesk({ ...old, preset: "hexagon-7", tracks: { ...old.tracks, "hexagon-7": { cols: [0.5, 0.5], rows: [1] } } });
    expect(shape(later)).toEqual(["A", "_", "B"]);
    expect(later.preset).toBe("main-left");
    expect(Object.keys(later.tracks).sort()).toEqual(["cols-4", "main-left"]);
    // Six-column sizes are kept; a spanning arrangement's columns may go under the minimum, never its panes.
    const wide = normalizeDesk({ ...emptyDesk(), preset: "top-3-bottom-2", panes: ["A", "B", "C", "D", "E"].map(key => pane(key)), tracks: { "top-3-bottom-2": { cols: [0.3, 0.1, 0.1, 0.2, 0.2, 0.1], rows: [0.5, 0.5] } } });
    expect(wide.preset).toBe("top-3-bottom-2");
    expect(wide.tracks["top-3-bottom-2"]?.cols.map(share => Math.round(share * 1000) / 1000)).toEqual([0.3, 0.1, 0.1, 0.2, 0.2, 0.1]);
  });
});

describe("empty slots", () => {
  const empties = (desk: DeskLayout) => desk.panes.filter(isEmptySlot).length;

  it("a layout with more slots than issues keeps the extra ones as empty slots, and an issue added fills the first", () => {
    let desk = setPreset(deskWith("A"), "cols-2");
    expect(desk.preset).toBe("cols-2");
    expect(shape(desk)).toEqual(["A", "_"]);
    desk = setPreset(desk, "quad");
    expect(shape(desk)).toEqual(["A", "_", "_", "_"]);
    expect(new Set(desk.panes.map(paneId)).size).toBe(4);
    desk = addPane(desk, pane("B"));
    expect(shape(desk)).toEqual(["A", "B", "_", "_"]);
    expect(desk.preset).toBe("quad");
    // Fewer slots: empty ones go first; never fewer than the issues.
    desk = setPreset(desk, "cols-2");
    expect(shape(desk)).toEqual(["A", "B"]);
    expect(setPreset(deskWith("A", "B", "C"), "cols-2").preset).toBe("main-left");
  });

  it("counts empty slots towards the six, but an issue still fills one before anything is parked", () => {
    let desk = setPreset(deskWith("A", "B", "C", "D"), "grid-3x2");
    expect(empties(desk)).toBe(2);
    desk = addPane(desk, pane("E"));
    expect(shape(desk)).toEqual(["A", "B", "C", "D", "E", "_"]);
    expect(desk.preset).toBe("grid-3x2");
    desk = addPane(desk, pane("F"));
    expect(shape(desk)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(desk.parked).toEqual([]);
    desk = addPane(desk, pane("G"));
    expect(shape(desk)).toEqual(["A", "B", "C", "D", "E", "G"]);
    expect(desk.parked.map(item => item.key)).toEqual(["F"]);
    // Four issues in a five-pane arrangement: one empty slot; back to four places, it goes.
    desk = setPreset(deskWith("A", "B", "C", "D"), "top-2-bottom-3");
    expect(shape(desk)).toEqual(["A", "B", "C", "D", "_"]);
    expect(shape(setPreset(desk, "quad"))).toEqual(["A", "B", "C", "D"]);
  });

  it("closes an empty slot (the arrangement follows), never parks one, and an issue brought back fills one", () => {
    let desk = setPreset(deskWith("A", "B"), "main-left");
    const slot = desk.panes.find(isEmptySlot);
    expect(slot).toBeDefined();
    if (!slot) return;
    expect(park(desk, paneId(slot)).parked).toEqual([]);
    desk = removePane(desk, paneId(slot));
    expect(shape(desk)).toEqual(["A", "B"]);
    expect(desk.preset).toBe("cols-2");
    desk = setPreset(park(desk, "1:B"), "cols-2");
    expect(shape(desk)).toEqual(["A", "_"]);
    desk = unpark(desk, "1:B");
    expect(shape(desk)).toEqual(["A", "B"]);
    // The last issue gone: the desk is empty, not a desk of empty slots.
    const one = setPreset(deskWith("A"), "cols-2");
    expect(removePane(one, "1:A").panes).toEqual([]);
    expect(maximize(one, paneId(one.panes[1])).maximized).toBeNull();
  });

  it("are stored: a stored desk keeps them, deduplicates only issues, and drops a desk of empty slots alone", () => {
    const desk = setPreset(deskWith("A", "B"), "quad");
    expect(normalizeDesk(JSON.parse(JSON.stringify(desk)))).toEqual(desk);
    const raw = { ...desk, panes: [pane("A"), { empty: true, id: "1" }, pane("A"), { empty: true, id: "1" }, { empty: true, id: "2" }, pane("B"), pane("C"), pane("D"), pane("E")] };
    const fixed = normalizeDesk(raw);
    expect(shape(fixed)).toEqual(["A", "_", "_", "B", "C", "D"]);
    expect(fixed.parked.map(item => item.key)).toEqual(["E"]);
    expect(normalizeDesk({ ...emptyDesk(), preset: "cols-2", panes: [{ empty: true, id: "1" }, { empty: true, id: "2" }] }).panes).toEqual([]);
    // An empty slot is a strict shape: anything else makes the desk unreadable.
    expect(normalizeDesk({ ...desk, panes: [pane("A"), { empty: true }] })).toEqual(emptyDesk());
  });

  it("stay where they are when a pane is snapped", () => {
    const desk = setPreset(deskWith("A"), "cols-2");
    expect(shape(applySnap(desk, 0, { kind: "slot", preset: "cols-2", slot: 1 }))).toEqual(["_", "A"]);
    expect(shape(applySnap(desk, 0, { kind: "swap", index: 1 }))).toEqual(["_", "A"]);
  });
});

describe("sending an issue to the desk", () => {
  it("puts it in the slot chosen, the desk's issues in the other slots where they fit, empty slots for the rest", () => {
    let desk = placeIssue(emptyDesk(), pane("A"), "cols-2", 1);
    expect(desk.preset).toBe("cols-2");
    expect(shape(desk)).toEqual(["_", "A"]);
    desk = placeIssue(deskWith("B", "C"), pane("A"), "cols-2", 0);
    expect(shape(desk)).toEqual(["A", "B"]);
    expect(desk.parked.map(item => item.key)).toEqual(["C"]);
    desk = placeIssue(deskWith("B"), pane("A"), "main-left", 2);
    expect(shape(desk)).toEqual(["B", "_", "A"]);
    // Already on the desk (or parked): it moves there, never twice.
    desk = placeIssue(deskWith("A", "B"), pane("A"), "cols-2", 1);
    expect(shape(desk)).toEqual(["B", "A"]);
    desk = placeIssue({ ...deskWith("B"), parked: [pane("A")] }, pane("A"), "cols-2", 0);
    expect(shape(desk)).toEqual(["A", "B"]);
    expect(desk.parked).toEqual([]);
    // A slot the arrangement doesn't have: the desk is left as it is.
    const before = deskWith("B");
    expect(placeIssue(before, pane("A"), "cols-2", 2)).toBe(before);
  });

  it("offers the issue page the arrangements with room for it beside the desk's issues", () => {
    expect(pagePresets(1)).toEqual(["cols-2", "rows-2", "main-left", "main-right", "cols-3", "quad"]);
    expect(pagePresets(3)).toEqual(["main-left", "main-right", "cols-3", "quad", "main-left-3", "main-right-3"]);
    expect(pagePresets(4)).toEqual(["quad", "main-left-3", "main-right-3", "cols-4", "main-left-4", "main-right-4"]);
    expect(pagePresets(5)).toEqual(["main-left-4", "main-right-4", "grid-3x2", "top-3-bottom-2", "top-2-bottom-3", "grid-2x3"]);
    expect(pagePresets(6)).toEqual(["grid-3x2", "grid-2x3"]);
    expect(pagePresets(9)).toEqual(["grid-3x2", "grid-2x3"]);
  });

  it("opens issues picked together in the arrangement for their count, parking the others", () => {
    const desk = openTogether(setPreset(deskWith("A", "B"), "quad"), [pane("C"), pane("A"), pane("D"), pane("C")]);
    expect(desk.preset).toBe("main-left");
    expect(shape(desk)).toEqual(["C", "A", "D"]);
    expect(desk.parked.map(item => item.key)).toEqual(["B"]);
    const none = deskWith("A");
    expect(openTogether(none, [])).toBe(none);
    const six = openTogether(none, ["A", "B", "C", "D", "E", "F", "G"].map(key => pane(key)));
    expect(six.preset).toBe("grid-3x2");
    expect(shape(six)).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("opens two issues side by side, parking the others", () => {
    const desk = sideBySide(deskWith("B", "C", "D"), pane("A"), pane("C"));
    expect(desk.preset).toBe("cols-2");
    expect(shape(desk)).toEqual(["A", "C"]);
    expect(desk.parked.map(item => item.key)).toEqual(["B", "D"]);
  });

  it("drops an issue brought from outside: a slot of an arrangement with one more place, or in place of a pane", () => {
    let desk = dropIssue(deskWith("A", "B"), pane("C"), { kind: "slot", preset: "main-left", slot: 0 });
    expect(shape(desk)).toEqual(["C", "A", "B"]);
    expect(desk.preset).toBe("main-left");
    desk = dropIssue(deskWith("A", "B", "C", "D"), pane("E"), { kind: "swap", index: 1 });
    expect(shape(desk)).toEqual(["A", "E", "C", "D"]);
    expect(desk.parked.map(item => item.key)).toEqual(["B"]);
    // In place of an empty slot: it fills it, nothing parked.
    desk = dropIssue(setPreset(deskWith("A"), "cols-2"), pane("B"), { kind: "swap", index: 1 });
    expect(shape(desk)).toEqual(["A", "B"]);
    expect(desk.parked).toEqual([]);
    // Already there, or a slot for another count: unchanged.
    const two = deskWith("A", "B");
    expect(dropIssue(two, pane("A"), { kind: "slot", preset: "main-left", slot: 0 })).toBe(two);
    expect(dropIssue(two, pane("C"), { kind: "slot", preset: "cols-2", slot: 0 })).toBe(two);
  });
});
