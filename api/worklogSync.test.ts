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
  created: iso(Date.now()),
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
  /** A first import over more issues than one search used to read (5000): 51 pages, the last one new. */
  big: false,
  /** The updated feed never reaching its last page (each page one step further). */
  endlessUpdated: false,
  /** The updated feed saying "more" without moving (a bulk import stamped one instant). */
  stuckUpdated: false,
  /** The issues the worklog search finds (default: PRJ-1). */
  found: null as null | string[],
  /** Where the deleted feed says it reached (default: just after now). */
  deletedUntil: 0,
  /** When the updated feed's entries changed: a pass since a later time doesn't get them (default: every pass does). */
  updatedAt: 0,
  /** Runs while a pass reads the worklogs (something the user does meanwhile). */
  duringList: null as null | (() => Promise<void>),
  /** Where each pass asked the updated feed to start. */
  sinces: [] as number[],
};

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if (p.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (p.endsWith("/search/jql")) {
      const jql = url.searchParams.get("jql") ?? "";
      if (jira.big && jql.includes("worklogAuthor")) {
        const page = Number(url.searchParams.get("nextPageToken") ?? "0");
        return page < 50
          ? json({ isLast: false, nextPageToken: String(page + 1), issues: Array.from({ length: 100 }, () => issue("10", "PRJ-1")) })
          : json({ isLast: true, issues: [issue("19", "PRJ-9")] });
      }
      return json({ isLast: true, issues: jql.includes("worklogAuthor") ? (jira.found ?? ["PRJ-1"]).map((k) => issue(k === "PRJ-1" ? "10" : "12", k)) : [] });
    }
    if (p.endsWith("/issue/PRJ-9/worklog")) return json({ worklogs: [wl("900", "acc-1", now - 3 * DAY)], total: 1 });
    if (p.endsWith("/issue/PRJ-1/worklog")) return json({ worklogs: jira.prj1, total: jira.prj1.length });
    if (p.endsWith("/issue/PRJ-3/worklog")) return json({ worklogs: [], total: 0 });
    // Moved to PRJ-1: Jira answers its old key with the issue it became.
    if (p.endsWith("/issue/OLD-1/worklog")) return json({ worklogs: jira.prj1, total: jira.prj1.length });
    if (p.endsWith("/issue/PRJ-4/worklog")) return json({ errorMessages: ["Issue does not exist"] }, 404);
    if (p.endsWith("/worklog/updated") && jira.stuckUpdated) return json({ values: [], lastPage: false, until: Number(url.searchParams.get("since")) });
    if (p.endsWith("/worklog/updated") && jira.endlessUpdated) {
      const since = Number(url.searchParams.get("since"));
      return json({ values: [], lastPage: false, until: since + 1 });
    }
    if (p.endsWith("/worklog/updated")) jira.sinces.push(Number(url.searchParams.get("since")));
    if (p.endsWith("/worklog/updated")) return json({ values: jira.updatedAt && Number(url.searchParams.get("since")) >= jira.updatedAt ? [] : jira.updated, lastPage: true, until: now + 1000 });
    if (p.endsWith("/worklog/deleted")) return json({ values: jira.deleted, lastPage: true, until: jira.deletedUntil || now + 1000 });
    if (p.endsWith("/worklog/list")) {
      jira.posts.push(String(init?.body));
      const meanwhile = jira.duringList;
      jira.duringList = null;
      await meanwhile?.();
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
    // One audit event for the pass, by sync (never one per worklog).
    const passes = (await q<{ action: string; actor_kind: string; after: string | null; before: string | null }>("SELECT action, actor_kind, after, before FROM audit_events ORDER BY id")).filter((e) => e.action === "worklog.sync");
    expect(passes.map((e) => [e.actor_kind, JSON.parse(e.after ?? "{}") as unknown])).toEqual([["sync", expect.objectContaining({ imported: 1, deleted: 0, initial: true })]]);
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

  /** Where the worklog pass stands (the connection's stream). */
  const checkpoint = async () => {
    const [s] = await q<{ checkpoint: string }>("SELECT checkpoint FROM connection_sync WHERE stream = 'worklogs'");
    return Number(s.checkpoint);
  };

  it("a feed stopped at its page cap holds the checkpoint back: the other feed's later time never skips its rest", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const before = await checkpoint();
    jira.endlessUpdated = true;
    jira.deletedUntil = before + 10_000_000;
    try {
      await syncWorklogs(user);
    } finally {
      jira.endlessUpdated = false;
      jira.deletedUntil = 0;
    }
    const after = await checkpoint();
    // 200 pages of one step each: where the updated feed stopped, not the deleted feed's "now".
    expect(after).toBe(before + 200);
  });

  it("an updated feed that says 'more' without moving steps past that instant: never stuck there for good", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const before = await checkpoint();
    jira.stuckUpdated = true;
    jira.deletedUntil = before + 10_000_000;
    try {
      await syncWorklogs(user);
    } finally {
      jira.stuckUpdated = false;
      jira.deletedUntil = 0;
    }
    const after = await checkpoint();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(before + 10_000_000);
  });

  it("both feeds read to the end: the checkpoint is the earlier clock (the later would skip what changed between the reads)", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    await q("UPDATE connection_sync SET checkpoint = ? WHERE stream = 'worklogs'", String(now - 1000));
    jira.deletedUntil = now + 5_000_000;
    try {
      await syncWorklogs(user);
    } finally {
      jira.deletedUntil = 0;
    }
    expect(await checkpoint()).toBe(now + 1000);
  });

  it("a site-wide deleted feed longer than one statement's parameters still deletes", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    jira.deleted = Array.from({ length: 70_000 }, (_, i) => ({ worklogId: 1_000_000 + i }));
    try {
      await expect(syncWorklogs(user)).resolves.toMatchObject({ deleted: 0 });
    } finally {
      jira.deleted = [];
    }
  });

  it("«Reimporta» drops a copy whose issue the search no longer finds (my last worklog there deleted in Jira)", async () => {
    (await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) SELECT user_id, connection_id, '13', 'PRJ-3', 'Gone', 'To Do', 'PRJ', 'P', 'u', 1 FROM issues WHERE key = 'PRJ-1'"));
    (await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) SELECT user_id, connection_id, 'PRJ-3', '300', 600, ?, '', 1 FROM issues WHERE key = 'PRJ-1'", now - 5 * DAY));
    await me.worklogs.reimport();
    expect((await mine()).map(w => w.id)).toEqual(["100"]);
  });

  it("«Reimporta» keeps a copy the search leaves out while Jira still has it (index lag, archived issue): asked directly", async () => {
    (await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) SELECT user_id, connection_id, '19', 'PRJ-9', 'Lagging', 'To Do', 'PRJ', 'P', 'u', 1 FROM issues WHERE key = 'PRJ-1'"));
    (await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) SELECT user_id, connection_id, 'PRJ-9', '900', 3600, ?, '', 1 FROM issues WHERE key = 'PRJ-1'", now - 3 * DAY));
    // An issue deleted in Jira: its copies go.
    (await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) SELECT user_id, connection_id, 'PRJ-4', '400', 600, ?, '', 1 FROM issues WHERE key = 'PRJ-1'", now - 4 * DAY));
    await me.worklogs.reimport();
    expect((await mine()).map((w) => w.id)).toEqual(["100", "900"]);
    await q("DELETE FROM worklogs WHERE jira_worklog_id = '900'");
  });

  it("a moved issue's copies under its old key go: Jira answers the old key with the same worklogs, counted once", async () => {
    (await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) SELECT user_id, connection_id, 'OLD-1', '100', 3600, ?, '', 1 FROM issues WHERE key = 'PRJ-1'", now - 2 * DAY));
    await me.worklogs.reimport();
    expect(await q<{ key: string; id: string }>("SELECT issue_key AS key, jira_worklog_id AS id FROM worklogs WHERE jira_worklog_id = '100'")).toEqual([{ key: "PRJ-1", id: "100" }]);
  });

  it("a reimport whose search finds nothing still drops copies Jira no longer has", async () => {
    (await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) SELECT user_id, connection_id, 'PRJ-3', '301', 600, ?, '', 1 FROM issues WHERE key = 'PRJ-1'", now - 5 * DAY));
    jira.found = [];
    try {
      await me.worklogs.reimport();
    } finally {
      jira.found = null;
    }
    expect((await q<{ id: string }>("SELECT jira_worklog_id id FROM worklogs WHERE jira_worklog_id = '301'"))).toEqual([]);
    await me.worklogs.reimport();
  });

  it("a first import over more than 5000 issues reads them all (none left out by a cap)", async () => {
    jira.big = true;
    try {
      const r = await me.worklogs.reimport();
      expect(r.initial).toBe(true);
      expect((await mine()).map((w) => w.id)).toEqual(["100", "900"]);
    } finally {
      jira.big = false;
    }
    await q("DELETE FROM worklogs WHERE jira_worklog_id = '900'");
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

  it("a create deleted here whose answer was lost: its entry on Jira is never read back while its delete is queued", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const at = now - 3 * DAY;
    await q(
      "INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, comment, landed_after, landed_before, created_at) VALUES (?, ?, 'delete', 'PRJ-1', '', 1800, ?, 'work', ?, ?, ?)",
      user.id, conn.id, at, Date.now() - 600_000, Date.now() + 300_000, Date.now(),
    );
    // Ours, landed; and one of another length, the user's own.
    jira.updated = [{ worklogId: 600 }, { worklogId: 601 }];
    jira.list = [wl("600", "acc-1", at, 1800, "10"), wl("601", "acc-1", at + 3_600_000, 900, "10")];
    await syncWorklogs(user);
    expect((await mine()).filter((w) => ["600", "601"].includes(w.id as string)).map((w) => w.id)).toEqual(["601"]);
    await q("DELETE FROM outbox");
    await q("DELETE FROM worklogs WHERE jira_worklog_id = '601'");
    jira.updated = [];
    jira.list = [];
  });

  it("a create filed through Tempo, deleted here with its answer lost: Jira's copy is never read back while its delete is queued", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const [tempo] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'tempo', 'https://api.tempo.io', 'acc-1', ?, 'x', 1) RETURNING id", user.id, JSON.stringify({ jiraConnectionId: conn.id }));
    const at = now - 4 * DAY;
    await q(
      "INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, comment, landed_after, landed_before, created_at) VALUES (?, ?, 'delete', 'PRJ-1', '', 1800, ?, 'work', ?, ?, ?)",
      user.id, tempo.id, at, Date.now() - 600_000, Date.now() + 300_000, Date.now(),
    );
    // Tempo's copy on Jira: its note, the issue first.
    jira.updated = [{ worklogId: 620 }];
    jira.list = [{ ...wl("620", "acc-1", at, 1800, "10"), comment: "PRJ-1: Issue PRJ-1\nwork" }];
    await syncWorklogs(user);
    expect((await mine()).filter((w) => w.id === "620")).toEqual([]);
    await q("DELETE FROM outbox");
    await q("DELETE FROM connections WHERE id = ?", tempo.id);
    jira.updated = [];
    jira.list = [];
  });

  it("an entry made on Jira after a lost create's last send could land, or for a delete queued before its sends were kept: read back as any other", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const at = now - 6 * DAY;
    // Sent two hours ago, its last send an hour ago (its window closed since); one with no last send known.
    await q(
      "INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, comment, landed_after, landed_before, created_at) VALUES (?, ?, 'delete', 'PRJ-1', '', 1800, ?, 'work', ?, ?, ?), (?, ?, 'delete', 'PRJ-1', '', 900, ?, 'work', ?, NULL, ?)",
      user.id, conn.id, at, Date.now() - 7_200_000, Date.now() - 3_600_000, Date.now(),
      user.id, conn.id, at + 3_600_000, Date.now() - 600_000, Date.now(),
    );
    // The same time logged on Jira by hand, just now.
    jira.updated = [{ worklogId: 650 }, { worklogId: 651 }];
    jira.list = [wl("650", "acc-1", at, 1800, "10"), wl("651", "acc-1", at + 3_600_000, 900, "10")];
    try {
      await syncWorklogs(user);
      expect((await mine()).filter((w) => ["650", "651"].includes(w.id as string)).map((w) => w.id)).toEqual(["650", "651"]);
    } finally {
      await q("DELETE FROM outbox");
      await q("DELETE FROM worklogs WHERE jira_worklog_id IN ('650', '651')");
      jira.updated = [];
      jira.list = [];
    }
  });

  it("a lost create's delete discarded after a pass left its entry out: the next pass reads it back", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const at = now - 5 * DAY;
    const [tomb] = await q<{ id: number }>(
      "INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, comment, landed_after, landed_before, created_at) VALUES (?, ?, 'delete', 'PRJ-1', '', 1800, ?, 'work', ?, ?, ?) RETURNING id",
      user.id, conn.id, at, Date.now() - 600_000, Date.now() + 300_000, Date.now(),
    );
    jira.updated = [{ worklogId: 640 }];
    jira.list = [wl("640", "acc-1", at, 1800, "10")];
    // Stored on Jira after the create was sent: a pass from later on doesn't see it again.
    jira.updatedAt = Date.now() - 300_000;
    try {
      await syncWorklogs(user);
      expect((await mine()).filter((w) => w.id === "640")).toEqual([]);
      await me.outbox.discard({ id: tomb.id });
      await syncWorklogs(user);
      expect((await mine()).filter((w) => w.id === "640")).toEqual([{ k: "PRJ-1", id: "640", s: 1800 }]);
    } finally {
      await q("DELETE FROM outbox");
      await q("DELETE FROM worklogs WHERE jira_worklog_id = '640'");
      jira.updated = [];
      jira.list = [];
      jira.updatedAt = 0;
    }
  });

  it("a lost create's delete discarded while a pass that left its entry out is running: the next pass still reads it back", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const at = now - 7 * DAY;
    const [tomb] = await q<{ id: number }>(
      "INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, comment, landed_after, landed_before, created_at) VALUES (?, ?, 'delete', 'PRJ-1', '', 1800, ?, 'work', ?, ?, ?) RETURNING id",
      user.id, conn.id, at, Date.now() - 600_000, Date.now() + 300_000, Date.now(),
    );
    jira.updated = [{ worklogId: 660 }];
    jira.list = [wl("660", "acc-1", at, 1800, "10")];
    jira.updatedAt = Date.now() - 300_000;
    // Read from before it landed: this pass sees it, and leaves it out.
    await q("UPDATE connection_sync SET checkpoint = ? WHERE connection_id = ? AND stream = 'worklogs'", String(Date.now() - 900_000), conn.id);
    jira.duringList = async () => void (await me.outbox.discard({ id: tomb.id }));
    try {
      await syncWorklogs(user);
      expect(jira.duringList).toBeNull();
      expect((await mine()).filter((w) => w.id === "660")).toEqual([]);
      await syncWorklogs(user);
      expect((await mine()).filter((w) => w.id === "660")).toEqual([{ k: "PRJ-1", id: "660", s: 1800 }]);
    } finally {
      await q("DELETE FROM outbox");
      await q("DELETE FROM worklogs WHERE jira_worklog_id = '660'");
      jira.updated = [];
      jira.list = [];
      jira.updatedAt = 0;
      jira.duringList = null;
    }
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

  it("one filed through a sink standing in for Jira (Tempo), still waiting there, stays however old: its push isn't lost", async () => {
    const { CLAIM_TTL_MS } = await import("./sync/timeWrites");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const [tempo] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'tempo', 'https://api.tempo.io', 'acc-1', ?, 'x', 1) RETURNING id", user.id, JSON.stringify({ jiraConnectionId: conn.id }));
    const [w] = await q<{ id: number }>(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'PRJ-1', 'new-via-tempo', 600, ?, 'via tempo', ?) RETURNING id",
      user.id, conn.id, now - DAY, Date.now() - CLAIM_TTL_MS - 3_600_000,
    );
    await q("INSERT INTO worklog_sinks (worklog_id, sink_connection_id, state) VALUES (?, ?, 'pending')", w.id, tempo.id);
    // A dead creation still waiting on a sink beside Jira (Harvest), not standing in for it: dropped as before.
    const [harvest] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'harvest', 'https://api.harvestapp.com', 'h', '{}', 'x', 1) RETURNING id", user.id);
    const [dead] = await q<{ id: number }>(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'PRJ-1', 'new-dead-beside', 600, ?, 'beside', ?) RETURNING id",
      user.id, conn.id, now - DAY, Date.now() - CLAIM_TTL_MS - 3_600_000,
    );
    await q("INSERT INTO worklog_sinks (worklog_id, sink_connection_id, state) VALUES (?, ?, 'pending')", dead.id, harvest.id);
    await me.worklogs.reimport();
    expect((await q<{ id: string }>("SELECT jira_worklog_id id FROM worklogs WHERE comment IN ('via tempo', 'beside') ORDER BY comment")).map((r) => r.id)).toEqual(["new-via-tempo"]);
    await q("DELETE FROM worklogs WHERE comment = 'via tempo'");
    await q("DELETE FROM connections WHERE id IN (?, ?)", tempo.id, harvest.id);
  });

  it("in the background, a Jira out of reach waits for its backoff, one refusing the credentials for the user; the user's own sync reads it", async () => {
    const { syncWorklogs } = await import("./worklogSync");
    const fetched = vi.mocked(fetch);
    const [jc] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    try {
      await q("UPDATE connections SET status = 'auth_failed' WHERE id = ?", jc.id);
      fetched.mockClear();
      expect(await syncWorklogs(user, { background: true })).toEqual({ imported: 0, deleted: 0, initial: false });
      expect(fetched).not.toHaveBeenCalled();
      await syncWorklogs(user);
      expect(fetched).toHaveBeenCalled();

      // Out of reach, its wait over: tried again.
      await q("UPDATE connections SET status = 'unreachable' WHERE id = ?", jc.id);
      fetched.mockClear();
      await syncWorklogs(user, { background: true });
      expect(fetched).toHaveBeenCalled();

      await q("UPDATE connections SET status = 'ok' WHERE id = ?", jc.id);
      await q("INSERT INTO connection_sync (connection_id, stream, retry_after) VALUES (?, 'issues', ?) ON CONFLICT (connection_id, stream) DO UPDATE SET retry_after = excluded.retry_after", jc.id, Date.now() + 60_000);
      fetched.mockClear();
      await syncWorklogs(user, { background: true });
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      await q("UPDATE connections SET status = 'ok' WHERE id = ?", jc.id);
      await q("UPDATE connection_sync SET retry_after = NULL WHERE connection_id = ?", jc.id);
    }
  });

  it("a connection from before connections, once migrated, goes on from the user's checkpoint: no reimport, no window lost", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { syncWorklogs } = await import("./worklogSync");
    const [jc] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", user.id);
    const at = now - 5_000;
    // As an upgrade finds it: the user's checkpoint, none of its own.
    await q("UPDATE connections SET legacy = 1 WHERE id = ?", jc.id);
    await q("DELETE FROM connection_sync WHERE connection_id = ? AND stream = 'worklogs'", jc.id);
    await q("INSERT INTO sync_state (user_id, last_worklog_sync_at) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET last_worklog_sync_at = excluded.last_worklog_sync_at", user.id, at);
    const sql = readFileSync(path.resolve(process.cwd(), "drizzle/0047_legacy_connections.sql"), "utf8");
    // Twice: a second run changes nothing.
    for (let i = 0; i < 2; i++) for (const statement of sql.split("--> statement-breakpoint")) await q(statement);
    expect(await q("SELECT legacy FROM connections WHERE id = ?", jc.id)).toEqual([{ legacy: 0 }]);
    expect(await q("SELECT checkpoint, last_ok_at FROM connection_sync WHERE connection_id = ? AND stream = 'worklogs'", jc.id)).toEqual([{ checkpoint: String(at), last_ok_at: at }]);
    jira.sinces = [];
    const r = await syncWorklogs(user);
    expect(r.initial).toBe(false);
    expect(jira.sinces).toEqual([at]);
  });
});
