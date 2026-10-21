import { describe, expect, it } from "vitest";
import { recentFinished } from "./boardDone";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 21, 12);
const card = (id: number, daysAgo: number | null) => ({ id, relevantAt: daysAgo === null ? null : now - daysAgo * DAY });

describe("a finished column", () => {
  it("shows the last two weeks, newest first; older ones wait", () => {
    const r = recentFinished([card(1, 30), card(2, 1), card(3, 13), card(4, null), card(5, 15)], now);
    expect(r.shown.map(c => c.id)).toEqual([2, 3]);
    expect(r.older).toBe(3);
  });

  it("never more than the cap, even of recent ones", () => {
    const r = recentFinished(Array.from({ length: 30 }, (_, i) => card(i, i / 10)), now, 20);
    expect(r.shown).toHaveLength(20);
    expect(r.older).toBe(10);
  });
});
