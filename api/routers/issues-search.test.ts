import { describe, it, expect } from "vitest";
import { buildSearchJql } from "../issues/search";

describe("buildSearchJql", () => {
  it("detects exact issue keys", () => {
    expect(buildSearchJql("PRJ-123")).toBe("key = PRJ-123");
    expect(buildSearchJql("abc-1")).toBe("key = ABC-1");
  });

  it("falls back to full-text search", () => {
    expect(buildSearchJql("login bug")).toBe('text ~ "login bug" ORDER BY updated DESC');
  });

  it("blanks out JQL / Lucene operators", () => {
    expect(buildSearchJql("a+b (c) [d]: e*? ~f ^g !h & i | j - k {l} \\m")).toBe(
      'text ~ "a b  c   d   e    f  g  h   i   j   k  l   m" ORDER BY updated DESC',
    );
  });

  it("sanitizes quotes in free text", () => {
    expect(buildSearchJql('test "quoted"')).toBe('text ~ "test  quoted " ORDER BY updated DESC');
  });
});
