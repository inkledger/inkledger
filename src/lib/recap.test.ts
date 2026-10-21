import { describe, it, expect } from "vitest";
import { weekRecap } from "./recap";

const at = (d: number, h = 10) => new Date(2026, 9, d, h); // October 2026
const H = 3600;

const weekdays8h = (d: Date) => (d.getDay() === 0 || d.getDay() === 6 ? 0 : 8 * 3600);

describe("weekRecap", () => {
  // Thursday 15 Oct 2026: week Mon 12 → Sun 18, last week Mon 5 → Sun 11.
  const now = at(15, 18);
  const logs = [
    { issueKey: "DEMO-1", started: at(12), timeSpentSeconds: 8 * H },
    { issueKey: "DEMO-1", started: at(13), timeSpentSeconds: 3 * H },
    { issueKey: "MAGA-2", started: at(13, 15), timeSpentSeconds: 5 * H },
    { issueKey: "DEMO-3", started: at(15), timeSpentSeconds: 2 * H },
    // last week: Mon–Thu counts, Friday does not (not yet reached this week)
    { issueKey: "DEMO-1", started: at(6), timeSpentSeconds: 10 * H },
    { issueKey: "DEMO-1", started: at(9), timeSpentSeconds: 4 * H },
  ];

  it("totals this week and compares with the same days of last week", () => {
    const r = weekRecap(logs, now, weekdays8h);
    expect(r.total).toBe(18 * H);
    expect(r.prevTotal).toBe(10 * H);
    expect(r.deltaPct).toBe(80);
    expect(r.daysAtGoal).toBe(2);
    expect(r.workdays).toBe(4);
    expect(r.avgPerWorkedDay).toBe(6 * H);
    expect(r.topIssue).toEqual({ key: "DEMO-1", seconds: 11 * H });
    expect(r.topProject).toEqual({ key: "DEMO", seconds: 13 * H });
    expect(r.perDay.map(d => d.seconds / H)).toEqual([8, 8, 0, 2, 0, 0, 0]);
  });

  it("work done in parallel counts once in the totals; each issue and project keeps its own", () => {
    const parallel = [...logs, { issueKey: "MAGA-9", started: at(12), timeSpentSeconds: 2 * H }];
    const r = weekRecap(parallel, now, weekdays8h);
    expect(r.total).toBe(18 * H);
    expect(r.perDay.map(d => d.seconds / H)).toEqual([8, 8, 0, 2, 0, 0, 0]);
    expect(r.topProject).toEqual({ key: "DEMO", seconds: 13 * H });
    expect(weekRecap([...parallel, { issueKey: "MAGA-9", started: at(6), timeSpentSeconds: 10 * H }], now, weekdays8h).prevTotal).toBe(10 * H);
  });

  it("has no delta when last week is empty", () => {
    expect(weekRecap(logs.slice(0, 4), now, weekdays8h).deltaPct).toBeNull();
  });
});
