import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
process.env.MS_CLIENT_ID = "test-client";

describe("Microsoft mailbox", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let me: Caller;
  let other: Caller;
  let jira = 0;

  /** Microsoft answering in order; each call recorded. */
  const microsoft = (...answers: Array<[number, unknown]>) => {
    const fetcher = vi.fn();
    for (const [status, body] of answers) fetcher.mockResolvedValueOnce(Response.json(body, { status }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };
  const message = {
    id: "AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AAAAA",
    subject: "Budget 2027",
    from: { emailAddress: { name: "Giulia Rossi", address: "Giulia@Example.com" } },
    receivedDateTime: "2026-10-27T09:00:00Z",
    internetMessageId: "<budget-2027@example.com>",
    webLink: "https://outlook.office365.com/owa/?ItemID=AAkALgAAAAAAHYQDEapmEc2byACqAC%2BEWg0AAAAA&exvsurl=1&viewmodel=ReadMessageItem",
  };

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const user = async (name: string) => (await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name))[0].id;
    const u = await user("m");
    const o = await user("o");
    jira = (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://acme.atlassian.net', 'me', 'x', 1) RETURNING id", u))[0].id;
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, url, synced_at) VALUES (?, ?, 'i1', 'APP-1', 'Login fails', 'To Do', 'todo', 'APP', 'App', 'u', 1)",
      u,
      jira,
    );
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const caller = async (id: number) => {
      const [row] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null });
    };
    me = await caller(u);
    other = await caller(o);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off for a user not signed in: no search, no account", async () => {
    expect(await me.mails.account()).toEqual({ available: true, account: null });
    expect(await me.mails.search({})).toBeNull();
  });

  it("signs in with a device code, keeps the tokens sealed, and says who", async () => {
    const fetcher = microsoft(
      [200, { device_code: "dev", user_code: "ABCD1234", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 }],
      [400, { error: "authorization_pending" }],
    );
    const flow = await me.mails.signInStart();
    expect(flow).toMatchObject({ userCode: "ABCD1234", verificationUri: "https://microsoft.com/devicelogin" });
    const asked = new URLSearchParams(String(fetcher.mock.calls[0][1].body));
    expect(asked.get("client_id")).toBe("test-client");
    expect(asked.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["Mail.Read", "offline_access"]));
    expect(await me.mails.signInPoll({ flowId: flow.flowId })).toMatchObject({ state: "pending" });

    // Microsoft's interval passes: the next poll is answered.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    microsoft([200, { access_token: "at-1", expires_in: 3600, refresh_token: "rt-1" }], [200, { userPrincipalName: "mario@example.com", displayName: "Mario Rossi" }]);
    expect(await me.mails.signInPoll({ flowId: flow.flowId })).toEqual({ state: "authorized", account: "mario@example.com", displayName: "Mario Rossi" });
    vi.useRealTimers();
    expect((await me.mails.account()).account).toEqual({ account: "mario@example.com", displayName: "Mario Rossi" });
    const [row] = await q<{ secret: string }>("SELECT secret FROM mail_accounts");
    expect(row.secret).toMatch(/^v1\./);
    expect(row.secret).not.toContain("at-1");
    // The other user is not signed in.
    expect((await other.mails.account()).account).toBeNull();
  });

  it("says when the organization must approve the app", async () => {
    microsoft([200, { device_code: "dev2", user_code: "X", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 }]);
    const flow = await other.mails.signInStart();
    microsoft([400, { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented to use the application." }]);
    expect(await other.mails.signInPoll({ flowId: flow.flowId })).toEqual({ state: "failed", reason: "consent" });
    // Someone else's flow is not theirs to poll.
    expect(await me.mails.signInPoll({ flowId: flow.flowId })).toEqual({ state: "failed", reason: "expired" });
  });

  it("searches the mailbox, headers only, with ids that survive a move", async () => {
    const fetcher = microsoft([200, { value: [message] }]);
    const [found] = (await me.mails.search({ query: 'budget "2027"' }))!;
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1.0/me/messages");
    expect(url.searchParams.get("$search")).toBe('"budget  2027"');
    expect(url.searchParams.get("$select")).not.toMatch(/body/);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("Prefer")).toBe('IdType="ImmutableId"');
    expect(found).toMatchObject({ subject: "Budget 2027", fromAddress: "giulia@example.com", internetMessageId: "budget-2027@example.com", source: "graph" });
  });

  it("renews an expired access token with the refresh token", async () => {
    await q("UPDATE mail_accounts SET secret = ?", (await import("../lib/crypto")).sealFor(JSON.stringify({ v: 1, accessToken: "old", expiresAt: 1, refreshToken: "rt-1" }), `mail:${(await q<{ user_id: number }>("SELECT user_id FROM mail_accounts"))[0].user_id}`));
    const fetcher = microsoft([200, { access_token: "at-2", expires_in: 3600 }], [200, { value: [] }]);
    expect(await me.mails.search({})).toEqual([]);
    expect(new URLSearchParams(String(fetcher.mock.calls[0][1].body)).get("grant_type")).toBe("refresh_token");
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer at-2");
  });

  it("gives a mail from a file its Outlook link, and pins anywhere in one go", async () => {
    microsoft([200, { value: [message] }]);
    const r = await me.mails.pinTo({ mail: { subject: "Budget 2027", internetMessageId: "budget-2027@example.com", source: "eml" }, to: { issueKey: "APP-1" } });
    expect(r.mail.webLink).toBe(`https://outlook.office.com/mail/deeplink/read/${encodeURIComponent("AAkALgAAAAAAHYQDEapmEc2byACqAC_EWg0AAAAA")}`);
    expect(await me.mails.forIssue({ issueKey: "APP-1" })).toHaveLength(1);

    microsoft();
    const todo = await me.mails.pinTo({ mail: { subject: "Budget 2027", internetMessageId: "budget-2027@example.com", webLink: r.mail.webLink, source: "graph" }, to: { todo: {} } });
    expect(todo.mail.id).toBe(r.mail.id);
    expect(await q("SELECT text, mail_id FROM todos")).toEqual([{ text: "Budget 2027", mail_id: r.mail.id }]);
    const board = await me.mails.pinTo({ mail: { subject: "Budget 2027", internetMessageId: "budget-2027@example.com", source: "graph" }, to: { board: {} } });
    expect(board.boardName).toBeTruthy();
  });

  it("signs out: the tokens are gone", async () => {
    await me.mails.signOut();
    expect(await q("SELECT count(*)::int AS n FROM mail_accounts")).toEqual([{ n: 0 }]);
    expect((await me.mails.account()).account).toBeNull();
  });

  it("makes one add-in key at a time, kept only as its hash", async () => {
    const { key } = await me.mails.newAddinKey();
    expect(key).toMatch(/^ikl_ol_/);
    const again = await me.mails.newAddinKey();
    const rows = await q<{ key_hash: string }>("SELECT key_hash FROM mail_addin_keys");
    expect(rows).toHaveLength(1);
    const { addinKeyHash } = await import("../routers/mails");
    expect(rows[0].key_hash).toBe(addinKeyHash(again.key));
    expect(await me.mails.addinKey()).toMatchObject({ lastUsedAt: null });
    await me.mails.revokeAddinKey();
    expect(await me.mails.addinKey()).toBeNull();
  });
});
