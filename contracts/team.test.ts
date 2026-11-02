import { describe, expect, it } from "vitest";
import { autoGranularity, bucketsOf, coverageDelta, coverageStep } from "./team";
import { isoWeek } from "./time";

const cell = (loggedSeconds: number, targetSeconds: number, more: { absentSeconds?: number; future?: boolean } = {}) =>
  coverageStep({ loggedSeconds, targetSeconds, absentSeconds: more.absentSeconds ?? 0, future: more.future ?? false });

describe("team report rules", () => {
  it("a cell's step by share of its target", () => {
    expect(cell(8, 8)).toBe("full");
    expect(cell(9, 8)).toBe("full");
    expect(cell(6, 8)).toBe("high");
    expect(cell(4, 8)).toBe("mid");
    expect(cell(1, 8)).toBe("low");
    expect(cell(0, 8)).toBe("none");
  });

  it("nothing expected, away, or not yet: no judgement", () => {
    expect(cell(0, 0)).toBe("off");
    expect(cell(3, 0)).toBe("off");
    expect(cell(0, 0, { absentSeconds: 8 })).toBe("absent");
    // Half a day away: judged on the half that was expected.
    expect(cell(4, 4, { absentSeconds: 4 })).toBe("full");
    expect(cell(0, 8, { future: true })).toBe("future");
  });

  it("the change in points, none without both sides", () => {
    expect(coverageDelta(0.85, 0.79)).toBe(6);
    expect(coverageDelta(0.5, 0.6)).toBe(-10);
    expect(coverageDelta(null, 0.6)).toBeNull();
    expect(coverageDelta(0.6, null)).toBeNull();
  });

  it("columns: days up to six weeks, then weeks, then months", () => {
    expect(autoGranularity(31)).toBe("day");
    expect(autoGranularity(42)).toBe("day");
    expect(autoGranularity(92)).toBe("week");
    expect(autoGranularity(366)).toBe("month");
  });

  it("weeks run Monday to Sunday, cut at the range's edges", () => {
    // Thursday 1 October to Sunday 18 October 2026.
    const weeks = bucketsOf(new Date(2026, 9, 1), new Date(2026, 9, 18), "week");
    expect(weeks.map((w) => w.days.length)).toEqual([4, 7, 7]);
    expect(weeks.map((w) => w.key)).toEqual(["2026-10-01", "2026-10-05", "2026-10-12"]);
    expect(weeks.map((w) => w.n)).toEqual([40, 41, 42]);
  });

  it("months across a year's end, and days one by one (DST included)", () => {
    const months = bucketsOf(new Date(2026, 10, 15), new Date(2027, 1, 10), "month");
    expect(months.map((m) => [m.key, m.days.length])).toEqual([
      ["2026-11-15", 16],
      ["2026-12-01", 31],
      ["2027-01-01", 31],
      ["2027-02-01", 10],
    ]);
    // 25 October 2026 has 25 hours in Europe/Rome: still one day.
    const days = bucketsOf(new Date(2026, 9, 24), new Date(2026, 9, 26), "day");
    expect(days.map((d) => d.key)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  });

  it("ISO weeks, week 53 included", () => {
    expect(isoWeek(new Date(2026, 9, 5))).toBe(41);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
    expect(isoWeek(new Date(2026, 11, 31))).toBe(53);
    expect(isoWeek(new Date(2027, 0, 3))).toBe(53);
    expect(isoWeek(new Date(2027, 0, 4))).toBe(1);
  });
});
