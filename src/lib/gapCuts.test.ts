import { describe, it, expect } from "vitest";
import { addCut, cutLongest, moveCut, segments, takenSpans, withCuts, withoutCut } from "./gapCuts";

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m).getTime();
const gap = { start: new Date(at(9)), seconds: 2 * 3600 }; // 9:00–11:00

describe("gap cuts", () => {
  it("snaps cuts to the minute and splits the gap", () => {
    const cuts = addCut(gap, [], at(9, 42) + 20_000);
    expect(cuts).toEqual([at(9, 42)]);
    expect(segments(gap, cuts).map(s => s.seconds / 60)).toEqual([42, 78]);
    expect(addCut(gap, [], at(9, 42) + 40_000)).toEqual([at(9, 43)]);
  });

  it("keeps every piece at least a minute", () => {
    expect(addCut(gap, [], at(9) + 10_000)).toEqual([at(9, 1)]);
    expect(addCut(gap, [at(9, 5)], at(9, 5) + 20_000)).toEqual([at(9, 5), at(9, 6)]);
    const tiny = { start: new Date(at(9)), seconds: 90 };
    expect(addCut(tiny, [], at(9) + 45_000)).toEqual([]);
  });

  it("moves a cut without crossing its neighbours", () => {
    const cuts = [at(9, 30), at(10)];
    expect(moveCut(gap, cuts, 0, at(10, 30))).toEqual([at(9, 59), at(10)]);
    expect(moveCut(gap, cuts, 1, at(8))).toEqual([at(9, 30), at(9, 31)]);
    expect(moveCut(gap, cuts, 0, at(9, 31))).toEqual([at(9, 31), at(10)]);
  });

  it("cuts the longest piece in half", () => {
    expect(cutLongest(gap, [])).toEqual([at(10)]);
    expect(cutLongest(gap, [at(9, 20)])).toEqual([at(9, 20), at(10, 10)]);
  });
});

describe("gap lanes", () => {
  type P = { key: string | null; done?: boolean };
  const fresh = (p: P): P => ({ ...p, done: false });
  const lane = { cuts: [at(10)], pieces: [{ key: "A-1" }, { key: null }] as P[] };

  it("an added cut splits its piece, the copy fresh; a removed cut merges, keeping the left piece unless it is empty", () => {
    const cut = withCuts(lane, [at(9, 30), at(10)], fresh);
    expect(cut.pieces).toEqual([{ key: "A-1" }, { key: "A-1", done: false }, { key: null }]);
    expect(withCuts(lane, [], fresh)).toEqual({ cuts: [], pieces: lane.pieces });
    expect(withoutCut(lane, 0, p => !!p.key).pieces).toEqual([{ key: "A-1" }]);
    expect(withoutCut({ cuts: [at(10)], pieces: [{ key: null }, { key: "B-2" }] }, 0, p => !!p.key).pieces).toEqual([{ key: "B-2" }]);
  });

  it("the spans taken in every lane, overlapping ones included", () => {
    const parallel = { cuts: [at(9, 30), at(10, 30)], pieces: [{ key: null }, { key: "B-2" }, { key: null }] as P[] };
    const spans = takenSpans(gap, [lane, parallel], p => !!p.key);
    expect(spans.map(s => [new Date(s.start).getHours() * 60 + new Date(s.start).getMinutes(), s.seconds / 60])).toEqual([
      [9 * 60, 60],
      [9 * 60 + 30, 60],
    ]);
  });
});
