import { describe, expect, it } from "vitest";
import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { keepIssuesOnScreen } from "./ssrQueries";

const ALL = [["issues", "all"], { type: "query" }];
const issue = (connectionId: number, key: string) => ({ connectionId, key, summary: `${key} summary` });

describe("SSR issue list", () => {
  it("sends only the issues the Dashboard shows, stale so the browser fetches the rest", async () => {
    const server = new QueryClient();
    server.setQueryData(ALL, [issue(1, "A-1"), issue(2, "A-1"), issue(1, "B-2"), issue(1, "C-3"), issue(1, "T-9")]);
    server.setQueryData([["worklogs", "list"], { input: { from: "day", to: "next" }, type: "query" }], [{ connectionId: 1, issueKey: "A-1" }]);
    server.setQueryData([["worklogs", "list"], { input: { from: "recent", to: "next" }, type: "query" }], [{ connectionId: 1, issueKey: "B-2" }]);
    await keepIssuesOnScreen(server, [{ connectionId: 1, issueKey: "T-9" }]);

    const browser = new QueryClient();
    hydrate(browser, dehydrate(server));
    const sent = browser.getQueryData<{ connectionId: number; key: string }[]>(ALL) ?? [];
    expect(sent.map(i => `${i.connectionId}:${i.key}`)).toEqual(["1:A-1", "1:B-2", "1:T-9"]);
    expect(browser.getQueryCache().find({ queryKey: ALL, exact: true })?.isStale()).toBe(true);
  });
});
