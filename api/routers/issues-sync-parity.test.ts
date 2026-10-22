// A Jira sync's issues, scenario by scenario, as they end in the database (every column
// but the row id) with their notifications, under a fixed clock. The snapshot was written
// by the one-by-one upsert (before the residuals mini-wave); the batched one ends the same.
import { jiraSignIn } from "../testing/signIn";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";


vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let tick = 0;
const jiraIssue = (key: string, assignee = "acc-1", status = "To Do") => ({
  id: key,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: status, statusCategory: { key: status === "To Do" ? "new" : "indeterminate" } },
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
/** Jira answering the searches (assigned, by key) with every issue twice. */
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
      if (jql.startsWith("assignee = currentUser() ORDER BY")) return json({ isLast: true, issues: twice.on ? [...assigned, ...assigned] : assigned });
    }
    return json({ errorMessages: [`unmocked ${url}`] }, 500);
  }),
);

describe("a Jira sync's issues", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  const raw = async <T,>(sql: string, ...params: unknown[]) => (await import("../queries/connection")).q<T>(sql, ...params);
  const T0 = Date.UTC(2026, 9, 20, 8);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });
  afterAll(() => vi.useRealTimers());

  const state = async () => ({
    issues: (await raw<Record<string, unknown>>("SELECT * FROM issues ORDER BY jira_id")).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id"))),
    notifications: (await raw<Record<string, unknown>>("SELECT kind, issue_key, detail, dedupe, created_at FROM notifications ORDER BY dedupe")),
  });

  it("first sync, then status changes seen and not, a new issue, one reassigned to me, a moved key, issues returned twice", async () => {
    assigned = [jiraIssue("PA-1"), jiraIssue("PA-2"), jiraIssue("PA-3")];
    await caller.issues.sync();
    const first = await state();
    // The user opens PA-1 and pins PA-3; PX-9 is in the catalog as someone else's (imported).
    vi.setSystemTime(T0 + 60_000);
    await raw("UPDATE issues SET seen_at = ? WHERE key = 'PA-1'", T0 + 60_000);
    await raw("UPDATE issues SET favorite = 1 WHERE key = 'PA-3'");
    await raw(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, assignee_id, url, synced_at) SELECT user_id, connection_id, 'PX-9', 'PX-9', 'Imported', 'To Do', 'PX', 'P', 'someone', 'u', ? FROM issues LIMIT 1",
      T0,
    );
    // Then: PA-1 and PA-2 change status, PA-3 is renamed NEW-3, PA-4 is new, PX-9 is now mine; Jira sends each twice.
    vi.setSystemTime(T0 + 3_600_000);
    const moved = jiraIssue("NEW-3");
    moved.id = "PA-3";
    assigned = [jiraIssue("PA-1", "acc-1", "In Progress"), jiraIssue("PA-2", "acc-1", "In Progress"), moved, jiraIssue("PA-4"), jiraIssue("PX-9")];
    twice.on = true;
    try {
      await caller.issues.sync();
    } finally {
      twice.on = false;
    }
    expect({ first, then: await state() }).toMatchSnapshot();
  });
});
