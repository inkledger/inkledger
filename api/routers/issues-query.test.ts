import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("issues.list speaks the query language", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let caller: Caller;
  const DAY = 86_400_000;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('m', 'M', ?) RETURNING id", Date.now());
    const conn = async (type: string, host: string, label: string, me: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, label, encrypted_secret, created_at) VALUES (?, ?, ?, ?, ?, 'x', ?) RETURNING id", u.id, type, `https://${host}`, me, label, Date.now()))[0].id;
    const jira = await conn("jira", "acme.atlassian.net", "Acme", "me-jira");
    const gh = await conn("github", "api.github.com", "", "me-gh");
    const now = Date.now();
    const issue = (c: number, key: string, o: { summary: string; project: string; status?: string; category?: string; rank?: number | null; labels?: string[]; assignee?: string; assigneeName?: string; reporter?: string; updatedDaysAgo?: number; watching?: number; due?: string }) =>
      q(
        `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, priority_rank, project_key, project_name, labels, assignee_id, assignee_name, reporter_name, jira_updated_at, jira_created_at, watching, due_date, url, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        u.id, c, `id-${key}`, key, o.summary, o.status ?? "To Do", o.category ?? "todo", o.rank ?? null, o.project, o.project,
        JSON.stringify(o.labels ?? []), o.assignee ?? "me-jira", o.assigneeName ?? "Mario", o.reporter ?? "Anna",
        now - (o.updatedDaysAgo ?? 0) * DAY, now - 30 * DAY, o.watching ?? 0, o.due ?? null, `https://x/${key}`, now,
      );
    await issue(jira, "APP-1", { summary: "Login fails on Safari", project: "APP", rank: 1, labels: ["bug"], updatedDaysAgo: 1 });
    await issue(jira, "APP-2", { summary: "Export to CSV", project: "APP", status: "In corso", category: "doing", rank: 2, updatedDaysAgo: 20, due: "2020-01-01" });
    await issue(jira, "APP-3", { summary: "Old login page", project: "APP", status: "Fatto", category: "done", rank: 0 });
    await issue(jira, "OPS-1", { summary: "Rotate keys", project: "OPS", assignee: "anna", assigneeName: "Anna Bianchi", reporter: "Mario", watching: 1, rank: 3 });
    await issue(gh, "acme/web#4", { summary: "Login button misaligned", project: "acme/web", assignee: "me-gh", labels: ["ui"] });
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (?, ?, 'APP-2', 'w1', ?, 3600, '', ?)", u.id, jira, now, now);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const find = async (search: string) => {
    const r = await caller.issues.list({ search, sort: "key" });
    return { keys: r.issues.map((i) => i.key), query: r.query };
  };

  it("finds words in titles and keys, across trackers; my open issues by default", async () => {
    expect((await find("login")).keys).toEqual(["APP-1", "acme/web#4"]);
    expect((await find("login safari")).keys).toEqual(["APP-1"]);
    expect((await find("app-2")).keys).toEqual(["APP-2"]);
    expect((await find("acme/web#4")).keys).toEqual(["acme/web#4"]);
    // A pasted link: by the key it points at, or by the issue's own URL.
    expect((await find("https://acme.atlassian.net/browse/APP-2")).keys).toEqual(["APP-2"]);
    expect((await find("https://github.com/acme/web/issues/4")).keys).toEqual(["acme/web#4"]);
  });

  it("ranks titles holding every word before matches by key only, whatever the order chosen", async () => {
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, labels, assignee_id, url, synced_at) SELECT user_id, connection_id, 'id-ZZZ-1', 'ZZZ-1', 'Ops handover', 'To Do', 'todo', 'ZZZ', 'ZZZ', '[]', 'me-jira', 'https://x/ZZZ-1', 1 FROM issues WHERE key = 'APP-1'");
    try {
      expect((await caller.issues.list({ search: "ops", sort: "key", includeUnassigned: true })).issues.map((i) => i.key)).toEqual(["ZZZ-1", "OPS-1"]);
      expect((await caller.issues.list({ search: "ops", sort: "key", includeUnassigned: true, favoriteOnly: true })).issues).toEqual([]);
    } finally {
      await q("DELETE FROM issues WHERE key = 'ZZZ-1'");
    }
  });

  it("a query that names states or people decides that itself", async () => {
    expect((await find("login cat:closed")).keys).toEqual(["APP-3"]);
    expect((await find("login is:closed OR is:open login")).keys).toEqual(["APP-1", "APP-3", "acme/web#4"]);
    expect((await find("assignee:anna")).keys).toEqual(["OPS-1"]);
    expect((await find("è:osservata")).keys).toEqual(["OPS-1"]);
    expect((await find("@me project:APP")).keys).toEqual(["APP-1", "APP-2"]);
  });

  it("filters by project, source, status, label, priority and dates, in either language", async () => {
    expect((await find("progetto:APP -etichetta:bug")).keys).toEqual(["APP-2"]);
    expect((await find("in:github")).keys).toEqual(["acme/web#4"]);
    expect((await find("fonte:Acme")).keys).toEqual(["APP-1", "APP-2"]);
    expect((await find('stato:"in corso"')).keys).toEqual(["APP-2"]);
    expect((await find("priority>=high")).keys).toEqual(["APP-1"]);
    expect((await find("priorità:<alta")).keys).toEqual(["APP-2"]);
    expect((await find("updated:7d project:APP")).keys).toEqual(["APP-1"]);
    expect((await find("aggiornata:<7g project:APP")).keys).toEqual(["APP-2"]);
    expect((await find("due:<today")).keys).toEqual(["APP-2"]);
    expect((await find("logged:today")).keys).toEqual(["APP-2"]);
    expect((await find("project:APP (label:bug OR cat:doing)")).keys).toEqual(["APP-1", "APP-2"]);
  });

  it("says what it couldn't apply, instead of dropping it", async () => {
    const r = await find("login sprint:42");
    expect(r.keys).toEqual(["APP-1", "acme/web#4"]);
    expect(r.query).toEqual({ unsupported: ["sprint:42"], warnings: [] });
    // A client is a filter now: none named Acme yet, so nothing.
    expect((await find("login cliente:Acme")).keys).toEqual([]);
    expect((await find("colour:red")).query.warnings).toEqual([{ code: "unknownField", at: "colour:red" }]);
  });
});
