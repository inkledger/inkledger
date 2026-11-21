import { describe, expect, it } from "vitest";
import { relativeTime } from "./initials";

describe("relativeTime", () => {
  const now = new Date(2026, 9, 16, 15).getTime();
  const ago = (seconds: number) => relativeTime(new Date(now - seconds * 1000), now);

  it("speaks in whole units, never rounding up to the next one's count", () => {
    expect(ago(59.7 * 60)).toBe("59 minutes ago");
    expect(ago(40 * 3600)).toBe("yesterday");
    expect(ago(3 * 3600)).toBe("3 hours ago");
    expect(ago(10)).toBe("just now");
  });
});
