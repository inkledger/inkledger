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
});
