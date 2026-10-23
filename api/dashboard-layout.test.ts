import { describe, expect, it } from "vitest";
import { normalizeDashboardLayout } from "@contracts/dashboard";

describe("the dashboard's layout as saved, with the widgets added or removed since", () => {
  it("a saved layout keeps its order and visibility, and drops the widgets that left (inbox, TODOs)", () => {
    const saved = [
      { id: "tasks", visible: true },
      { id: "inbox", visible: false },
      { id: "todos", visible: true },
      { id: "timeline", visible: true },
      { id: "stats", visible: true },
      { id: "summary", visible: true },
      { id: "activity", visible: false },
      { id: "recap", visible: true },
    ];
    expect(normalizeDashboardLayout(saved)).toEqual(saved.filter(x => x.id !== "inbox" && x.id !== "todos"));
  });

  it("a layout from before the current set starts again from the defaults", () => {
    expect(normalizeDashboardLayout([{ id: "timeline", visible: false }]).map(x => x.id)).toEqual(["timeline", "stats", "summary", "tasks", "activity", "recap"]);
  });
});
