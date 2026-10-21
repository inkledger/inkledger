import { describe, it, expect } from "vitest";
import { mergeIssueWorklogs, type TeamEntry } from "./issueWorklogs";

const other = (remoteId: string, start: number | null, o: Partial<TeamEntry> = {}): TeamEntry => ({
  remoteId,
  start,
  day: null,
  seconds: 3600,
  comment: "",
  authorName: "Anna",
  mine: false,
  ...o,
});

describe("mergeIssueWorklogs", () => {
  it("puts mine and the others' together, newest first", () => {
    const mine = [{ remoteId: "1", started: new Date(2_000).toISOString() }];
    const rows = mergeIssueWorklogs(mine, [other("2", 3_000), other("3", 1_000)]);
    expect(rows.map(r => (r.kind === "mine" ? `me:${r.log.remoteId}` : `other:${r.entry.remoteId}`))).toEqual(["other:2", "me:1", "other:3"]);
  });

  it("keeps mine from here alone: a tracker entry that is mine or already local is not repeated", () => {
    const mine = [{ remoteId: "1", started: new Date(2_000) }];
    const rows = mergeIssueWorklogs(mine, [other("1", 2_000), other("4", 5_000, { mine: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("mine");
  });

  it("dates a day-only entry by its day", () => {
    const rows = mergeIssueWorklogs([], [other("5", null, { day: "2026-10-20" }), other("6", null, { day: "2026-10-21" })]);
    expect(rows.map(r => (r.kind === "other" ? r.entry.remoteId : ""))).toEqual(["6", "5"]);
  });

  it("without the tracker's list, only mine", () => {
    expect(mergeIssueWorklogs([{ remoteId: "1", started: new Date(0) }], null)).toHaveLength(1);
  });
});
