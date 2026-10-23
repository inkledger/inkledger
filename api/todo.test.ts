import { describe, expect, it } from "vitest";
import { dayOfToken, parseTodoInput } from "@contracts/todo";

// Friday 23 October 2026, local time.
const today = new Date(2026, 9, 23, 15, 30);

describe("quick capture of a TODO", () => {
  it("takes a day and an issue out of the text", () => {
    expect(parseTodoInput("Chiamare Anna @domani #demo-101", today, "it")).toEqual({
      text: "Chiamare Anna",
      dueOn: "2026-10-24",
      issueKey: "DEMO-101",
      dayToken: "@domani",
      issueToken: "#demo-101",
    });
    expect(parseTodoInput("review #acme/web#12 @today", today, "en")).toMatchObject({ text: "review", dueOn: "2026-10-23", issueKey: "acme/web#12" });
    expect(parseTodoInput("#group/sub/proj#3 fix", today, "en")).toMatchObject({ text: "fix", issueKey: "group/sub/proj#3" });
  });

  it("only the first of each; anything else stays text", () => {
    expect(parseTodoInput("mail @oggi @domani to bob@example.com #A-1 #B-2 #tag", today, "it")).toEqual({
      text: "mail @domani to bob@example.com #B-2 #tag",
      dueOn: "2026-10-23",
      issueKey: "A-1",
      dayToken: "@oggi",
      issueToken: "#A-1",
    });
    expect(parseTodoInput("@nope plain", today, "it")).toMatchObject({ text: "@nope plain", dueOn: null, issueKey: null });
  });

  it("weekdays: the next one, a week on when it is today's", () => {
    expect(dayOfToken("lun", today, "it")).toBe("2026-10-26");
    expect(dayOfToken("venerdì", today, "it")).toBe("2026-10-30");
    expect(dayOfToken("thu", today, "en")).toBe("2026-10-29");
    expect(dayOfToken("Sunday", today, "en")).toBe("2026-10-25");
    expect(dayOfToken("dopodomani", today, "it")).toBe("2026-10-25");
  });

  it("dates as each language writes them; a day already past is next year's; never an impossible one", () => {
    expect(dayOfToken("25/10", today, "it")).toBe("2026-10-25");
    expect(dayOfToken("10/25", today, "en")).toBe("2026-10-25");
    expect(dayOfToken("3/1", today, "it")).toBe("2027-01-03");
    expect(dayOfToken("23/10", today, "it")).toBe("2026-10-23");
    expect(dayOfToken("31.12.27", today, "it")).toBe("2027-12-31");
    expect(dayOfToken("2026-11-02", today, "it")).toBe("2026-11-02");
    expect(dayOfToken("30/02", today, "it")).toBeNull();
    expect(dayOfToken("29/02/2027", today, "it")).toBeNull();
    expect(dayOfToken("29/02", new Date(2027, 2, 1), "it")).toBe("2028-02-29");
    expect(dayOfToken("29/2", new Date(2027, 11, 1), "it")).toBe("2028-02-29");
    expect(dayOfToken("2026-02-30", today, "it")).toBeNull();
  });
});
