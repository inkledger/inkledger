import { describe, expect, it } from "vitest";
import { isExternalHref, isNative } from "./native";

describe("native bridge", () => {
  it("is off in the browser", () => {
    expect(isNative()).toBe(false);
  });

  it("tells links that leave the app", () => {
    const origin = "https://mac.tail1234.ts.net";
    expect(isExternalHref("https://jira.example.it/browse/DEMO-1", origin)).toBe(true);
    expect(isExternalHref("mailto:a@b.it", origin)).toBe(true);
    expect(isExternalHref("/issues/DEMO-1", origin)).toBe(false);
    expect(isExternalHref("https://mac.tail1234.ts.net/board", origin)).toBe(false);
    expect(isExternalHref("javascript:alert(1)", origin)).toBe(false);
  });
});
