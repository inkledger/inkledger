// What others did on an issue, read from its history, as notifications: each status
// change with its transition, new comments once per issue, only since the last pass
// and only on issues the app shows; keyed by Jira's ids, so a pass read twice adds nothing.
import { describe, expect, it } from "vitest";
import type { IssueEvent } from "../jira/client";
import { activityNotifications, type IssueSnapshot, type IssueSnapshotRow } from "./notifications";

const row: IssueSnapshotRow = { status: "To Do", assigneeId: "me", priority: "Media", priorityRank: null, statusCategory: "new", category: "todo", dueDate: null, watching: 0 };
const catalog: IssueSnapshot = new Map([
  ["AB-1", row],
  ["AB-2", row],
]);
const of = (entries: [string, IssueEvent[]][]) => new Map(entries.map(([key, events]) => [key, { events }]));

describe("activityNotifications", () => {
  it("one per status change, the transition as detail", () => {
    const out = activityNotifications(
      of([["AB-1", [{ kind: "status", id: "h1", at: 200, from: "Risolto", to: "In lavorazione" }, { kind: "status", id: "h2", at: 300, from: "In lavorazione", to: "Risolto" }]]]),
      catalog,
      7,
      100,
    );
    expect(out).toEqual([
      { connectionId: 7, kind: "status", issueKey: "AB-1", detail: "Risolto → In lavorazione", dedupe: "status:AB-1:h1" },
      { connectionId: 7, kind: "status", issueKey: "AB-1", detail: "In lavorazione → Risolto", dedupe: "status:AB-1:h2" },
    ]);
  });

  it("comments: one per issue, keyed by the newest", () => {
    const out = activityNotifications(
      of([["AB-2", [{ kind: "comment", id: "c1", at: 200 }, { kind: "comment", id: "c2", at: 300 }]]]),
      catalog,
      7,
      100,
    );
    expect(out).toEqual([{ connectionId: 7, kind: "commented", issueKey: "AB-2", detail: "", dedupe: "commented:AB-2:c2" }]);
  });

  it("nothing from before `since`, nothing on issues outside the catalog", () => {
    const out = activityNotifications(
      of([
        ["AB-1", [{ kind: "comment", id: "c1", at: 100 }, { kind: "status", id: "h1", at: 50, from: "A", to: "B" }]],
        ["ZZ-9", [{ kind: "comment", id: "c2", at: 500 }]],
      ]),
      catalog,
      7,
      100,
    );
    expect(out).toEqual([]);
  });
});
