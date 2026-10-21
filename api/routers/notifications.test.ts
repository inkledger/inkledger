import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const SITE2 = "https://other.atlassian.net";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type IssueOpts = { assignee?: string; priority?: string; due?: string | null; done?: boolean };

/** Jira bumps "updated" on every change: each built issue is newer. */
let tick = 0;
const nextUpdated = () => new Date(Date.UTC(2026, 9, 1) + ++tick * 1000).toISOString().replace("Z", "+0000");

const jiraIssue = (key: string, o: IssueOpts = {}) => ({
  id: key,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: o.done
      ? { name: "Completato", statusCategory: { key: "done" } }
      : { name: "To Do", statusCategory: { key: "new" } },
    project: { key: key.split("-")[0], name: "P" },
    priority: { name: o.priority ?? "Media" },
    assignee: { accountId: o.assignee ?? "acc-1" },
    duedate: o.due ?? null,
    created: "2026-01-01T10:00:00.000+0100",
    updated: nextUpdated(),
  },
});

type JiraIssue = ReturnType<typeof jiraIssue>;

/** "assignee = currentUser()" (full sync) */
let assigned: JiraIssue[] = [];
/** "(assignee = currentUser() OR assignee was currentUser()) AND updated >= …" */
let recent: JiraIssue[] = [];
/** "watcher = currentUser()"; null = Jira error */
let watched: JiraIssue[] | null = [];
/** Issues Jira knows by key (refresh of issues no longer assigned) */
const byKey = new Map<string, JiraIssue>();
/** Every JQL asked, in order */
let jqls: string[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/myself")) {
      const other = url.startsWith(SITE2);
      return json({ accountId: other ? "acc-2" : "acc-1", displayName: "Mario", avatarUrls: {} });
    }
    const single = /\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\?fields=/.exec(url);
    if (single) {
      const found = byKey.get(single[1]);
      return found ? json(found) : json({ errorMessages: ["Issue does not exist"] }, 404);
    }
    // The worklog sync (api/worklogSync.ts): nothing to import here, not recorded.
    if (url.includes("/worklog/updated") || url.includes("/worklog/deleted")) {
      return json({ values: [], lastPage: true, until: Date.now() });
    }
    if (url.includes("/search/jql") && (new URL(url).searchParams.get("jql") ?? "").includes("worklogAuthor")) {
      return json({ isLast: true, issues: [] });
    }
    if (url.includes("/search/jql")) {
      const params = new URL(url).searchParams;
      const jql = params.get("jql") ?? "";
      jqls.push(jql);
      if (params.get("fields") === "comment") return json({ isLast: true, issues: [] });
      const keys = /^key in \((.*)\)$/.exec(jql);
      if (keys) {
        const wanted = keys[1].split(",");
        if (wanted.some((k) => !byKey.has(k))) return json({ errorMessages: ["unknown key"] }, 400);
        return json({ isLast: true, issues: wanted.map((k) => byKey.get(k)) });
      }
      if (jql.startsWith("watcher = currentUser()")) {
        return watched ? json({ isLast: true, issues: watched }) : json({ errorMessages: ["boom"] }, 500);
      }
      if (jql.includes("assignee was currentUser()")) return json({ isLast: true, issues: recent });
      if (jql.startsWith("assignee = currentUser() ORDER BY")) return json({ isLast: true, issues: assigned });
    }
    return json({ errorMessages: [`unmocked ${url}`] }, 500);
  }),
);

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;

describe("notifications, incremental sync, watchers", () => {
  let caller: Caller;
  let other: Caller;
  let userId = 0;
  let raw: <T>(sql: string, ...params: unknown[]) => Promise<T[]>;
  let syncUser: typeof import("./issues").syncUser;
  let user: () => Promise<import("@db/schema").User>;
  let today: (plusDays: number) => string;

  const login = async (site: string) => {
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: site, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    return {
      id: ctx.user!.id,
      caller: appRouter.createCaller({
        req: new Request("http://localhost/"),
        resHeaders: new Headers(),
        user: ctx.user,
        sessionId: ctx.sessionId,
      }),
    };
  };

  const kinds = async () =>
    (await caller.notifications.list()).map((n) => `${n.kind}:${n.issueKey}${n.detail ? `:${n.detail}` : ""}`).sort();

  /** Fresh catalog, first sync done (no notifications), everything dismissed. */
  const freshStart = async (opts: { mine?: JiraIssue[]; watch?: JiraIssue[] } = {}) => {
    await raw("DELETE FROM issues");
    await raw("DELETE FROM notifications");
    await raw("DELETE FROM sync_state");
    assigned = opts.mine ?? [jiraIssue("AB-1"), jiraIssue("AB-2")];
    watched = opts.watch ?? [];
    recent = [];
    byKey.clear();
    await caller.issues.sync();
  };

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const me = await login(SITE);
    caller = me.caller;
    userId = me.id;
    other = (await login(SITE2)).caller;
    raw = <T,>(sql: string, ...params: unknown[]) => conn.q<T>(sql, ...params);
    syncUser = (await import("./issues")).syncUser;
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    user = async () => (await conn.getDb().select().from(users).where(eq(users.id, userId)).limit(1))[0];
    const { dayKey, addDays } = await import("@contracts/time");
    today = (n) => dayKey(addDays(new Date(), n));
  });

  beforeEach(() => {
    jqls = [];
  });

  it("raises nothing on the first sync, only records the watched set", async () => {
    await freshStart({
      mine: [jiraIssue("AB-1", { priority: "Critica", due: today(1) })],
      watch: [jiraIssue("WW-1", { assignee: "someone" })],
    });
    expect(await caller.notifications.list()).toEqual([]);
    expect(await caller.notifications.count()).toEqual({ count: 0, latestId: null });
    // the watched issue is in the catalog, not mine
    expect(await raw("SELECT key, assignee_id, watching FROM issues ORDER BY key")).toEqual([
      { key: "AB-1", assignee_id: "acc-1", watching: 0 },
      { key: "WW-1", assignee_id: "someone", watching: 1 },
    ]);
    expect((await raw<{ at: number | null }>("SELECT last_full_sync_at AS at FROM sync_state"))[0].at).toBeTypeOf("number");
  });

  it("assigned: new issue assigned to me, once per sync that sees it", async () => {
    await freshStart();
    assigned = [...assigned, jiraIssue("AB-3")];
    await caller.issues.sync();
    expect(await kinds()).toEqual(["assigned:AB-3"]);
    await caller.issues.sync();
    expect(await kinds()).toEqual(["assigned:AB-3"]);
  });

  it("unassigned when reassigned away (refresh of stale issues); re-assignment notifies again", async () => {
    await freshStart();
    assigned = [jiraIssue("AB-1")];
    byKey.set("AB-2", jiraIssue("AB-2", { assignee: "someone" }));
    await caller.issues.sync();
    expect(await kinds()).toEqual(["unassigned:AB-2"]);
    // also when Jira does not return it at all (assignee cleared locally)
    await raw("UPDATE issues SET assignee_id = 'acc-1' WHERE key = 'AB-2'");
    byKey.clear();
    await new Promise((r) => setTimeout(r, 2));
    await caller.issues.sync();
    expect((await kinds()).filter((k) => k === "unassigned:AB-2")).toHaveLength(2);
    await caller.notifications.dismissAll();
    await new Promise((r) => setTimeout(r, 2));
    assigned = [jiraIssue("AB-1"), jiraIssue("AB-2")];
    await caller.issues.sync();
    expect(await kinds()).toEqual(["assigned:AB-2"]);
  });

  it("priority: entering the critical set, mine and open only; again after leaving it", async () => {
    await freshStart({ mine: [jiraIssue("AB-1"), jiraIssue("AB-2", { done: true }), jiraIssue("AB-3")] });
    assigned = [
      jiraIssue("AB-1", { priority: "Critica" }),
      jiraIssue("AB-2", { priority: "Bloccante", done: true }),
      jiraIssue("AB-3", { priority: "Alta" }),
    ];
    await caller.issues.sync();
    expect(await kinds()).toEqual(["priority:AB-1:Critica"]);
    // critical → critical: nothing new
    assigned[0] = jiraIssue("AB-1", { priority: "Blocker" });
    await caller.issues.sync();
    expect(await kinds()).toEqual(["priority:AB-1:Critica"]);
    assigned[0] = jiraIssue("AB-1", { priority: "Media" });
    await caller.issues.sync();
    await new Promise((r) => setTimeout(r, 2));
    assigned[0] = jiraIssue("AB-1", { priority: "Critica" });
    await caller.issues.sync();
    expect(await kinds()).toEqual(["priority:AB-1:Critica", "priority:AB-1:Critica"]);
  });

  it("due: within today..today+2, mine and open, one per due date", async () => {
    await freshStart();
    assigned = [
      jiraIssue("AB-1", { due: today(0) }),
      jiraIssue("AB-2", { due: today(2) }),
      jiraIssue("AB-3", { due: today(3) }),
      jiraIssue("AB-4", { due: today(-1) }),
      jiraIssue("AB-5", { due: today(1), done: true }),
    ];
    await caller.issues.sync();
    expect((await kinds()).filter((k) => k.startsWith("due:"))).toEqual([
      `due:AB-1:${today(0)}`,
      `due:AB-2:${today(2)}`,
    ]);
    await caller.notifications.dismissAll();
    await caller.issues.sync();
    expect(await kinds()).toEqual([]);
    // a new due date is news again
    assigned[0] = jiraIssue("AB-1", { due: today(1) });
    await caller.issues.sync();
    expect(await kinds()).toEqual([`due:AB-1:${today(1)}`]);
  });

  it("watchers: added and removed on full syncs; a failing search does not fail the sync", async () => {
    await freshStart({ watch: [jiraIssue("AB-1")] });
    watched = [jiraIssue("AB-1"), jiraIssue("WW-2", { assignee: "someone" })];
    await caller.issues.sync();
    expect(await kinds()).toEqual(["watch_added:WW-2"]);
    expect(await raw("SELECT assignee_id, watching FROM issues WHERE key = 'WW-2'")).toEqual([
      { assignee_id: "someone", watching: 1 },
    ]);
    await caller.notifications.dismissAll();
    watched = [jiraIssue("WW-2", { assignee: "someone" })];
    await caller.issues.sync();
    expect(await kinds()).toEqual(["watch_removed:AB-1"]);
    await caller.notifications.dismissAll();
    watched = null;
    const r = await caller.issues.sync();
    expect(r.full).toBe(true);
    expect(await kinds()).toEqual([]);
    expect(await raw("SELECT key FROM issues WHERE watching = 1")).toEqual([{ key: "WW-2" }]);
  });

  it("first full sync after an upgrade sets watching flags without notifications", async () => {
    await freshStart();
    await raw("UPDATE sync_state SET last_full_sync_at = NULL");
    watched = [jiraIssue("AB-1")];
    await caller.issues.sync();
    expect(await kinds()).toEqual([]);
    expect(await raw("SELECT key FROM issues WHERE watching = 1")).toEqual([{ key: "AB-1" }]);
  });

  it("incremental: updated window only, no reassignment refresh nor watchers", async () => {
    await freshStart({ watch: [jiraIssue("AB-1")] });
    const fullAt = (await raw<{ at: number }>("SELECT last_full_sync_at AS at FROM sync_state"))[0].at;
    jqls = [];
    // AB-2 reassigned away, AB-3 newly mine, OLD-1 was mine long ago (never synced)
    recent = [
      jiraIssue("AB-2", { assignee: "someone" }),
      jiraIssue("AB-3"),
      jiraIssue("OLD-1", { assignee: "someone" }),
    ];
    watched = [];
    const r = await syncUser((await user()), { full: false });
    expect(r.full).toBe(false);
    expect(jqls).toEqual([
      '(assignee = currentUser() OR assignee was currentUser()) AND updated >= "-7m" ORDER BY updated DESC',
      'assignee = currentUser() AND statusCategory != done AND updated >= "-7m"',
    ]);
    expect(await kinds()).toEqual(["assigned:AB-3", "unassigned:AB-2"]);
    expect(await raw("SELECT key FROM issues ORDER BY key")).toEqual([{ key: "AB-1" }, { key: "AB-2" }, { key: "AB-3" }]);
    // watching flags untouched, last full sync unchanged
    expect(await raw("SELECT key FROM issues WHERE watching = 1")).toEqual([{ key: "AB-1" }]);
    expect((await raw<{ at: number }>("SELECT last_full_sync_at AS at FROM sync_state"))[0].at).toBe(fullAt);
  });

  it("full sync: catalog search, stale refresh and watchers", async () => {
    await freshStart();
    jqls = [];
    assigned = [jiraIssue("AB-1")];
    byKey.set("AB-2", jiraIssue("AB-2", { assignee: "someone" }));
    await syncUser((await user()), { full: true });
    expect(jqls).toEqual([
      "assignee = currentUser() ORDER BY updated DESC",
      "key in (AB-2)",
      "watcher = currentUser() ORDER BY updated DESC",
      "assignee = currentUser() AND statusCategory != done",
    ]);
  });

  it("the first sync is full even when an incremental one is asked", async () => {
    await raw("DELETE FROM issues");
    await raw("DELETE FROM notifications");
    await raw("DELETE FROM sync_state");
    assigned = [jiraIssue("AB-1")];
    const r = await syncUser((await user()), { full: false });
    expect(r.full).toBe(true);
    expect(jqls[0]).toBe("assignee = currentUser() ORDER BY updated DESC");
  });

  it("list joins the issue; count; dismiss and dismissAll touch only my rows", async () => {
    await freshStart();
    assigned = [...assigned, jiraIssue("AB-3", { priority: "Alta" })];
    await caller.issues.sync();
    await raw(
      "INSERT INTO notifications (user_id, kind, issue_key, detail, dedupe, created_at) VALUES (?, 'bogus', 'AB-1', '', 'x', ?)",
      userId,
      Date.now() + 1000,
    );
    await raw(
      "INSERT INTO notifications (user_id, kind, issue_key, detail, dedupe, created_at) VALUES (?, 'due', 'GONE-1', '2026-10-16', 'y', ?)",
      userId,
      Date.now() + 2000,
    );
    const list = await caller.notifications.list();
    // unknown kinds are skipped; newest first; a missing issue gives nulls
    expect(list.map((n) => n.issueKey)).toEqual(["GONE-1", "AB-3"]);
    expect(list[0]).toMatchObject({ kind: "due", detail: "2026-10-16", summary: null, priority: null, status: null });
    expect(list[1]).toMatchObject({
      kind: "assigned",
      summary: "Issue AB-3",
      priority: "Alta",
      status: "To Do",
      statusCategory: "To Do",
    });
    expect(list[1].createdAt).toBeInstanceOf(Date);
    const count = await caller.notifications.count();
    // same filter as the list: the unknown kind is not counted
    expect(count.count).toBe(2);
    const maxId = (await raw<{ id: number }>("SELECT max(id) AS id FROM notifications"))[0].id;
    expect(count.latestId).toBe(maxId);

    // another user cannot dismiss mine
    expect(await other.notifications.dismiss({ id: list[0].id })).toEqual({ dismissed: 0 });
    expect(await other.notifications.dismissAll()).toEqual({ dismissed: 0 });
    expect((await caller.notifications.count()).count).toBe(2);

    expect(await caller.notifications.dismiss({ id: list[0].id })).toEqual({ dismissed: 1 });
    expect((await caller.notifications.list()).map((n) => n.issueKey)).toEqual(["AB-3"]);
    expect(await caller.notifications.dismissAll()).toEqual({ dismissed: 2 });
    expect(await caller.notifications.count()).toEqual({ count: 0, latestId: null });
    expect(await other.notifications.list()).toEqual([]);
  });

  it("a watched issue reassigned to me is notified and unread", async () => {
    await freshStart({ watch: [jiraIssue("WW-1", { assignee: "someone" })] });
    const unread = async () => (await caller.issues.all()).filter((i) => i.unread).map((i) => i.key);
    expect(await unread()).toEqual([]);
    await new Promise((r) => setTimeout(r, 2));
    assigned = [...assigned, jiraIssue("WW-1")];
    watched = [jiraIssue("WW-1")];
    await caller.issues.sync();
    expect(await kinds()).toEqual(["assigned:WW-1"]);
    expect(await unread()).toEqual(["WW-1"]);
  });

  it("hidden issues and unknown kinds stay out of list and count; old dismissed are purged", async () => {
    await freshStart();
    await caller.notifications.createTest({ kind: "assigned", issueKey: "AB-1" });
    await caller.notifications.createTest({ kind: "due", issueKey: "AB-2" });
    await raw("INSERT INTO notifications (user_id, kind, issue_key, detail, dedupe, created_at) VALUES (?, 'legacy', 'AB-2', '', 'x', ?)", userId, Date.now());
    await raw("UPDATE issues SET hidden = 1 WHERE key = 'AB-1'");
    expect(await kinds()).toEqual([`due:AB-2:${today(0)}`]);
    expect((await caller.notifications.count()).count).toBe(1);
    const { purgeDismissedNotifications } = await import("./notifications");
    await caller.notifications.dismissAll();
    expect(await purgeDismissedNotifications()).toBe(0);
    expect(await purgeDismissedNotifications(Date.now() + 31 * 24 * 3600 * 1000)).toBe(3);
  });

  it("createTest: local only, defaults to an open visible issue, goes through list/count", async () => {
    await freshStart({ mine: [jiraIssue("AB-1", { done: true }), jiraIssue("AB-2")] });
    await raw("UPDATE issues SET hidden = 1 WHERE key = 'AB-1'");
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(await caller.notifications.createTest({ kind: "assigned" })).toEqual({ issueKey: "AB-2" });
    const [n] = await caller.notifications.list();
    expect(n).toMatchObject({ kind: "assigned", issueKey: "AB-2", summary: "Issue AB-2" });
    expect(await caller.notifications.count()).toEqual({ count: 1, latestId: n.id });
    await caller.notifications.createTest({ kind: "priority", issueKey: " ab-9 " });
    expect(await kinds()).toEqual(["assigned:AB-2", "priority:AB-9:Critica"]);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    expect((await other.notifications.count()).count).toBe(0);
    await caller.notifications.dismissAll();
    expect((await caller.notifications.count()).count).toBe(0);
    await expect(caller.notifications.createTest({ kind: "due", issueKey: "nope" })).rejects.toThrow();
  });
});
