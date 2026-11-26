import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "./notifications";
import { CATEGORY_OF, categoryCounts, groupByIssue, groupSummary, inCategory, inState, nextAfter, type InboxItem } from "./notificationGroups";

const at = (min: number) => new Date(Date.UTC(2026, 10, 26, 10, 0) - min * 60_000);
let id = 0;
const n = (kind: InboxItem["kind"], issueKey: string, ago: number, read = false, connectionId = 1): InboxItem => ({
  id: ++id,
  kind,
  issueKey,
  connectionId,
  createdAt: at(ago),
  readAt: read ? at(0) : null,
});

describe("notification groups", () => {
  it("every kind has one category", () => {
    for (const kind of NOTIFICATION_KINDS) expect(CATEGORY_OF[kind]).toBeTruthy();
    expect(CATEGORY_OF.review).toBe("mentions");
    expect(CATEGORY_OF.unassigned).toBe("assignments");
    expect(CATEGORY_OF.changed).toBe("other");
  });

  it("one group per issue on its connection, newest group first and newest first within", () => {
    const items = [n("commented", "A-1", 30), n("status", "A-1", 5), n("assigned", "B-2", 10), n("commented", "A-1", 20, true), n("mentioned", "A-1", 1, false, 2)];
    const groups = groupByIssue(items);
    expect(groups.map((g) => g.key)).toEqual(["2:A-1", "1:A-1", "1:B-2"]);
    const a1 = groups[1];
    expect(a1.items.map((i) => i.kind)).toEqual(["status", "commented", "commented"]);
    expect(a1.latest.kind).toBe("status");
    expect(a1.unread).toBe(2);
    expect(groupSummary(a1.items)).toEqual([
      { category: "comments", count: 2 },
      { category: "status", count: 1 },
    ]);
  });

  it("summary ties keep the page's category order", () => {
    expect(groupSummary([n("due", "A-1", 1), n("assigned", "A-1", 2), n("mentioned", "A-1", 3)]).map((s) => s.category)).toEqual(["mentions", "assignments", "other"]);
  });

  it("states: unread keeps the groups read while looked at; read the read ones; done all it is given", () => {
    const items = [n("commented", "A-1", 3, true), n("status", "B-1", 2), n("assigned", "C-1", 1, true)];
    expect(inState(items, "unread").map((i) => i.issueKey)).toEqual(["B-1"]);
    expect(inState(items, "unread", new Set(["1:A-1"])).map((i) => i.issueKey)).toEqual(["A-1", "B-1"]);
    expect(inState(items, "read").map((i) => i.issueKey)).toEqual(["A-1", "C-1"]);
    expect(inState(items, "done")).toHaveLength(3);
  });

  it("states take a whole issue: one unread item brings its read ones along, and keeps it out of read", () => {
    const items = [n("commented", "A-1", 3, true), n("status", "A-1", 2), n("assigned", "C-1", 1, true)];
    expect(inState(items, "unread").map((i) => i.kind)).toEqual(["commented", "status"]);
    expect(inState(items, "read").map((i) => i.issueKey)).toEqual(["C-1"]);
  });

  it("categories filter and count the notifications", () => {
    const items = [n("commented", "A-1", 3), n("commented", "A-1", 2), n("review", "B-1", 2), n("watch_added", "C-1", 1), n("unassigned", "D-1", 1)];
    expect(inCategory(items, "comments")).toHaveLength(2);
    expect(inCategory(items, "all")).toHaveLength(5);
    expect(categoryCounts(items)).toEqual({ all: 5, mentions: 1, comments: 2, status: 0, assignments: 1, other: 1 });
  });

  it("the selection moves to the next group, else the one before, else none", () => {
    expect(nextAfter(["a", "b", "c"], "b")).toBe("c");
    expect(nextAfter(["a", "b", "c"], "c")).toBe("b");
    expect(nextAfter(["a"], "a")).toBeNull();
    expect(nextAfter(["a", "b"], "gone")).toBe("a");
    expect(nextAfter([], "gone")).toBeNull();
  });
});
