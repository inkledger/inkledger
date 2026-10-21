import { jiraSignIn } from "./testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
process.env.JIRA_READ_ONLY = "1";

/** Raw SQL on the test database (Postgres, "?" placeholders). */
const q: typeof import("./queries/connection").q = async (text, ...params) => (await import("./queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace("Z", "+0000");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const issue = (id: string, key: string) => ({
  id,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: "To Do", statusCategory: { key: "new" } },
    project: { key: "PRJ", name: "Progetto" },
    assignee: { accountId: "acc-2", displayName: "Other" },
  },
});
const wl = (id: string, author: string, startedMs: number, seconds = 3600, issueId?: string) => ({
  id,
  issueId,
  timeSpentSeconds: seconds,
  started: iso(startedMs),
  author: { accountId: author, displayName: author },
  comment: "work",
  updated: iso(Date.now()),
});

const now = Date.now();
/** What the fake Jira holds; tests change it between passes. */
const jira = {
  prj1: [wl("100", "acc-1", now - 2 * DAY), wl("101", "acc-2", now - DAY), wl("102", "acc-1", now - 400 * DAY)],
  updated: [] as { worklogId: number }[],
  deleted: [] as { worklogId: number }[],
  list: [] as ReturnType<typeof wl>[],
  posts: [] as string[],
};

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if (p.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (p.endsWith("/search/jql")) {
      const jql = url.searchParams.get("jql") ?? "";
      return json({ isLast: true, issues: jql.includes("worklogAuthor") ? [issue("10", "PRJ-1")] : [] });
    }
    if (p.endsWith("/issue/PRJ-1/worklog")) return json({ worklogs: jira.prj1, total: jira.prj1.length });
    if (p.endsWith("/worklog/updated")) return json({ values: jira.updated, lastPage: true, until: now + 1000 });
    if (p.endsWith("/worklog/deleted")) return json({ values: jira.deleted, lastPage: true, until: now + 1000 });
    if (p.endsWith("/worklog/list")) {
      jira.posts.push(String(init?.body));
      return json(jira.list);
    }
    if (p.endsWith("/issue/11")) return json(issue("11", "PRJ-2"));
    return json({ errorMessages: [`unmocked ${url.href}`] }, 500);
  }),
);

describe("worklogs from Jira", () => {
  let me: Awaited<ReturnType<typeof login>>;
  let user: import("@db/schema").User;

  async function login() {
    const { appRouter } = await import("./router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("./context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    user = ctx.user!;
    return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  }
  const mine = async () =>
    (await q("SELECT issue_key k, jira_worklog_id id, time_spent_seconds s FROM worklogs ORDER BY id"));

  beforeAll(async () => {
    const conn = await import("./queries/connection");
    await conn.resetDbForTests();
    me = await login();
  });

  it("first run: my worklogs of the last 12 months, with their issue", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const r = await syncWorklogs(user);
    expect(r).toEqual({ imported: 1, deleted: 0, initial: true });
    expect((await mine())).toEqual([{ k: "PRJ-1", id: "100", s: 3600 }]);
    expect((await q("SELECT key FROM issues"))).toEqual([{ key: "PRJ-1" }]);
  });

  it("then only what changed: new (on an issue not in the catalog), edited, deleted — never touching queued edits", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    // A queued offline edit of 100: Jira's copy must not undo it.
    (await q("INSERT INTO outbox (user_id, kind, issue_key, jira_worklog_id, time_spent_seconds, created_at) VALUES (?, 'update', 'PRJ-1', '100', 7200, ?)", user.id, Date.now()));
    jira.updated = [{ worklogId: 100 }, { worklogId: 500 }, { worklogId: 501 }];
    jira.list = [wl("100", "acc-1", now - 2 * DAY, 60, "10"), wl("500", "acc-1", now, 1800, "11"), wl("501", "acc-2", now, 900, "11")];
    const r = await syncWorklogs(user);
    expect(r.initial).toBe(false);
    expect(jira.posts.at(-1)).toBe(JSON.stringify({ ids: [100, 500, 501] }));
    expect((await mine())).toEqual([
      { k: "PRJ-1", id: "100", s: 3600 }, // queued edit wins
      { k: "PRJ-2", id: "500", s: 1800 },
    ]);
    expect((await q("SELECT key FROM issues ORDER BY key"))).toEqual([{ key: "PRJ-1" }, { key: "PRJ-2" }]);

    (await q("DELETE FROM outbox"));
    jira.updated = [];
    jira.deleted = [{ worklogId: 500 }];
    await syncWorklogs(user);
    expect((await mine()).map(w => w.id)).toEqual(["100"]);
  });

  it("«Reimporta» starts over from the last 12 months", async () => {
    jira.deleted = [];
    const r = await me.worklogs.reimport();
    expect(r.initial).toBe(true);
    expect((await mine()).map(w => w.id)).toEqual(["100"]);
  });

  it("deleted here while Jira still has it (its delete on the way): never read back as new", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const { withDeleteReason } = await import("./queries/trash");
    const { sql } = await import("drizzle-orm");
    await withDeleteReason("user", (tx) => tx.execute(sql`DELETE FROM worklogs WHERE jira_worklog_id = '100'`));
    jira.updated = [{ worklogId: 100 }];
    jira.list = [wl("100", "acc-1", now - 2 * DAY, 3600, "10")];
    await syncWorklogs(user);
    expect(await mine()).toEqual([]);
    await me.worklogs.reimport();
    expect(await mine()).toEqual([]);
  });

  it("a worklog still being created (its answer on the way) survives a pass that doesn't see it on Jira; one left by a dead process doesn't", async () => {
    const { CLAIM_TTL_MS } = await import("./sync/timeWrites");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const add = (remoteId: string, syncedAt: number) =>
      q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'PRJ-1', ?, 600, ?, 'creating', ?)", user.id, conn.id, remoteId, now - DAY, syncedAt);
    await add("new-young", Date.now());
    await add("new-dead", Date.now() - CLAIM_TTL_MS - 60_000);
    await me.worklogs.reimport();
    expect((await q<{ id: string }>("SELECT jira_worklog_id id FROM worklogs WHERE comment = 'creating'")).map((r) => r.id)).toEqual(["new-young"]);
    await q("DELETE FROM worklogs WHERE comment = 'creating'");
  });
});
