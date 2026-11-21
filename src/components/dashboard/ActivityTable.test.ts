import { describe, expect, it } from "vitest";
import type { ActivityRow } from "./ActivityTable";
import { ACTIVITY_LIMIT, SORT_DIRECTION, compare, rankActivity } from "./activitySort";

const row = (over: Partial<ActivityRow>): ActivityRow => ({ ...BASE, ...over });
const BASE = { issueKey: "A-1", summary: "", status: "Done", seconds: 60, lastAt: new Date(2026, 0, 1), connectionId: 1, remoteId: "A-1" } as unknown as ActivityRow;

describe("the recent activity table's sorting", () => {
  // aria-sort said "descending" for every column, the names (sorted A→Z) included.
  it("says the direction each column really sorts in", () => {
    const low = { issue: row({ issueKey: "A-1" }), status: row({ status: "Done" }), seconds: row({ seconds: 60 }), last: row({ lastAt: new Date(2026, 0, 1) }) };
    const high = { issue: row({ issueKey: "B-1" }), status: row({ status: "To Do" }), seconds: row({ seconds: 3600 }), last: row({ lastAt: new Date(2026, 5, 1) }) };
    for (const key of Object.keys(SORT_DIRECTION) as (keyof typeof SORT_DIRECTION)[]) {
      const lowFirst = compare(low[key], high[key], key) < 0;
      expect(SORT_DIRECTION[key], key).toBe(lowFirst ? "ascending" : "descending");
    }
  });

  it("ranks by hours among every recent issue, then keeps the first few", () => {
    // Newest first, as the dashboard builds them: the busiest issue is the oldest.
    const rows = Array.from({ length: ACTIVITY_LIMIT + 2 }, (_, n) => row({ issueKey: `A-${n}`, seconds: n === ACTIVITY_LIMIT + 1 ? 99_999 : 60, lastAt: new Date(2026, 0, 30 - n) }));
    const ranked = rankActivity(rows, "seconds");
    expect(ranked).toHaveLength(ACTIVITY_LIMIT);
    expect(ranked[0].issueKey).toBe(`A-${ACTIVITY_LIMIT + 1}`);
    expect(rankActivity(rows, "last")[0].issueKey).toBe("A-0");
  });
});
