import { describe, expect, it } from "vitest";
import { groupKey, splitOf, stretchesOf, type SplitRun, type SplitShare } from "./timerSplit";

const at = (h: number, m = 0) => Date.UTC(2026, 10, 3, h, m);
const run = (timer: string, from: number, to: number, logged = false): SplitRun => ({ timer, start: from, end: to, logged });
const min = (seconds: number) => seconds / 60;
const A = "1:A-1";
const B = "1:B-1";
const C = "1:C-1";

describe("stretchesOf", () => {
  it("a timer alone: all of it alone, nothing to share", () => {
    const s = stretchesOf(A, [run(A, at(9), at(10))], []);
    expect(s.alone).toEqual([{ start: at(9), end: at(10) }]);
    expect(s.stretches).toEqual([]);
  });

  it("two timers: the time together is one stretch, half each by default", () => {
    const s = stretchesOf(A, [run(A, at(9), at(11)), run(B, at(10, 20), at(11, 30))], []);
    expect(s.alone).toEqual([{ start: at(9), end: at(10, 20) }]);
    expect(s.stretches).toEqual([{ start: at(10, 20), end: at(11), others: [B], recorded: {}, defaultBp: 5000 }]);
    expect(s.order).toEqual([A, B]);
  });

  it("the other's recorded share leaves the rest as the default", () => {
    const shares: SplitShare[] = [{ timer: A, start: at(10, 20), end: at(11), bp: 6000 }];
    const s = stretchesOf(B, [run(A, at(9), at(11), true), run(B, at(10, 20), at(11, 30))], shares);
    expect(s.stretches[0]).toMatchObject({ others: [A], recorded: { [A]: 6000 }, defaultBp: 4000 });
    expect(s.alone).toEqual([{ start: at(11), end: at(11, 30) }]);
  });

  it("three timers: a third each, and a quarter each once one took half", () => {
    const runs = [run(A, at(9), at(10)), run(B, at(9), at(10)), run(C, at(9), at(10))];
    expect(stretchesOf(A, runs, []).stretches[0].defaultBp).toBeCloseTo(10000 / 3);
    const half: SplitShare[] = [{ timer: A, start: at(9), end: at(10), bp: 5000 }];
    expect(stretchesOf(B, runs.map((r) => (r.timer === A ? { ...r, logged: true } : r)), half).stretches[0].defaultBp).toBe(2500);
  });

  it("stretches change where the set of timers beside it changes; two runs of one timer count once", () => {
    const runs = [run(A, at(9), at(12)), run(B, at(9, 30), at(10)), run(B, at(10), at(11)), run(C, at(10, 30), at(11, 30))];
    const s = stretchesOf(A, runs, []);
    expect(s.stretches.map((x) => [x.start, x.end, x.others])).toEqual([
      [at(9, 30), at(10, 30), [B]],
      [at(10, 30), at(11), [B, C]],
      [at(11), at(11, 30), [C]],
    ]);
  });

  it("a logged run of the target is not counted again", () => {
    const s = stretchesOf(A, [run(A, at(9), at(10), true), run(A, at(10), at(11))], []);
    expect(s.alone).toEqual([{ start: at(10), end: at(11) }]);
  });
});

describe("splitOf", () => {
  const together = [run(A, at(9), at(11)), run(B, at(10, 20), at(11, 30))];

  it("A gives itself 60 % of the 40 min with B: 1 h 20 alone + 24 min, placed 9:00–10:44", () => {
    const split = splitOf(A, stretchesOf(A, together, []), { [groupKey([B])]: 6000 }, 2 * 3600);
    expect(min(split.aloneSeconds)).toBe(80);
    expect(split.groups).toEqual([{ key: B, others: [B], seconds: 2400, defaultBp: 5000, bp: 6000, shareSeconds: 1440 }]);
    expect(min(split.toLogSeconds)).toBe(104);
    expect(split.pieces).toEqual([{ start: at(9), seconds: 104 * 60 }]);
  });

  it("B then gets the 40 % left, after A's part: 10:44–11:30", () => {
    const shares: SplitShare[] = [{ timer: A, start: at(10, 20), end: at(11), bp: 6000 }];
    const runs = together.map((r) => (r.timer === A ? { ...r, logged: true } : r));
    const split = splitOf(B, stretchesOf(B, runs, shares), {}, 70 * 60);
    expect(split.groups[0].bp).toBe(4000);
    expect(min(split.toLogSeconds)).toBe(46);
    expect(split.pieces).toEqual([{ start: at(10, 44), seconds: 46 * 60 }]);
    expect(split.overBp).toBe(10000);
  });

  it("the timer started later logging first still leaves the earlier one's part first", () => {
    const split = splitOf(B, stretchesOf(B, together, []), {}, 70 * 60);
    // B: half of 10:20–11:00 after A's (default) half, then alone.
    expect(split.pieces).toEqual([{ start: at(10, 40), seconds: 50 * 60 }]);
  });

  it("over 100 % together is told, not refused", () => {
    const shares: SplitShare[] = [{ timer: A, start: at(10, 20), end: at(11), bp: 6000 }];
    const runs = together.map((r) => (r.timer === A ? { ...r, logged: true } : r));
    expect(splitOf(B, stretchesOf(B, runs, shares), { [A]: 6000 }, 70 * 60).overBp).toBe(12000);
  });

  it("time the runs don't show (a timer older than them) is alone, and then where it goes can't be told", () => {
    const split = splitOf(A, stretchesOf(A, [run(A, at(10), at(11))], []), {}, 2 * 3600);
    expect(min(split.aloneSeconds)).toBe(120);
    expect(split.pieces).toBeNull();
  });

  it("too many pieces: placed the usual way", () => {
    const runs = [run(A, at(8), at(18)), ...[9, 11, 13, 15, 17].map((h) => run(B, at(h), at(h, 30)))];
    expect(splitOf(A, stretchesOf(A, runs, []), { [B]: 0 }, 10 * 3600).pieces).toBeNull();
  });

  it("rounds what to log to the minute, as a stop does", () => {
    const split = splitOf(A, stretchesOf(A, [run(A, at(9), at(9, 10) + 20_000)], []), {}, 610);
    expect(split.toLogSeconds).toBe(600);
  });
});
