import { describe, expect, it } from "vitest";
import { pageLabel } from "./navHistory";

describe("pageLabel", () => {
  it("names an issue page by its key, decoded", () => {
    expect(pageLabel("/issues/AB%2D1")).toBe("AB-1");
  });

  // A hand-typed URL with a broken escape crashed the whole app shell.
  it("keeps a malformed escape as typed instead of throwing", () => {
    expect(pageLabel("/issues/%E0")).toBe("%E0");
  });
});
