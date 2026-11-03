import { describe, expect, it } from "vitest";
import { hostOf } from "./hostOf";

describe("a link's host", () => {
  it("is read from a well-formed link", () => {
    expect(hostOf("https://docs.example.com/offline-sync")).toBe("docs.example.com");
  });

  // A remote link the server lets through (^https?://) but URL refuses: once enough to blank the issue page.
  it("is none for what only looks like a link, without throwing", () => {
    expect(hostOf("https://")).toBeNull();
    expect(hostOf("http://a b")).toBeNull();
    expect(hostOf("not a link")).toBeNull();
  });
});
