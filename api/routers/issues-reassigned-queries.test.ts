// Queries of a Jira sync that finds K of the user's issues reassigned to someone else
// (refreshNoLongerAssigned), by K (docs/dev/measuring.md). Counted from the call of
// issues.sync to its return: the whole sync, so what grows with K is the refresh. The
// result is checked too: each issue now someone else's, its local flags kept.
import { jiraSignIn } from "../testing/signIn";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { countQueries } from "../testing/countQueries";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let tick = 0;
const jiraIssue = (key: string, assignee = "acc-1") => ({
  id: key,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: "To Do", statusCategory: { key: "new" } },
    project: { key: key.split("-")[0], name: "P" },
    priority: { name: "Media" },
    assignee: { accountId: assignee },
    duedate: null,
    created: "2026-01-01T10:00:00.000+0100",
    updated: new Date(Date.UTC(2026, 9, 1) + ++tick * 1000).toISOString().replace("Z", "+0000"),
  },
});
type JiraIssue = ReturnType<typeof jiraIssue>;

let assigned: JiraIssue[] = [];
const byKey = new Map<string, JiraIssue>();
/** Jira answering a search by key with every issue twice. */
const twice = { on: false };

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    const single = /\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\?fields=/.exec(url);
    if (single) return byKey.has(single[1]) ? json(byKey.get(single[1])) : json({ errorMessages: ["Issue does not exist"] }, 404);
    if (url.includes("/worklog/updated") || url.includes("/worklog/deleted")) return json({ values: [], lastPage: true, until: Date.now() });
    if (url.includes("/search/jql")) {
      const params = new URL(url).searchParams;
      const jql = params.get("jql") ?? "";
      if (jql.includes("worklogAuthor") || params.get("fields") === "comment") return json({ isLast: true, issues: [] });
      const keys = /^key in \((.*)\)$/.exec(jql);
      if (keys) {
        const found = keys[1].split(",").map((k) => byKey.get(k)).filter(Boolean);
        return json({ isLast: true, issues: twice.on ? [...found, ...found] : found });
      }
      if (jql.startsWith("watcher = currentUser()")) return json({ isLast: true, issues: [] });
      if (jql.includes("assignee was currentUser()")) return json({ isLast: true, issues: [] });
      if (jql.startsWith("assignee = currentUser() ORDER BY")) return json({ isLast: true, issues: assigned });
    }
    return json({ errorMessages: [`unmocked ${url}`] }, 500);
  }),
);

/**
 * Queries of the second sync, by reassigned issues K. Before Wave 2: 22 / 34 / 79 (19 + 3
 * per issue); after it 22 / 26 / 41 (the "unassigned" notifications one by one); now the
 * same at any K.
 */
const MEASURED = { 1: 22, 5: 22, 20: 22 } as const;

describe("a sync that finds K issues reassigned away", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  const raw = async <T,>(sql: string, ...params: unknown[]) => (await import("../queries/connection")).q<T>(sql, ...params);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });

  for (const k of [1, 5, 20] as const) {
    it(`${k} reassigned`, async () => {
      await raw("DELETE FROM issues");
      await raw("DELETE FROM sync_state");
      byKey.clear();
      const keys = Array.from({ length: k }, (_, i) => `RA-${i + 1}`);
      assigned = keys.map((key) => jiraIssue(key));
      await caller.issues.sync();
      await raw("UPDATE issues SET favorite = 1");
      // Now someone else's: not in the assigned search, found by key.
      assigned = [];
      for (const key of keys) byKey.set(key, jiraIssue(key, "someone"));
      await new Promise((r) => setTimeout(r, 2));
      const counter = countQueries();
      try {
        await caller.issues.sync();
        console.info(`[measure] sync with ${k} reassigned: ${counter.n}`);
        expect(counter.n).toBeLessThanOrEqual(MEASURED[k]);
      } finally {
        counter.stop();
      }
      const rows = await raw<{ key: string; assignee_id: string; favorite: number }>("SELECT key, assignee_id, favorite FROM issues ORDER BY key");
      expect(rows).toEqual(keys.sort().map((key) => ({ key, assignee_id: "someone", favorite: 1 })));
    });
  }

  it("field by field as one at a time: a moved key, status time never back, a known rank kept, local flags kept, an issue Jira returns twice", async () => {
    await raw("DELETE FROM issues");
    await raw("DELETE FROM sync_state");
    byKey.clear();
    assigned = ["RB-1", "RB-2", "RB-3"].map((key) => jiraIssue(key));
    await caller.issues.sync();
    await raw("UPDATE issues SET favorite = 1, hidden = 1, status_changed_at = 9999999999999, priority_rank = 3 WHERE key = 'RB-1'");
    await raw("UPDATE issues SET priority_rank = 7 WHERE key = 'RB-2'");
    assigned = [];
    // RB-1 someone else's; RB-2 too, its priority now one Jira ranks unknown; RB-3 moved to NEW-3 (same id).
    byKey.set("RB-1", jiraIssue("RB-1", "someone"));
    const rb2 = jiraIssue("RB-2", "someone");
    rb2.fields.priority = { name: "Unranked" };
    byKey.set("RB-2", rb2);
    const moved = jiraIssue("NEW-3", "someone");
    moved.id = "RB-3";
    byKey.set("RB-3", moved);
    twice.on = true;
    try {
      await new Promise((r) => setTimeout(r, 2));
      await caller.issues.sync();
    } finally {
      twice.on = false;
    }
    const rows = await raw<Record<string, unknown>>("SELECT key, jira_id, assignee_id, favorite, hidden, status_changed_at, priority_rank FROM issues ORDER BY jira_id");
    expect(rows).toEqual([
      { key: "RB-1", jira_id: "RB-1", assignee_id: "someone", favorite: 1, hidden: 1, status_changed_at: 9999999999999, priority_rank: 3 },
      { key: "RB-2", jira_id: "RB-2", assignee_id: "someone", favorite: 0, hidden: 0, status_changed_at: null, priority_rank: 7 },
      { key: "NEW-3", jira_id: "RB-3", assignee_id: "someone", favorite: 0, hidden: 0, status_changed_at: null, priority_rank: null },
    ]);
  });
});
