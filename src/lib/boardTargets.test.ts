import { describe, expect, it } from "vitest";
import { columnOf, dropTargets, reachable, type BoardColumn, type Way } from "./boardTargets";

// A Jira workflow where To Do can go to In Progress only (not straight to Done).
const jiraWays: Way[] = [
  { toStatus: "In Progress", toCategory: "doing", executable: true },
  { toStatus: "Blocked", toCategory: "doing", executable: true },
];
const jiraCard = { connectionId: 1, status: "To Do" };
const ghCard = { connectionId: 2, status: "open" };
const ghWays: Way[] = [{ toStatus: "closed", toCategory: "done", executable: true }];

describe("where a card may go", () => {
  it("in a source's lanes: only its own connection's statuses its workflow reaches", () => {
    const cols: BoardColumn[] = [
      { kind: "status", id: "1:To Do", connectionId: 1, status: "To Do" },
      { kind: "status", id: "1:In Progress", connectionId: 1, status: "In Progress" },
      { kind: "status", id: "1:Done", connectionId: 1, status: "Done" },
      { kind: "status", id: "2:closed", connectionId: 2, status: "closed" },
    ];
    expect([...dropTargets(jiraCard, jiraWays, cols)]).toEqual([["1:In Progress", ["In Progress"]]]);
    // Never onto another tracker's column, even one its own ways would name.
    expect(reachable(jiraCard, [...jiraWays, { toStatus: "closed", toCategory: "done", executable: true }], cols[3])).toEqual([]);
    expect([...dropTargets(ghCard, ghWays, cols)]).toEqual([["2:closed", ["closed"]]]);
  });

  it("by category: the statuses of that category it can reach (more than one: the drop asks)", () => {
    const cols: BoardColumn[] = [
      { kind: "category", id: "todo", category: "todo" },
      { kind: "category", id: "doing", category: "doing" },
      { kind: "category", id: "done", category: "done" },
    ];
    expect([...dropTargets(jiraCard, jiraWays, cols)]).toEqual([["doing", ["In Progress", "Blocked"]]]);
    expect([...dropTargets(ghCard, ghWays, cols)]).toEqual([["done", ["closed"]]]);
  });

  it("custom columns: what each connection maps onto them", () => {
    const cols: BoardColumn[] = [
      { kind: "custom", id: "c1", statuses: { 1: ["To Do"], 2: ["open"] } },
      { kind: "custom", id: "c2", statuses: { 1: ["In Progress", "Done"] } },
      { kind: "custom", id: "c3", statuses: { 1: ["Done"], 2: ["closed"] } },
    ];
    expect([...dropTargets(jiraCard, jiraWays, cols)]).toEqual([["c2", ["In Progress"]]]);
    expect([...dropTargets(ghCard, ghWays, cols)]).toEqual([["c3", ["closed"]]]);
    expect(columnOf({ ...ghCard, category: "todo" }, cols)).toBe("c1");
    expect(columnOf({ connectionId: 3, status: "x", category: "todo" }, cols)).toBeNull();
  });
});
