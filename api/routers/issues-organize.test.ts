import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** Raw SQL on the test database (Postgres, "?" placeholders). */
const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const jiraIssue = (
  key: string,
  created: string,
  extra: { assignee?: string; updated?: string; statuscategorychangedate?: string } = {},
) => ({
  id: key,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: "To Do", statusCategory: { key: "new" } },
    project: {
      key: key.split("-")[0],
      name: "P",
      avatarUrls: { "48x48": `${SITE}/secure/projectavatar?pid=1` },
    },
    assignee: { accountId: extra.assignee ?? "acc-1" },
    created,
    updated: extra.updated ?? created,
    statuscategorychangedate: extra.statuscategorychangedate,
  },
});

const DEFAULT_ASSIGNED = () => [
  jiraIssue("A-1", "2026-01-01T10:00:00.000+0100"),
  jiraIssue("A-2", "2026-10-01T10:00:00.000+0200"),
];
/** What "assignee = currentUser()" returns; tests may swap it. */
let assigned = DEFAULT_ASSIGNED();
type Activity = {
  id: string;
  key: string;
  fields: { comment?: { comments?: { created: string; author: { accountId: string } }[] } };
  changelog?: { histories?: { created: string; author?: { accountId: string }; items: { field: string }[] }[] };
};
const DEFAULT_ACTIVITY = (): Activity[] => [
  {
    id: "A-1",
    key: "A-1",
    fields: {
      comment: {
        comments: [
          { created: "2026-10-14T09:00:00.000+0200", author: { accountId: "someone" } },
          // my own comments count too: any event needs the issue on top
          { created: "2026-10-15T09:00:00.000+0200", author: { accountId: "acc-1" } },
        ],
      },
    },
    changelog: {
      histories: [
        { created: "2026-10-10T12:00:00.000+0200", items: [{ field: "status" }] },
        { created: "2026-10-16T08:00:00.000+0200", items: [{ field: "assignee" }] },
      ],
    },
  },
];
/** Comments / changelog of the open assigned issues; tests may swap it. */
let activity = DEFAULT_ACTIVITY();
/** Issues Jira knows by key but no longer assigns to me. */
const elsewhere = new Map<string, ReturnType<typeof jiraIssue>>();
/** Keys a successful "key in (…)" search silently leaves out (index lag). */
const batchOmits = new Set<string>();

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${SITE}/secure/projectavatar?avatarId=10324`) {
      return new Response('<svg id="Default" xmlns="http://www.w3.org/2000/svg"/>', {
        headers: { "content-type": "image/svg+xml" },
      });
    }
    if (url === `${SITE}/secure/projectavatar?pid=1`) {
      return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
        headers: { "content-type": "image/svg+xml;charset=UTF-8" },
      });
    }
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    // the activity search must ask for comments and the changelog
    if (url.includes("/search/jql") && url.includes("fields=comment") && url.includes("expand=changelog")) {
      return json({ isLast: true, issues: activity });
    }
    const single = /\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\?fields=/.exec(url);
    if (single) {
      const found = elsewhere.get(single[1]);
      return found ? json(found) : json({ errorMessages: ["Issue does not exist"] }, 404);
    }
    if (url.includes("/search/jql")) {
      const jql = new URL(url).searchParams.get("jql") ?? "";
      const keys = /^key (?:in \((.*)\)|= (\S+))$/.exec(jql);
      if (keys) {
        const wanted = (keys[1] ?? keys[2]).split(",");
        // like Jira: one unknown key fails the whole query
        if (wanted.some((k) => !elsewhere.has(k))) return json({ errorMessages: ["unknown key"] }, 400);
        return json({ isLast: true, issues: wanted.filter((k) => !batchOmits.has(k)).map((k) => elsewhere.get(k)) });
      }
      return json({ isLast: true, issues: assigned });
    }
    return json({ errorMessages: [`unmocked ${url}`] });
  }),
);

type Seed = {
  key: string;
  category?: string;
  assignee?: string;
  favorite?: number;
  hidden?: number;
};

describe("issues: focused views, hidden, favorite order, activity", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let seed: (rows: Seed[]) => Promise<void>;
  let raw: (sql: string) => Promise<unknown[]>;
  let cookie = "";
  let app: typeof import("../boot").default;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    app = (await import("../boot")).default;
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
    raw = (sql) => conn.q(sql);
    seed = async (rows) => {
      await conn.q("DELETE FROM issues");
      for (const r of rows) {
        await conn.q(
          `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, category, project_key, project_name,
             assignee_id, favorite, hidden, url, synced_at)
           VALUES (?, ?, ?, ?, 'x', ?, ?, 'P', 'P', ?, ?, ?, 'u', 0)`,
          ctx.user!.id, r.key, r.key, r.key, r.category ?? "To Do", r.category === "Done" ? "done" : "todo", r.assignee ?? "acc-1", r.favorite ?? 0, r.hidden ?? 0,
        );
      }
    };
  });

  const keys = async (input: Parameters<typeof caller.issues.list>[0] = {}) =>
    (await caller.issues.list({ sort: "key", ...input })).issues.map((i) => i.key);

  it("defaults to open issues assigned to me, without hidden ones", async () => {
    await seed([
      { key: "P-1" },
      { key: "P-2", category: "Done" },
      { key: "P-3", assignee: "other" },
      { key: "P-4", hidden: 1 },
    ]);
    expect(await keys()).toEqual(["P-1"]);
    expect(await keys({ includeDone: true })).toEqual(["P-1", "P-2"]);
    expect(await keys({ includeUnassigned: true })).toEqual(["P-1", "P-3"]);
    expect(await keys({ hidden: "only" })).toEqual(["P-4"]);
    // an explicit status wins over "hide done"
    expect(await keys({ status: "x", includeUnassigned: true })).toEqual(["P-1", "P-2", "P-3"]);
    expect((await caller.issues.list()).counts).toEqual({ done: 1, unassigned: 1, hidden: 1, watching: 0 });
  });

  it("hiding drops the favorite and leaves the dashboard counts", async () => {
    await seed([{ key: "P-1", favorite: 1 }, { key: "P-2" }]);
    const r = await caller.issues.setHidden({ key: "P-1", hidden: true });
    expect(r.wasFavorite).toBe(true);
    expect(await raw("SELECT favorite, hidden FROM issues WHERE key = 'P-1'")).toEqual([{ favorite: 0, hidden: 1 }]);
    const stats = await caller.stats.dashboard();
    expect(stats.openIssueCount).toBe(1);
    await caller.issues.setHidden({ key: "P-1", hidden: false });
    expect(await keys()).toEqual(["P-1", "P-2"]);
  });

  it("keeps favorites in manual order; new ones go last", async () => {
    await seed([{ key: "P-1" }, { key: "P-2" }, { key: "P-3" }]);
    for (const k of ["P-2", "P-1", "P-3"]) await caller.issues.toggleFavorite({ key: k });
    const favs = async () => (await caller.issues.all()).filter((i) => i.favorite === 1).map((i) => i.key);
    expect(await favs()).toEqual(["P-2", "P-1", "P-3"]);
    await caller.issues.reorderFavorites({ keys: ["P-3", "P-2", "P-1"] });
    expect(await favs()).toEqual(["P-3", "P-2", "P-1"]);
    expect(await keys({ excludeFavorites: true })).toEqual([]);
  });

  it("orders by the latest comment by others, else status change or creation; sync keeps local flags", async () => {
    await seed([]);
    await caller.issues.sync();
    await caller.issues.toggleFavorite({ key: "A-2" });
    await caller.issues.setHidden({ key: "A-1", hidden: true });
    await caller.issues.setHidden({ key: "A-1", hidden: false });
    await caller.issues.sync();
    // A-1: created in January but commented on Oct 15 → first
    const list = await caller.issues.list({ sort: "activity", excludeFavorites: false });
    expect(list.issues.map((i) => i.key)).toEqual(["A-2", "A-1"]); // favorite pinned first
    const rows = await raw(
      "SELECT key, favorite, last_comment_at, status_changed_at, activity_at FROM issues ORDER BY key",
    ) as {
      key: string;
      favorite: number;
      last_comment_at: number | null;
      status_changed_at: number | null;
      activity_at: number;
    }[];
    expect(rows[0].last_comment_at).toBe(Date.parse("2026-10-15T09:00:00.000+02:00"));
    // status change comes from the changelog (assignee changes are ignored)
    expect(rows[0].status_changed_at).toBe(Date.parse("2026-10-10T12:00:00.000+02:00"));
    expect(rows[0].activity_at).toBeGreaterThan(rows[1].activity_at);
    expect(rows[1].favorite).toBe(1);
  });

  it("serves the Jira project icon through the proxy", async () => {
    // rows from the previous sync carry the project avatar URL
    const res = await app.request("/api/projects/A/avatar", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect((await app.request("/api/projects/A/avatar")).status).toBe(401);
    expect((await app.request("/api/projects/ZZZ/avatar", { headers: { cookie } })).status).toBe(404);
  });

  it("treats Jira's stock project avatar as no icon", async () => {
    (await q("UPDATE issues SET project_key = 'B', project_avatar_url = ? WHERE key = 'A-2'", `${SITE}/secure/projectavatar?avatarId=10324`));
    const res = await app.request("/api/projects/B/avatar", { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("notices a status change between syncs when Jira does not report it", async () => {
    (await q("UPDATE issues SET status = 'In revisione', status_changed_at = NULL WHERE key = 'A-2'"));
    const before = Date.now();
    await caller.issues.sync();
    const [row] = (await q("SELECT status_changed_at AS at FROM issues WHERE key = 'A-2'"));
    expect(row.at).toBeGreaterThanOrEqual(before);
    await caller.issues.sync(); // unchanged status: the time is kept
    const [again] = (await q("SELECT status_changed_at AS at FROM issues WHERE key = 'A-2'"));
    expect(again.at).toBe(row.at);
  });

  const T2030 = Date.parse("2030-01-01T00:00:00.000Z");
  const row = async (key: string) =>
    (await raw(`SELECT * FROM issues WHERE key = '${key}'`))[0] as Record<string, unknown> | undefined;

  it("never moves the status change time backwards", async () => {
    await seed([]);
    await caller.issues.sync();
    (await q("UPDATE issues SET status_changed_at = ?", T2030));
    // Jira reports an older category change (and the row did change: rewritten)
    assigned = [
      jiraIssue("A-1", "2026-01-01T10:00:00.000+0100"),
      jiraIssue("A-2", "2026-10-01T10:00:00.000+0200", {
        updated: "2026-10-14T10:00:00.000+0200",
        statuscategorychangedate: "2020-01-01T10:00:00.000+0100",
      }),
    ];
    await caller.issues.sync();
    expect((await row("A-2"))?.jira_updated_at).toBe(Date.parse("2026-10-14T10:00:00.000+02:00"));
    expect((await row("A-2"))?.status_changed_at).toBe(T2030);
    // the changelog (Oct 10) is older too
    expect((await row("A-1"))?.status_changed_at).toBe(T2030);
    assigned = DEFAULT_ASSIGNED();
  });

  it("leaves unchanged rows alone on sync", async () => {
    await seed([]);
    await caller.issues.sync();
    (await q("UPDATE issues SET summary = 'local' WHERE key = 'A-1'"));
    await caller.issues.sync();
    expect((await row("A-1"))?.summary).toBe("local");
  });

  it("refreshes issues reassigned away or gone from Jira", async () => {
    await seed([]);
    assigned = [
      jiraIssue("AA-1", "2026-01-01T10:00:00.000+0100"),
      jiraIssue("AA-2", "2026-10-01T10:00:00.000+0200"),
    ];
    try {
      await caller.issues.sync();
      await q(`INSERT INTO issues (user_id, jira_id, key, summary, status, project_key, project_name, assignee_id, url, synced_at)
           SELECT user_id, 'ZZ-9', 'ZZ-9', 'deleted', 'x', 'ZZ', 'ZZ', 'acc-1', 'u', 0 FROM issues LIMIT 1`);
      assigned = [jiraIssue("AA-1", "2026-01-01T10:00:00.000+0100")];
      elsewhere.set("AA-2", jiraIssue("AA-2", "2026-10-01T10:00:00.000+0200", { assignee: "someone" }));
      await caller.issues.sync();
      expect((await row("AA-2"))?.assignee_id).toBe("someone");
      expect((await row("ZZ-9"))?.assignee_id).toBe("");
      expect(await keys()).toEqual(["AA-1"]);
      // nothing stale: no lookup at all
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      await caller.issues.sync();
      const after = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .slice(calls)
        .map((c) => String(c[0]));
      expect(after.some((u) => u.includes("key+in") || u.includes("/issue/"))).toBe(false);
    } finally {
      assigned = DEFAULT_ASSIGNED();
      elsewhere.clear();
    }
  });

  it("import of a key Jira does not know is NOT_FOUND; search for it is empty", async () => {
    await expect(caller.issues.import({ key: "nope-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await caller.issues.search({ query: "NOPE-1" })).toEqual({ results: [], failed: [], unsupported: [] });
  });

  it("cleanup keeps hidden issues, issues with a timer and my open issues", async () => {
    await seed([
      { key: "K-1", hidden: 1, category: "Done", assignee: "other" },
      { key: "K-2", assignee: "other" },
      { key: "K-3" },
      { key: "K-4", category: "Done" },
      { key: "K-5", assignee: "other" },
    ]);
    await caller.timers.start({ issueKey: "K-2" });
    const r = await caller.issues.cleanup();
    await caller.timers.discard({ issueKey: "K-2" });
    expect(r).toEqual({ deleted: 2, kept: 3 });
    expect(await raw("SELECT key FROM issues ORDER BY key")).toEqual([{ key: "K-1" }, { key: "K-2" }, { key: "K-3" }]);
  });

  it("toggle counts match what the list would add", async () => {
    await seed([
      { key: "P-1" },
      { key: "P-2", category: "Done" },
      { key: "P-3", assignee: "other" },
      { key: "P-4", category: "Done", assignee: "other" },
      { key: "P-5", hidden: 1 },
      { key: "P-6", favorite: 1, category: "Done" },
    ]);
    const total = async (input: Parameters<typeof caller.issues.list>[0]) =>
      (await caller.issues.list(input)).total;
    for (const base of [
      {},
      { includeDone: true },
      { includeUnassigned: true },
      { excludeFavorites: true },
      { search: "P-2" },
      { search: "P-5" },
    ]) {
      const { counts } = await caller.issues.list(base);
      expect(counts.done, `done ${JSON.stringify(base)}`).toBe(
        (await total({ ...base, includeDone: true })) - (await total({ ...base, includeDone: false })),
      );
      expect(counts.unassigned, `unassigned ${JSON.stringify(base)}`).toBe(
        (await total({ ...base, includeUnassigned: true })) -
          (await total({ ...base, includeUnassigned: false })),
      );
      expect(counts.hidden, `hidden ${JSON.stringify(base)}`).toBe(await total({ ...base, hidden: "only" }));
    }
    expect((await caller.issues.list()).counts).toEqual({ done: 2, unassigned: 1, hidden: 1, watching: 0 });
    expect((await caller.issues.list({ excludeFavorites: true })).counts).toEqual({ done: 1, unassigned: 1, hidden: 1, watching: 0 });
  });

  const unreadKeys = async () =>
    (await caller.issues.all()).filter((i) => i.unread).map((i) => i.key);
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  /** Empty catalog and no successful sync yet: the next sync is the first. */
  const freshStart = async () => {
    (await q("DELETE FROM issues"));
    (await q("DELETE FROM sync_state"));
  };

  it("tracks unread activity: first sync is read, others' activity is not, opening reads it", async () => {
    await freshStart();
    await caller.issues.sync(); // first sync
    expect(await unreadKeys()).toEqual([]);
    // someone else comments later
    activity = [
      { id: "A-2", key: "A-2", fields: { comment: { comments: [{ created: isoAgo(1000), author: { accountId: "someone" } }] } } },
    ];
    try {
      await caller.issues.sync();
      expect(await unreadKeys()).toEqual(["A-2"]);
      const only = await caller.issues.list({ unreadOnly: true, includeDone: true, includeUnassigned: true });
      expect(only.issues.map((i) => i.key)).toEqual(["A-2"]);
      expect(only.issues[0].unread).toBe(true);
      await caller.issues.markSeen({ key: "A-2" });
      expect(await unreadKeys()).toEqual([]);
      // the same comment seen again on the next sync stays read
      await caller.issues.sync();
      expect(await unreadKeys()).toEqual([]);
      expect((await q("SELECT count(*) AS n FROM issues"))[0]).toEqual({ n: 2 });
    } finally {
      activity = DEFAULT_ACTIVITY();
    }
  });

  it("my own comment or status change orders the issue but does not make it unread", async () => {
    await freshStart();
    await caller.issues.sync();
    const at = isoAgo(1000);
    activity = [
      {
        id: "A-2",
        key: "A-2",
        fields: { comment: { comments: [{ created: at, author: { accountId: "acc-1" } }] } },
        changelog: { histories: [{ created: at, author: { accountId: "acc-1" }, items: [{ field: "status" }] }] },
      },
    ];
    try {
      await caller.issues.sync();
      expect(await unreadKeys()).toEqual([]);
      expect((await row("A-2"))?.last_comment_at).toBe(Date.parse(at));
      const ordered = await caller.issues.list({ sort: "activity" });
      expect(ordered.issues[0].key).toBe("A-2");
      // others' status change does
      activity[0].changelog = {
        histories: [{ created: isoAgo(500), author: { accountId: "someone" }, items: [{ field: "status" }] }],
      };
      await caller.issues.sync();
      expect(await unreadKeys()).toEqual(["A-2"]);
    } finally {
      activity = DEFAULT_ACTIVITY();
    }
  });

  it("a newly assigned issue is unread, an imported one is read", async () => {
    await freshStart();
    await caller.issues.sync();
    assigned = [...DEFAULT_ASSIGNED(), jiraIssue("A-3", "2026-03-01T10:00:00.000+0100")];
    elsewhere.set("XX-5", jiraIssue("XX-5", "2026-10-01T10:00:00.000+0200", { assignee: "someone" }));
    try {
      await caller.issues.sync();
      expect(await unreadKeys()).toEqual(["A-3"]);
      await caller.issues.import({ key: "XX-5" });
      expect((await row("XX-5"))).toBeDefined();
      expect(await unreadKeys()).toEqual(["A-3"]);
    } finally {
      assigned = DEFAULT_ASSIGNED();
      elsewhere.clear();
    }
  });

  it("the first sync is the first successful one, not an empty catalog", async () => {
    await freshStart();
    await caller.issues.sync();
    (await q("DELETE FROM issues"));
    // catalog emptied after a successful sync: the issues come back as news
    await caller.issues.sync();
    expect((await unreadKeys()).sort()).toEqual(["A-1", "A-2"]);
  });

  it("refreshes url and project icon even when Jira's updated time is unchanged", async () => {
    await freshStart();
    await caller.issues.sync();
    (await q("UPDATE issues SET url = 'stale', project_avatar_url = NULL WHERE key = 'A-1'"));
    await caller.issues.sync();
    expect((await row("A-1"))?.url).toBe(`${SITE}/browse/A-1`);
    expect((await row("A-1"))?.project_avatar_url).toBe(`${SITE}/secure/projectavatar?pid=1`);
  });

  it("confirms a key missing from the batch search before clearing its assignee", async () => {
    await freshStart();
    await caller.issues.sync();
    await q(`INSERT INTO issues (user_id, jira_id, key, summary, status, project_key, project_name, assignee_id, url, synced_at)
         SELECT user_id, 'QQ-1', 'QQ-1', 'q', 'x', 'Q', 'Q', 'acc-1', 'u', 0 FROM issues LIMIT 1`);
    // the batch search succeeds but leaves QQ-1 out; the direct GET finds it
    elsewhere.set("QQ-1", jiraIssue("QQ-1", "2026-10-01T10:00:00.000+0200", { assignee: "someone" }));
    batchOmits.add("QQ-1");
    try {
      await caller.issues.sync();
      expect((await row("QQ-1"))?.assignee_id).toBe("someone");
      expect((await row("QQ-1"))?.summary).toBe("Issue QQ-1");
    } finally {
      batchOmits.clear();
      elsewhere.clear();
    }
  });
  it("an issue that moved in Jira keeps one row: the new key, its old key an alias, its worklogs and note along", async () => {
    await raw("DELETE FROM issues");
    const moved = (key: string) => ({ ...jiraIssue(key, "2026-10-01T10:00:00.000+0200"), id: "77" });
    assigned = [moved("OLD-1")];
    try {
      await caller.issues.sync();
      await raw("INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) SELECT user_id, 'OLD-1', '9001', 600, 1, 1 FROM issues WHERE key = 'OLD-1'");
      await raw("INSERT INTO issue_notes (user_id, issue_key, body, created_at, updated_at) SELECT user_id, 'OLD-1', 'mine', 1, 1 FROM issues WHERE key = 'OLD-1'");
      assigned = [moved("NEW-1")];
      await caller.issues.sync();
      expect(await raw("SELECT key, jira_id FROM issues WHERE jira_id = '77'")).toEqual([{ key: "NEW-1", jira_id: "77" }]);
      expect(await raw("SELECT a.key FROM item_aliases a JOIN issues i ON i.id = a.item_id WHERE i.key = 'NEW-1'")).toEqual([{ key: "OLD-1" }]);
      expect(await raw("SELECT issue_key FROM worklogs WHERE jira_worklog_id = '9001'")).toEqual([{ issue_key: "NEW-1" }]);
      expect(await raw("SELECT issue_key FROM issue_notes WHERE body = 'mine'")).toEqual([{ issue_key: "NEW-1" }]);
    } finally {
      assigned = DEFAULT_ASSIGNED();
    }
  });
});
