import { describe, expect, it } from "vitest";
import type { DiaryDay } from "@contracts/diary";
import { diaryText } from "./diary";

const day = (n: number, comment: string): DiaryDay => ({
  day: `2026-10-${String(n).padStart(2, "0")}`,
  notes: [],
  issues: [{ issueKey: `APP-${n}`, summary: "Work", seconds: 3600, comments: [comment] }],
  loggedSeconds: 3600,
  planned: [],
  mails: [],
});

describe("the diary sent to a model", () => {
  it("drops whole days from the end when the days alone exceed the budget, and says so", () => {
    const days = Array.from({ length: 30 }, (_, index) => day(index + 1, "x".repeat(1_500)));
    const { markdown, cut } = diaryText(days);
    expect(cut).toBe(true);
    expect(markdown.length).toBeLessThanOrEqual(28_000);
    expect(markdown.endsWith("[… later days cut]")).toBe(true);
    // Every day kept is whole: its comment is all there.
    const kept = markdown.split("\n").filter(line => line.startsWith("  - "));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every(line => line === `  - ${"x".repeat(1_500)}`)).toBe(true);
  });

  it("never cuts inside a character", () => {
    // One of the two offsets puts the budget between the two halves of an emoji.
    for (const lead of ["", "a"]) {
      const { markdown } = diaryText([day(1, lead + "\u{1F600}".repeat(20_000))]);
      expect(markdown.length).toBeLessThanOrEqual(28_000);
      const last = markdown.charCodeAt(markdown.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
