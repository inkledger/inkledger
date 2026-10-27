import { describe, expect, it } from "vitest";
import { GRACE_MS, screensaverKey } from "./exit";

describe("screensaverKey", () => {
  it("ignores ordinary keys during the opening grace period", () => {
    expect(screensaverKey("t", 0)).toBe("ignore");
    expect(screensaverKey("Escape", GRACE_MS - 1)).toBe("ignore");
  });

  it("closes on any ordinary key after the grace period", () => {
    expect(screensaverKey("t", GRACE_MS)).toBe("close");
    expect(screensaverKey("Escape", GRACE_MS + 1)).toBe("close");
  });

  it("uses arrows to navigate scenes without closing", () => {
    expect(screensaverKey("ArrowLeft", 0)).toBe("prev");
    expect(screensaverKey("ArrowRight", GRACE_MS + 1)).toBe("next");
  });
});
