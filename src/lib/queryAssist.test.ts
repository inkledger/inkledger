import { describe, expect, it } from "vitest";
import { fieldCompletions, togglePreset } from "./queryAssist";

describe("field names offered while typing", () => {
  it("in the user's language first, then the other; none once the name is whole", () => {
    expect(fieldCompletions("login pro", "it")).toEqual(["progetto", "project", "priorità", "priority"].filter(n => n.startsWith("pro")));
    expect(fieldCompletions("-eti", "it")).toEqual(["etichetta"]);
    expect(fieldCompletions("label", "en")).toEqual([]);
    expect(fieldCompletions("project:APP ", "en")).toEqual([]);
  });
});

describe("a quick filter chip", () => {
  it("switches its term on and off, keeping the rest", () => {
    expect(togglePreset("bug", { kind: "me" }, "en")).toBe("bug @me ");
    expect(togglePreset("bug @me", { kind: "me" }, "en")).toBe("bug ");
    expect(togglePreset("@me", { kind: "me" }, "en")).toBe("");
  });

  it("never deletes what the parser could not read", () => {
    const on = togglePreset("updated:nextmonth bug", { kind: "me" }, "en");
    expect(on).toContain("updated:nextmonth");
    expect(on).toContain("@me");
    expect(togglePreset("status: bug", { kind: "me" }, "en")).toContain("status:");
    expect(togglePreset(on, { kind: "me" }, "en").trim().split(" ").sort()).toEqual(["bug", "updated:nextmonth"]);
  });
});
