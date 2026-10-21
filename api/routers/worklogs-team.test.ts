import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** TEAM-1 on Jira: one hour of mine, an hour and a half of Anna's. */
const remote = [
  { id: "wl-1", started: "2026-10-20T08:00:00.000+0200", timeSpentSeconds: 3600, created: "2026-10-20T09:00:00.000+0200", author: { accountId: "acc-1", displayName: "Mario" } },
  { id: "wl-2", started: "2026-10-21T08:00:00.000+0200", timeSpentSeconds: 5400, created: "2026-10-21T09:30:00.000+0200", author: { accountId: "acc-2", displayName: "Anna" } },
];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (/\/issue\/TEAM-1\/worklog(\?.*)?$/.test(url) && method === "GET") return json({ worklogs: remote, total: remote.length, startAt: 0, maxResults: 1000 });
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

describe("everyone's time on an issue", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
    const [c] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ?", ctx.user!.id);
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, labels, assignee_id, time_spent_seconds, url, synced_at) VALUES (?, ?, '10001', 'TEAM-1', 'Shared', 'To Do', 'TEAM', 'Team', '[]', 'acc-1', 9000, 'u', 1)",
      ctx.user!.id,
      c.id,
    );
    await caller.worklogs.syncIssue({ issueKey: "TEAM-1" });
  });

  it("imports only mine", async () => {
    expect((await caller.worklogs.list({ issueKey: "TEAM-1" })).map((w) => w.remoteId)).toEqual(["wl-1"]);
  });

  it("lists everyone's from the tracker: mine marked, the others' with their author", async () => {
    const team = await caller.worklogs.team({ issueKey: "TEAM-1" });
    expect(team?.totalSeconds).toBe(9000);
    expect(team?.entries.map((e) => ({ id: e.remoteId, mine: e.mine, author: e.authorName, seconds: e.seconds }))).toEqual([
      { id: "wl-1", mine: true, author: "Mario", seconds: 3600 },
      { id: "wl-2", mine: false, author: "Anna", seconds: 5400 },
    ]);
    expect(team?.entries[1].start).toBe(Date.parse("2026-10-21T08:00:00.000+02:00"));
  });

  it("the issue list says my time beside the tracker's total", async () => {
    const list = await caller.issues.list({ includeUnassigned: true });
    const row = list.issues.find((i) => i.key === "TEAM-1");
    expect(row).toMatchObject({ mySpentSeconds: 3600, timeSpentSeconds: 9000 });
  });
});
