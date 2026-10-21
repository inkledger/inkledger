import { describe, it, expect } from "vitest";
import { projectColor, rankProjects } from "./projectColors";

describe("projectColor", () => {
  it("is stable per key, whatever the period's ranking", () => {
    const a = rankProjects(new Map([["PRJ", 100], ["OPS", 10]]));
    const b = rankProjects(new Map([["OPS", 500], ["PRJ", 1]]));
    expect(a.colorOf("PRJ")).toEqual(b.colorOf("PRJ"));
    expect(a.colorOf("OPS")).toEqual(projectColor("OPS"));
  });

  it("spreads keys over the tones", () => {
    const keys = ["PRJ", "OPS", "WEB", "API", "INFRA", "SUP", "DEV", "QA", "HR", "MKT"];
    expect(new Set(keys.map(k => projectColor(k).fill)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("rankProjects", () => {
  it("names the top five, sums the rest as Other, counts them all", () => {
    const totals = new Map(["A", "B", "C", "D", "E", "F", "G"].map((k, i) => [k, 70 - i * 10]));
    const { legend, count } = rankProjects(totals);
    expect(legend.map(l => l.project)).toEqual(["A", "B", "C", "D", "E", "Other"]);;
    expect(legend.at(-1)?.seconds).toBe(20 + 10);
    expect(count).toBe(7);
  });
});
