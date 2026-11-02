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
    expect(presetsFor(3)).toEqual(["cols-3", "main-left", "main-right", "main-top", "main-bottom"]);
    expect(presetsFor(4)).toEqual(["cols-4", "quad"]);
    for (const n of [1, 2, 3, 4]) expect(presetsFor(n)).toContain(defaultPreset(n));
  });

  it("draws a line only where it separates two panes", () => {
    expect(dividersOf("single")).toEqual([]);
    expect(dividersOf("cols-3")).toEqual([{ axis: "cols", index: 0, from: 0, to: 1 }, { axis: "cols", index: 1, from: 0, to: 1 }]);
    // One big on the left: the column line runs the whole height, the row line only on the right.
    expect(dividersOf("main-left")).toEqual([{ axis: "cols", index: 0, from: 0, to: 2 }, { axis: "rows", index: 0, from: 1, to: 2 }]);
    expect(dividersOf("quad")).toHaveLength(2);
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

  it("parks the last pane when a fifth issue opens, and brings a parked one back", () => {
    let desk = deskWith("A", "B", "C", "D");
    desk = addPane(desk, pane("E"));
    expect(keys(desk)).toEqual(["A", "B", "C", "E"]);
    expect(desk.parked.map(item => item.key)).toEqual(["D"]);
    desk = unpark(desk, paneId(pane("D")), paneId(pane("A")));
    expect(keys(desk)).toEqual(["D", "B", "C", "E"]);
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

  it("gives edges halves, and corners a meaning only with 3 or 4 panes", () => {
    expect(edgeTarget("right", 2)).toEqual({ kind: "slot", preset: "cols-2", slot: 1 });
    expect(edgeTarget("top-left", 2)).toBeNull();
    expect(edgeTarget("left", 3)).toEqual({ kind: "slot", preset: "main-left", slot: 0 });
    expect(edgeTarget("bottom-right", 4)).toEqual({ kind: "slot", preset: "quad", slot: 3 });
    // Every target named for an edge is a real slot of its arrangement.
    for (const n of [2, 3, 4]) for (const edge of ["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      const target = edgeTarget(edge, n);
      if (target?.kind === "slot") expect(target.slot).toBeLessThan(PRESETS[target.preset].slots);
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
    expect(snapTargets(4)).toHaveLength(8);
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
  });
});

describe("a desk too small for its arrangement", () => {
  it("draws the closest one that fits, else the chosen one", () => {
    expect(fitPreset("cols-4", 1200, 800, 320, 240)).toBe("quad");
    expect(fitPreset("cols-3", 800, 800, 320, 240)).toBe("main-left");
    expect(fitPreset("cols-2", 1200, 800, 320, 240)).toBe("cols-2");
    expect(fitPreset("quad", 300, 300, 320, 240)).toBe("quad");
  });
});

describe("a stored or sent desk", () => {
  it("is made safe to draw", () => {
    const raw = {
      ...emptyDesk(),
      preset: "quad",
      panes: [pane("A"), pane("B"), pane("A"), pane("C"), pane("D"), pane("E")],
      parked: [pane("B"), ...Array.from({ length: 12 }, (_, i) => pane(`P${i}`))],
      tracks: { "cols-2": { cols: [0.99, 0.01], rows: [1] }, quad: { cols: [1], rows: [0.5, 0.5] } },
      maximized: "1:Z",
    };
    const desk = normalizeDesk(raw);
    expect(keys(desk)).toEqual(["A", "B", "C", "D"]);
    expect(desk.parked[0].key).toBe("E");
    expect(desk.parked).toHaveLength(DESK_MAX_PARKED);
    expect(desk.panes).toHaveLength(DESK_MAX_PANES);
    expect(desk.preset).toBe("quad");
    expect(desk.tracks["cols-2"]?.cols[1]).toBeCloseTo(MIN_TRACK);
    expect(desk.tracks.quad).toBeUndefined();
    expect(desk.maximized).toBeNull();
  });

  it("falls back to an empty desk when it can't be read, and fixes an arrangement that doesn't match", () => {
    expect(normalizeDesk("nope")).toEqual(emptyDesk());
    expect(normalizeDesk({ ...emptyDesk(), preset: "quad", panes: [pane("A"), pane("B")] }).preset).toBe("cols-2");
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

  it("counts empty slots towards the four, but a fifth issue still fills one before anything is parked", () => {
    let desk = setPreset(deskWith("A", "B", "C"), "quad");
    expect(empties(desk)).toBe(1);
    desk = addPane(desk, pane("D"));
    expect(shape(desk)).toEqual(["A", "B", "C", "D"]);
    expect(desk.parked).toEqual([]);
    desk = addPane(desk, pane("E"));
    expect(shape(desk)).toEqual(["A", "B", "C", "E"]);
    expect(desk.parked.map(item => item.key)).toEqual(["D"]);
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
    const raw = { ...desk, panes: [pane("A"), { empty: true, id: "1" }, pane("A"), { empty: true, id: "1" }, { empty: true, id: "2" }, pane("B"), pane("C")] };
    const fixed = normalizeDesk(raw);
    expect(shape(fixed)).toEqual(["A", "_", "_", "B"]);
    expect(fixed.parked.map(item => item.key)).toEqual(["C"]);
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
    expect(pagePresets(3)).toEqual(["main-left", "main-right", "cols-3", "quad", "cols-4", "main-top"]);
    expect(pagePresets(4)).toEqual(["quad", "cols-4"]);
    expect(pagePresets(9)).toEqual(["quad", "cols-4"]);
  });

  it("opens issues picked together in the arrangement for their count, parking the others", () => {
    const desk = openTogether(setPreset(deskWith("A", "B"), "quad"), [pane("C"), pane("A"), pane("D"), pane("C")]);
    expect(desk.preset).toBe("main-left");
    expect(shape(desk)).toEqual(["C", "A", "D"]);
    expect(desk.parked.map(item => item.key)).toEqual(["B"]);
    const none = deskWith("A");
    expect(openTogether(none, [])).toBe(none);
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
