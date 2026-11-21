import { describe, expect, it } from "vitest";
import { flashTarget } from "./useHashFlash";

describe("the comment or note a link's hash points at", () => {
  it("reads #comment-… and #note-…, decoded", () => {
    expect(flashTarget("#comment-12")).toBe("comment-12");
    expect(flashTarget("#note-a%20b")).toBe("note-a b");
    expect(flashTarget("#other")).toBeNull();
  });

  // A broken escape threw inside the effect and the error boundary replaced the issue page.
  it("keeps a malformed escape as typed instead of throwing", () => {
    expect(flashTarget("#comment-%E0")).toBe("comment-%E0");
  });
});
