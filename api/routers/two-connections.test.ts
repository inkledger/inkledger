import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { jiraSimulator } from "../providers/jira/simulator";

// Two Jira sites, each with its own APP-1.
const one = jiraSimulator("https://one.atlassian.net", "acc-1");
const two = jiraSimulator("https://two.atlassian.net", "acc-2");
one.add("APP-1", "On site one");
two.add("APP-1", "On site two");
/** Site two stops taking its token (revoked there). */
let twoRefuses = false;
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://two.") && twoRefuses) return new Response(JSON.stringify({ errorMessages: ["Unauthorized"] }), { status: 401 });
  return (url.startsWith("https://two.") ? two : one).fetch(input, init);
});

describe("two connections with the same issue key", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let c1 = 0;
  let c2 = 0;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { encrypt } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('two', 'Two', 'admin', ?) RETURNING id", Date.now());
    const conn = async (site: string, account: string) =>
      (
        await q<{ id: number }>(
          "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', ?, ?, ?, ?, ?) RETURNING id",
          u.id,
          site,
          account,
          JSON.stringify({ deployment: "cloud", authType: "basic", username: `${account}@x.it` }),
          encrypt("token"),
          Date.now(),
        )
      )[0].id;
    c1 = await conn("https://one.atlassian.net", "acc-1");
    c2 = await conn("https://two.atlassian.net", "acc-2");
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  it("a sync brings each connection's APP-1, side by side", async () => {
    await caller.issues.sync();
    expect(await q("SELECT connection_id, summary FROM issues WHERE key = 'APP-1' ORDER BY connection_id")).toEqual([
      { connection_id: c1, summary: "On site one" },
      { connection_id: c2, summary: "On site two" },
    ]);
  });

  it("the key alone is ambiguous: a choice, never a guess; with its connection it is that one", async () => {
    const found = await caller.issues.locate({ key: "APP-1" });
    expect(found && "ambiguous" in found && found.candidates.map((c) => c.connectionId).sort()).toEqual([c1, c2].sort());
    await expect(caller.issues.get({ key: "APP-1" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller.issues.get({ key: "APP-1", connectionId: c2 })).summary).toBe("On site two");
  });

  it("a transition and a worklog reach only the Jira of their connection", async () => {
    await caller.issues.transition({ key: "APP-1", connectionId: c2, toStatus: "Done" });
    expect(await q("SELECT connection_id, status FROM issues WHERE key = 'APP-1' ORDER BY connection_id")).toEqual([
      { connection_id: c1, status: "To Do" },
      { connection_id: c2, status: "Done" },
    ]);
    const saved = await caller.worklogs.create({ issueKey: "APP-1", connectionId: c1, seconds: 600, started: "2026-10-14T08:00:00+02:00", comment: "" });
    expect(saved.connectionId).toBe(c1);
    expect(one.worklogs.size).toBe(1);
    expect(two.worklogs.size).toBe(0);
  });

  it("credentials refused by one connection mark only that one to reconnect, naming its service", async () => {
    twoRefuses = true;
    try {
      await expect(caller.issues.get({ key: "APP-1", connectionId: c2 })).resolves.toBeTruthy();
      await expect(caller.issues.transitions({ key: "APP-1", connectionId: c2 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("Jira") });
      expect(await q("SELECT id, status FROM connections ORDER BY id")).toEqual([
        { id: c1, status: "ok" },
        { id: c2, status: "auth_failed" },
      ]);
    } finally {
      twoRefuses = false;
      await q("UPDATE connections SET status = 'ok'");
    }
  });

  it("a reassignment seen on one connection notifies that connection only, and nothing fails", async () => {
    await q("UPDATE issues SET assignee_id = 'someone' WHERE key = 'APP-1' AND connection_id = ?", c2);
    await caller.issues.sync();
    expect(await q("SELECT connection_id, kind, issue_key FROM notifications")).toEqual([{ connection_id: c2, kind: "assigned", issue_key: "APP-1" }]);
    const shown = await caller.notifications.list();
    expect(shown.map((n) => [n.connectionId, n.summary])).toEqual([[c2, "On site two"]]);
    // The same sync again says nothing new.
    await caller.issues.sync();
    expect(await q("SELECT count(*)::int AS n FROM notifications")).toEqual([{ n: 1 }]);
  });

  it("a timer on APP-1 lives on the connection asked for; the key alone is ambiguous", async () => {
    await expect(caller.timers.start({ issueKey: "APP-1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller.timers.start({ issueKey: "APP-1", connectionId: c2 });
    expect(await q("SELECT connection_id, state FROM timers")).toEqual([{ connection_id: c2, state: "running" }]);
    // The same key on the other connection is another issue: the first timer is switched from.
    const r = await caller.timers.start({ issueKey: "APP-1", connectionId: c1 });
    expect(r.switchedFrom).toMatchObject({ issueKey: "APP-1", connectionId: c2 });
    expect(await q("SELECT connection_id, state FROM timers ORDER BY connection_id")).toEqual([
      { connection_id: c1, state: "running" },
      { connection_id: c2, state: "paused" },
    ]);
    expect((await caller.timers.stop({ issueKey: "APP-1", connectionId: c2 })).found).toBe(true);
    // Logging c2's time clears c2's timer and leaves c1's running.
    await caller.worklogs.create({ issueKey: "APP-1", connectionId: c2, seconds: 600, started: "2026-10-14T10:00:00+02:00", comment: "", fromTimer: true });
    expect(await q("SELECT connection_id, state FROM timers")).toEqual([{ connection_id: c1, state: "running" }]);
    await caller.timers.discard({ issueKey: "APP-1", connectionId: c1 });
    expect(await q("SELECT count(*)::int AS n FROM timers")).toEqual([{ n: 0 }]);
  });

  it("a private note belongs to the connection of its issue", async () => {
    await expect(caller.issueNotes.add({ issueKey: "APP-1", body: "which one?" })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller.issueNotes.add({ issueKey: "APP-1", connectionId: c2, body: "only on two" });
    expect(await q("SELECT connection_id, body FROM issue_notes")).toEqual([{ connection_id: c2, body: "only on two" }]);
    expect((await caller.issueNotes.list({ issueKey: "APP-1", connectionId: c2 })).map((n) => n.body)).toEqual(["only on two"]);
    expect(await caller.issueNotes.list({ issueKey: "APP-1", connectionId: c1 })).toEqual([]);
  });

  it("favorite and hide touch only the issue on the connection asked for", async () => {
    await caller.issues.toggleFavorite({ key: "APP-1", connectionId: c2 });
    await caller.issues.setHidden({ key: "APP-1", connectionId: c1, hidden: true });
    expect(await q("SELECT connection_id, favorite, hidden FROM issues WHERE key = 'APP-1' ORDER BY connection_id")).toEqual([
      { connection_id: c1, favorite: 0, hidden: 1 },
      { connection_id: c2, favorite: 1, hidden: 0 },
    ]);
    await expect(caller.issues.toggleFavorite({ key: "APP-1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller.issues.reorderFavorites({ items: [{ key: "APP-1", connectionId: c2 }] });
    expect(await q("SELECT connection_id, favorite_rank FROM issues WHERE key = 'APP-1' ORDER BY connection_id")).toEqual([
      { connection_id: c1, favorite_rank: 0 },
      { connection_id: c2, favorite_rank: 1 },
    ]);
    // Facets (statuses, projects) follow the visible lists, as the list itself does.
    expect((await caller.issues.list({ includeDone: true })).statuses.sort()).toEqual(["Done", "To Do"]);
  });

  it("a comment is mine when its author is me on that issue's connection", async () => {
    await caller.issues.addComment({ key: "APP-1", connectionId: c2, text: "from site two" });
    const onTwo = await caller.issues.comments({ key: "APP-1", connectionId: c2 });
    expect(onTwo.map((c) => [c.isMine])).toEqual([[true]]);
    expect(await caller.issues.comments({ key: "APP-1", connectionId: c1 })).toEqual([]);
  });

  it("a priority raised to critical on one connection is news there only", async () => {
    // Reopened earlier in the run: news of an open issue only.
    two.issues.get("APP-1")!.status = { name: "To Do", category: "new" };
    await caller.issues.sync();
    two.issues.get("APP-1")!.priority = "Highest";
    two.issues.get("APP-1")!.updated = new Date(Date.UTC(2026, 9, 20)).toISOString();
    await caller.issues.sync();
    expect(await q("SELECT connection_id, detail FROM notifications WHERE kind = 'priority'")).toEqual([{ connection_id: c2, detail: "Highest" }]);
    expect(await q("SELECT connection_id, priority FROM issues WHERE key = 'APP-1' ORDER BY connection_id")).toEqual([
      { connection_id: c1, priority: "Medium" },
      { connection_id: c2, priority: "Highest" },
    ]);
    await q("DELETE FROM notifications");
  });

  it("reports keep two trackers' APP-1 apart, each with its tracker and project (CSV's last columns)", async () => {
    await q("UPDATE connections SET label = 'Site one' WHERE id = ?", c1);
    await q("UPDATE connections SET label = 'Site two' WHERE id = ?", c2);
    const range = { from: "2026-10-12", to: "2026-10-19" };
    const daily = await caller.reports.daily(range);
    const app1 = daily.issues.filter((r) => r.key === "APP-1");
    expect(app1.map((r) => [r.tracker, r.container, r.connectionId]).sort()).toEqual([
      ["Site one", "APP", c1],
      ["Site two", "APP", c2],
    ]);
    const byIssue = await caller.reports.generate({ ...range, groupBy: "issue" });
    expect(byIssue.rows.filter((r) => r.key === "APP-1")).toHaveLength(2);
  });

  it("one connection syncs alone when asked (Settings → Connections), the other untouched", async () => {
    two.add("APP-9", "Only on site two");
    const before = await q("SELECT count(*)::int AS n FROM issues WHERE connection_id = ?", c1);
    expect(await caller.issues.syncConnection({ id: c2 })).toMatchObject({ synced: expect.any(Number) });
    expect(await q("SELECT key FROM issues WHERE connection_id = ? AND key = 'APP-9'", c2)).toEqual([{ key: "APP-9" }]);
    expect(await q("SELECT count(*)::int AS n FROM issues WHERE connection_id = ?", c1)).toEqual(before);
    await expect(caller.issues.syncConnection({ id: c2, reconcile: true })).resolves.toBeTruthy();
  });

  it("the same issue reached by two logins on one site is one item in the lists", async () => {
    const { encrypt } = await import("../lib/crypto");
    const [{ id: c3 }] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) SELECT user_id, 'jira', base_url, 'acc-3', options, ?, 1 FROM connections WHERE id = ? RETURNING id",
      encrypt("token"),
      c1,
    );
    try {
      await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) SELECT user_id, ?, jira_id, key, summary, status, project_key, project_name, url, synced_at FROM issues WHERE connection_id = ? AND key = 'APP-1'", c3, c1);
      const all = await caller.issues.all({ scope: "all" });
      expect(all.filter((i) => i.key === "APP-1").map((i) => i.connectionId).sort()).toEqual([c1, c2].sort());
    } finally {
      await q("DELETE FROM issues WHERE connection_id = ?", c3);
      await q("DELETE FROM connections WHERE id = ?", c3);
    }
  });
});
