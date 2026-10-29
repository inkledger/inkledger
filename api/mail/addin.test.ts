import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("the Outlook add-in's routes", () => {
  let app: typeof import("../boot").default;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let key = "";
  const ORIGIN = "https://my-mac.local:3443";
  const as = (k: string, init: RequestInit = {}) => ({ ...init, headers: { host: "my-mac.local:3443", authorization: `Bearer ${k}`, ...(init.headers ?? {}) } });

  beforeAll(async () => {
    app = (await import("../boot")).default;
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('m', 'm', 1) RETURNING id");
    const [jira] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://acme.atlassian.net', 'me', 'x', 1) RETURNING id", u.id);
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, url, synced_at, assignee_id) VALUES (?, ?, 'i1', 'APP-1', 'Login fails', 'To Do', 'todo', 'APP', 'App', 'u', 1, 'me')",
      u.id,
      jira.id,
    );
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    key = (await appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null }).mails.newAddinKey()).key;
  });

  it("serves a manifest pointing at the address Outlook reached, reading the mail only", async () => {
    const res = await app.request("http://localhost/api/outlook/manifest.xml", { headers: { host: "my-mac.local:3443" } });
    expect(res.headers.get("content-type")).toMatch(/xml/);
    const xml = await res.text();
    expect(xml).toContain(`<SourceLocation DefaultValue="${ORIGIN}/outlook.html"/>`);
    expect(xml).toContain("<Permissions>ReadItem</Permissions>");
    expect(xml).toContain('Locale="it-IT"');
  });

  it("sends add-ins installed from the first manifest to the pane page", async () => {
    const old = await app.request("http://localhost/api/outlook/taskpane.html");
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/outlook.html");
  });

  it("tells the pane the user's theme colour", async () => {
    const me = await app.request("http://localhost/api/outlook/me", as(key));
    expect(((await me.json()) as { data: { themeColor: string } }).data.themeColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("opens only with a valid key", async () => {
    expect((await app.request("http://localhost/api/outlook/me", as("ikl_ol_notavalidkeyatallreally"))).status).toBe(401);
    expect((await app.request("http://localhost/api/outlook/me")).status).toBe(401);
    expect((await app.request("http://localhost/api/outlook/me", as(key))).status).toBe(200);
    // The key opens the add-in's routes, not the app's API.
    expect((await app.request("http://localhost/api/trpc/mails.recent?input=%7B%7D", as(key))).status).toBe(401);
    expect((await q<{ last_used_at: number | null }>("SELECT last_used_at FROM mail_addin_keys"))[0].last_used_at).not.toBeNull();
  });

  it("finds issues and pins the open mail to one, to a new TODO, to the board", async () => {
    const found = await app.request("http://localhost/api/outlook/issues?q=login", as(key));
    const issues = ((await found.json()) as { data: Array<{ key: string; connectionId: number }> }).data;
    expect(issues.map(i => i.key)).toEqual(["APP-1"]);
    const mail = {
      subject: "Budget 2027",
      fromName: "Giulia Rossi",
      fromAddress: "giulia@example.com",
      receivedAt: Date.parse("2026-10-27T09:00:00Z"),
      webLink: "https://outlook.office.com/mail/deeplink/read/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AAAAA",
      internetMessageId: "budget-2027@example.com",
      exchangeId: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AAAAA",
      source: "addin",
    };
    const post = (to: unknown) => app.request("http://localhost/api/outlook/pin", as(key, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ mail, to }) }));
    expect((await post({ issueKey: "APP-1", connectionId: issues[0].connectionId })).status).toBe(200);
    expect((await post({ todo: {} })).status).toBe(200);
    expect((await post({ board: {} })).status).toBe(200);
    expect(await q("SELECT count(*)::int AS n FROM mails")).toEqual([{ n: 1 }]);
    expect(await q("SELECT issue_key FROM mail_links")).toEqual([{ issue_key: "APP-1" }]);
    expect(await q("SELECT text FROM todos")).toEqual([{ text: "Budget 2027" }]);
    expect((await post("junk")).status).toBe(400);
  });

  it("the pane has a bucket of its own: it narrows the issues and boards, and a board made there goes in it", async () => {
    const [{ user_id: me }] = await q<{ user_id: number }>("SELECT user_id FROM mail_addin_keys");
    const [jira] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ?", me);
    const [other] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://other.atlassian.net', 'me', 'x', 1) RETURNING id",
      me,
    );
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, url, synced_at, assignee_id) VALUES (?, ?, 'o1', 'OTH-1', 'Login page', 'To Do', 'todo', 'OTH', 'Other', 'u', 1, 'me')",
      me,
      other.id,
    );
    const [bucket] = await q<{ id: number }>("INSERT INTO buckets (user_id, name, created_at) VALUES (?, 'Acme', 1) RETURNING id", me);
    await q("INSERT INTO bucket_sources (bucket_id, connection_id) VALUES (?, ?)", bucket.id, jira.id);
    const [stranger] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('s', 's', 1) RETURNING id");
    const [foreign] = await q<{ id: number }>("INSERT INTO buckets (user_id, name, created_at) VALUES (?, 'Theirs', 1) RETURNING id", stranger.id);

    const pane = (init: RequestInit = {}) => as(key, { ...init, headers: { "x-device-id": "outlook-pane0001", origin: ORIGIN, "content-type": "application/json", ...(init.headers ?? {}) } });
    const keys = async (init: RequestInit) =>
      ((await (await app.request("http://localhost/api/outlook/issues?q=login", init)).json()) as { data: Array<{ key: string }> }).data.map(i => i.key).sort();

    const listed = (await (await app.request("http://localhost/api/outlook/buckets", pane())).json()) as { data: { buckets: { id: number; name: string }[]; active: number | null } };
    expect(listed.data).toEqual({ buckets: [{ id: bucket.id, name: "Acme" }], active: null });
    expect(await keys(pane())).toEqual(["APP-1", "OTH-1"]);

    const chose = await app.request("http://localhost/api/outlook/bucket", pane({ method: "POST", body: JSON.stringify({ id: bucket.id }) }));
    expect(((await chose.json()) as { data: { active: number } }).data.active).toBe(bucket.id);
    expect(await keys(pane())).toEqual(["APP-1"]);
    // Another device (or the pane before it had an id) keeps its own: everything.
    expect(await keys(as(key))).toEqual(["APP-1", "OTH-1"]);

    const mail = { subject: "Kick-off", webLink: "https://outlook.office.com/mail/deeplink/read/AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0BBBBB", exchangeId: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0BBBBB", source: "addin" };
    const pinned = await app.request("http://localhost/api/outlook/pin", pane({ method: "POST", body: JSON.stringify({ mail, to: { board: { newBoard: "Acme mails" } } }) }));
    expect(pinned.status).toBe(200);
    expect(await q("SELECT bucket_id FROM pinboards WHERE name = 'Acme mails'")).toEqual([{ bucket_id: bucket.id }]);

    const theirs = await app.request("http://localhost/api/outlook/bucket", pane({ method: "POST", body: JSON.stringify({ id: foreign.id }) }));
    expect(theirs.status).toBe(404);
    const all = await app.request("http://localhost/api/outlook/bucket", pane({ method: "POST", body: JSON.stringify({ id: null }) }));
    expect(((await all.json()) as { data: { active: number | null } }).data.active).toBeNull();
    expect(await keys(pane())).toEqual(["APP-1", "OTH-1"]);
  });
});
