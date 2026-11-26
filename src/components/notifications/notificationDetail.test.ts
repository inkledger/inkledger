import { describe, expect, it } from "vitest";
import { assignment, commentFor, mentionExcerpt, mentionFor, parseFromTo, statusChange, type HistoryLike } from "./notificationDetail";

const at = Date.UTC(2026, 10, 26, 10, 0);
const note = (kind: string, detail = "", ref: string | null = null) => ({ kind, detail, ref, createdAt: new Date(at) });
const c = (id: string, minAgo: number, body = "Ciao") => ({ id, author: "Anna", body, created: new Date(at - minAgo * 60_000).toISOString() });

describe("what a notification is about", () => {
  it("the comment by its id, else the newest one written before it", () => {
    const comments = [c("3", -5), c("2", 2), c("1", 30)];
    expect(commentFor(note("commented", "", "1"), comments)?.id).toBe("1");
    expect(commentFor(note("commented"), comments)?.id).toBe("2");
    expect(commentFor(note("commented", "", "gone"), comments)?.id).toBe("2");
    expect(commentFor(note("commented"), [])).toBeNull();
  });

  it("the mention: the comment with an @, and the sentence around it", () => {
    const comments = [c("2", 1, "Nothing here."), c("1", 3, "Prima frase. Puoi guardare @mrossi il lotto? Grazie.")];
    expect(mentionFor(note("mentioned"), comments)?.id).toBe("1");
    expect(mentionExcerpt(comments[1].body)).toBe("Puoi guardare @mrossi il lotto?");
    expect(mentionExcerpt("No mention at all. Second.")).toBe("No mention at all.");
    const long = mentionExcerpt(`${"x ".repeat(200)}@me ${"y ".repeat(200)}`, 60);
    expect(long.length).toBeLessThanOrEqual(62);
    expect(long).toContain("@me");
  });

  it("a status change: statuses from the detail, who from the history", () => {
    const events: HistoryLike[] = [
      { kind: "change", at: at - 60_000, author: "Bea", items: [{ key: "status", from: "In corso", to: "Fatto" }] },
      { kind: "change", at: at - 120_000, author: "Carlo", items: [{ key: "status", from: "Da fare", to: "In corso" }] },
    ];
    expect(parseFromTo("Da fare → In corso")).toEqual({ from: "Da fare", to: "In corso" });
    expect(statusChange(note("status", "Da fare → In corso"), events)).toEqual({ from: "Da fare", to: "In corso", author: "Carlo" });
    expect(statusChange(note("status", "Altro → Ancora"), events)).toEqual({ from: "Altro", to: "Ancora", author: null });
    expect(statusChange(note("status"), events)).toEqual({ from: "In corso", to: "Fatto", author: "Bea" });
  });

  it("an assignment: from whom to whom, the newest before it", () => {
    const events: HistoryLike[] = [
      { kind: "change", at: at + 10 * 60_000, author: "Later", items: [{ key: "assignee", from: "Mario Rossi", to: "Anna" }] },
      { kind: "comment", at: at - 1000, author: "x" },
      { kind: "change", at: at - 60_000, author: "Bea", items: [{ key: "assignee", from: null, to: "Mario Rossi" }] },
    ];
    expect(assignment(note("assigned"), events)).toEqual({ from: null, to: "Mario Rossi", author: "Bea" });
    expect(assignment(note("assigned"), [])).toBeNull();
  });
});
