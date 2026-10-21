import { describe, it, expect } from "vitest";
import { buildTimeline } from "./history";

describe("issue history timeline", () => {
  it("merges changes, comments and creation, newest first, with a reason", () => {
    const t = buildTimeline({
      created: "2026-10-01T09:00:00.000+0200",
      reporter: "Giulia Bianchi",
      histories: [
        {
          created: "2026-10-10T11:00:00.000+0200",
          author: { displayName: "Luca Verdi" },
          items: [
            { field: "status", fromString: "To Do", toString: "In Progress" },
            { field: "assignee", fromString: null, toString: "Mario Rossi" },
          ],
        },
        {
          created: "2026-10-05T10:00:00.000+0200",
          author: { name: "lverdi" },
          items: [{ field: "description", fromString: "x".repeat(500), toString: "y".repeat(500) }],
        },
        { created: "2026-10-04T10:00:00.000+0200", items: [] }, // nothing to show
      ],
      comments: [
        {
          id: "1",
          created: "2026-10-12T15:30:00.000+0200",
          author: { displayName: "Giulia Bianchi" },
          body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Deployed" }] }] },
        },
      ],
    });
    expect(t.events.map((e) => e.kind)).toEqual(["comment", "change", "change", "created"]);
    expect(t.reason).toBe("Comment by Giulia Bianchi");
    const change = t.events[1];
    expect(change).toMatchObject({
      author: "Luca Verdi",
      items: [
        { field: "Status", from: "To Do", to: "In Progress" },
        { field: "Assignee", from: null, to: "Mario Rossi" },
      ],
    });
    // a description diff is summarized, not dumped
    expect(t.events[2]).toMatchObject({ author: "lverdi", items: [{ field: "Description", from: null, to: "updated" }] });
    expect(t.events[3]).toMatchObject({ kind: "created", author: "Giulia Bianchi" });
  });

  it("reason of a status change", () => {
    const t = buildTimeline({
      created: null,
      reporter: null,
      histories: [
        {
          created: "2026-10-10T11:00:00.000+0200",
          author: { displayName: "Luca" },
          items: [{ field: "status", fromString: "In Progress", toString: "In Review" }],
        },
      ],
      comments: [],
    });
    expect(t.reason).toBe("Status: In Progress → In Review by Luca");
  });
});
