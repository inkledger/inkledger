import { describe, expect, it } from "vitest";
import { holdsLayout } from "./mutationGuard";

describe("which saves hold a layout change back", () => {
  it("the user's own saves do; the layout's own calls don't", () => {
    expect(holdsLayout([["timers", "start"], { type: "mutation" }])).toBe(true);
    expect(holdsLayout([["worklogs", "create"], { type: "mutation" }])).toBe(true);
    expect(holdsLayout([["workspace", "commit"], { type: "mutation" }])).toBe(false);
  });

  // It beats right after a timer starts: a layout change made then was held back as "being saved".
  it("the timer's background heartbeat doesn't", () => {
    expect(holdsLayout([["timers", "heartbeat"], { type: "mutation" }])).toBe(false);
  });
});
