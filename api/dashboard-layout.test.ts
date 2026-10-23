import { describe, expect, it } from "vitest";
import { normalizeDashboardLayout } from "@contracts/dashboard";

describe("the dashboard's layout as saved, with the widgets added since", () => {
  it("a layout saved before the TODO widget keeps its order and visibility, and gains it at the end", () => {
    const saved = [
      { id: "tasks", visible: true },
      { id: "inbox", visible: false },
      { id: "timeline", visible: true },
      { id: "stats", visible: true },
      { id: "summary", visible: true },
      { id: "activity", visible: false },
      { id: "recap", visible: true },
    ];
    const out = normalizeDashboardLayout(saved);
    expect(out.slice(0, 7)).toEqual(saved);
    expect(out[7]).toEqual({ id: "todos", visible: true });
  });

  it("a layout from before the current set starts again from the defaults, the TODO widget among them", () => {
    expect(normalizeDashboardLayout([{ id: "timeline", visible: false }]).map(x => x.id)).toEqual(["inbox", "todos", "timeline", "stats", "summary", "tasks", "activity", "recap"]);
  });
});
