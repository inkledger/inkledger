import { describe, expect, it } from "vitest";
import { typeSeries } from "./typeSeries";

describe("issue types as chart series", () => {
  it("gives the five types with the most hours the five tones, ties by name, in that order", () => {
    const s = typeSeries([
      { type: "Bug", seconds: 3600 },
      { type: "Attività", seconds: 7200 },
      { type: "Storia", seconds: 3600 },
      { type: "Epic", seconds: 1800 },
      { type: "Task", seconds: 900 },
    ]);
    expect(s.order).toEqual(["Attività", "Bug", "Storia", "Epic", "Task"]);
    expect(s.order.map(k => s.colourOf(k).fill)).toEqual(["bg-chart-focus", "bg-chart-tone-2", "bg-chart-tone-3", "bg-chart-tone-4", "bg-chart-tone-5"]);
  });

  it("sums every other type and No type as Other, in the neutral, last", () => {
    const types = Array.from({ length: 7 }, (_, i) => ({ type: `T${i}`, seconds: 1000 - i }));
    const s = typeSeries([...types, { type: "", seconds: 50 }]);
    const other = s.keyOf("T6");
    expect(s.keyOf("T5")).toBe(other);
    expect(s.keyOf("")).toBe(other);
    expect(s.keyOf(undefined)).toBe(other);
    expect(s.colourOf(other).fill).toBe("bg-chart-other");
    expect(s.colourOf(other).slot).toBe(0);
    expect(s.order).toHaveLength(6);
    expect(s.order.at(-1)).toBe(other);
    expect(s.legend.find(l => l.key === other)?.seconds).toBe(995 + 994 + 50);
    expect(s.nameOf(other)).toMatch(/Other|Altro/);
  });

  it("one type is one series: no split, no Other", () => {
    const s = typeSeries([{ type: "Bug", seconds: 60 }]);
    expect(s.order).toEqual(["Bug"]);
    expect(s.split).toBe(false);
    expect(typeSeries([{ type: "Bug", seconds: 60 }, { type: "", seconds: 5 }]).split).toBe(true);
  });
});
