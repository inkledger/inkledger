import { describe, expect, it } from "vitest";
import { routePattern } from "./feedback";

describe("routePattern: only the shape of a page's path leaves the server", () => {
  it.each([
    ["/", "/"],
    ["/issues", "/issues"],
    ["/issues/ABC-12?q=assignee:me#x", "/issues/:id"],
    ["/issues/7/10042", "/issues/:id/:id"],
    ["/notes/0b0a3c1e-1f6a-4c8e-9d5b-2a7f1c3e9b10", "/notes/:id"],
    ["/settings/store", "/settings/store"],
    ["/info/feedback/12", "/info/feedback/:id"],
    ["/timesheet/2026-11-26", "/timesheet/:id"],
    ["/team/Mario%20Rossi", "/team/:id"],
    ["/issues/desk", "/issues/desk"],
  ])("%s → %s", (path, shape) => expect(routePattern(path)).toBe(shape));
});
