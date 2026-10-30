// The forecast's pure parts (docs/work/ideas/estimates.md R-3.17–R-3.20).
import { describe, expect, it } from "vitest";
import { addDays, dayKey, parseDayKey } from "./time";
import { capacityInput, cleanQuantiles, direction, finishDate, ForecastShapeError, weeklySeries, type ForecastDay } from "./forecast";

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => dayKey(addDays(parseDayKey(from)!, i)));
const flat = (from: string, n: number, p10: number, p50: number, p90: number): ForecastDay[] => days(from, n).map(day => ({ day, p10, p50, p90, off: false }));

describe("forecast", () => {
  it("forecast quantiles are made finite, non-negative and ordered", () => {
    const [d0, d1] = days("2026-11-02", 2);
    expect(cleanQuantiles([{ day: d0, p10: 5, p50: 4, p90: 3 }, { day: d1, p10: -1, p50: 2, p90: 3 }], [false, false])).toEqual([
      { day: d0, p10: 3, p50: 4, p90: 5, off: false },
      { day: d1, p10: 0, p50: 2, p90: 3, off: false },
    ]);
    expect(() => cleanQuantiles([{ day: d0, p10: 1, p50: Number.NaN, p90: 3 }], [false])).toThrow(ForecastShapeError);
    expect(() => cleanQuantiles([{ day: d0, p10: 1, p50: Infinity, p90: 3 }], [false])).toThrow(ForecastShapeError);
    // One flag per day, or the answer isn't for these days.
    expect(() => cleanQuantiles([{ day: d0, p10: 1, p50: 2, p90: 3 }], [false, true])).toThrow(ForecastShapeError);
  });

  it("a day off is zero whatever the model says", () => {
    const [d0, d1] = days("2026-12-24", 2);
    expect(cleanQuantiles([{ day: d0, p10: 4, p50: 6, p90: 7 }, { day: d1, p10: 4, p50: 6, p90: 7 }], [false, true])).toEqual([
      { day: d0, p10: 4, p50: 6, p90: 7, off: false },
      { day: d1, p10: 0, p50: 0, p90: 0, off: true },
    ]);
  });

  it("a finish beyond the horizon says so", () => {
    const capacity = flat("2026-11-02", 90, 5, 5, 5);
    expect(finishDate(capacity, 2000, 2000)).toEqual({
      p50: null,
      p80: null,
      p50Beyond: true,
      p80Beyond: true,
      remainingHoursP50: 2000 - 450,
      remainingHoursP80: 2000 - 450,
    });
  });

  it("the finish walks P50 capacity and bounds with P10", () => {
    // 3 issues of 10 h: 30 h of work; 5 h a day likely, 2 h a day at worst.
    const capacity = flat("2026-11-02", 90, 2, 5, 8);
    const f = finishDate(capacity, 30, 30);
    expect(f.p50).toBe("2026-11-07"); // 6th day: 6 × 5 = 30
    expect(f.p80).toBe("2026-11-16"); // 15th day: 15 × 2 = 30
    expect([f.p50Beyond, f.p80Beyond, f.remainingHoursP50, f.remainingHoursP80]).toEqual([false, false, 0, 0]);
    // Nothing to do: done today.
    expect(finishDate(capacity, 0, 0).p50).toBe("2026-11-02");
  });

  it("the likely date can fall within the horizon and the bound beyond it", () => {
    const capacity = flat("2026-11-02", 90, 1, 5, 9);
    const f = finishDate(capacity, 200, 300);
    expect(f.p50).toBe(dayKey(addDays(parseDayKey("2026-11-02")!, 39)));
    expect(f).toMatchObject({ p80: null, p50Beyond: false, p80Beyond: true, remainingHoursP50: 0 });
    expect(f.remainingHoursP80).toBeGreaterThan(0);
    expect(f.remainingHoursP80).toBe(300 - 90);
  });

  it("weekly series fill gaps and need eight weeks", () => {
    const now = new Date(2026, 9, 30).getTime();
    const monday = (w: number) => addDays(new Date(2026, 5, 1), w * 7).getTime() + 10 * 3_600_000;
    // 20 weeks: data in weeks 0–6, 13–19; weeks 7–12 (six) empty in between.
    const withData = [...Array.from({ length: 7 }, (_, i) => i), ...Array.from({ length: 7 }, (_, i) => 13 + i)];
    const samples = withData.flatMap(w => [
      { lastCountedWorklogAt: monday(w), workSeconds: (w + 1) * 3600, trackerEstimate: 3600 },
      { lastCountedWorklogAt: monday(w) + 3_600_000, workSeconds: (w + 1) * 3600, trackerEstimate: null },
    ]);
    const s = weeklySeries(samples, now);
    if ("insufficient" in s.work) throw new Error("expected a series");
    expect(s.work.weeks).toHaveLength(20);
    expect(s.work.weeks.filter(w => w.imputed).map(w => w.week)).toEqual(Array.from({ length: 6 }, (_, i) => dayKey(new Date(monday(7 + i) - 10 * 3_600_000))));
    // A straight line between week 6 (7 h) and week 13 (14 h).
    expect(s.work.weeks.map(w => w.value)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    if ("insufficient" in s.ratio) throw new Error("expected a ratio series");
    expect(s.ratio.weeks[0]).toEqual({ week: dayKey(new Date(monday(0) - 10 * 3_600_000)), value: 1, imputed: false });
    // Seven weeks with data: not enough.
    expect(weeklySeries(samples.filter(x => x.lastCountedWorklogAt < monday(7)), now).work).toEqual({ insufficient: true, have: 7, need: 8 });
    // Eight weeks with data but spanning less than twelve: not enough either.
    const close = Array.from({ length: 8 }, (_, w) => ({ lastCountedWorklogAt: monday(w), workSeconds: 3600, trackerEstimate: null }));
    expect(weeklySeries(close, now).work).toEqual({ insufficient: true, have: 8, need: 8 });
    // Lower is better: a P50 5% under the last week is faster.
    expect([direction(10, 9.4), direction(10, 10.4), direction(10, 10.6)]).toEqual(["better", "flat", "worse"]);
  });

  it("misaligned covariates are refused", () => {
    const past = days("2025-10-31", 365);
    const ahead = days("2026-10-31", 7);
    const history = { days: past, hours: past.map(() => 4), workday: past.map(() => 1), off: past.map(() => 0) };
    const future = { days: ahead, workday: ahead.map(() => 1), off: ahead.map(() => 0) };
    const ok = capacityInput(history, future);
    expect(ok.series).toHaveLength(365);
    expect(ok.past_covariates.off).toHaveLength(365);
    expect(ok.future_covariates.workday).toHaveLength(7);
    // Logged hours are capped at a day.
    expect(capacityInput({ ...history, hours: past.map((_, i) => (i === 0 ? 30 : 4)) }, future).series[0]).toBe(24);
    expect(() => capacityInput({ ...history, off: history.off.slice(1) }, future)).toThrow(ForecastShapeError);
    expect(() => capacityInput(history, { ...future, workday: [...future.workday, 1] })).toThrow(ForecastShapeError);
    // Days that don't follow each other, or a future that doesn't start the day after.
    expect(() => capacityInput({ ...history, days: [...past.slice(0, 10), ...past.slice(11), "2026-10-31"] }, future)).toThrow(ForecastShapeError);
    expect(() => capacityInput(history, { ...future, days: days("2026-11-01", 7) })).toThrow(ForecastShapeError);
  });
});
