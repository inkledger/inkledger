import { describe, expect, it } from "vitest";
import { diaryDays, diaryInstructions, diaryMarkdown } from "./diary";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

describe("diary: the days of a period, and the same as Markdown for a model", () => {
  const days = diaryDays("2026-10-28", "2026-10-30", {
    notes: [
      { id: "n1", title: "Call MrCall", notedOn: "2026-10-28", body: "Decided: *pilot* in November." },
      { id: "n2", title: "Standup", notedOn: "2026-10-30", body: "x".repeat(50) },
    ],
    worklogs: [
      { issueKey: "APP-1", summary: "Import", seconds: 3600, started: at(28, 9), comment: "parser" },
      { issueKey: "APP-1", summary: "Import", seconds: 1800, started: at(28, 14), comment: "parser" },
      { issueKey: "APP-2", seconds: 7200, started: at(28, 11) },
    ],
    planned: [{ kind: "travel", startsAt: at(29, 8), endsAt: at(29, 12), note: "Milano" }],
    mails: [{ subject: "Offerta", fromName: "Rossi", pinnedAt: at(30, 10), issueKey: "APP-2" }],
  });

  it("each day of the period, with its own notes, time per issue (most first), plans and mails", () => {
    expect(days.map(d => d.day)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(days[0].issues.map(i => [i.issueKey, i.seconds, i.comments])).toEqual([["APP-2", 7200, []], ["APP-1", 5400, ["parser"]]]);
    expect(days[0].loggedSeconds).toBe(12600);
    expect(days[1].planned).toHaveLength(1);
    expect(days[2].mails[0].subject).toBe("Offerta");
  });

  it("Markdown: a section per day with something in it, notes cut when long (and said)", () => {
    const md = diaryMarkdown(days, { noteChars: 20 });
    expect(md).toMatch(/^## 2026-10-28\n\n### Note: Call MrCall\n\nDecided: \*pilot\* in/);
    expect(md).toContain("- APP-1 Import: 1 h 30 min\n  - parser");
    expect(md).toContain("- 08:00–12:00 travel: Milano");
    expect(md).toContain("[… cut, 30 more characters]");
    expect(md).toContain("- Offerta — Rossi (APP-2)");
  });

  it("the instructions keep to the facts, in the user's language", () => {
    expect(diaryInstructions("timeline", "it", "2026-10-28", "2026-10-30")).toMatch(/chronology of 2026-10-28 to 2026-10-30.*never invent.*Write in Italian\.$/);
  });
});
