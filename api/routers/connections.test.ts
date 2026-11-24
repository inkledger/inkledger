import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { jiraSimulator } from "../providers/jira/simulator";

const sim = jiraSimulator("https://two.atlassian.net", "acc-two");
sim.add("TWO-1", "On the second site");
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => sim.fetch(input, init));

const login = { siteUrl: "https://two.atlassian.net", deployment: "cloud" as const, authType: "basic" as const, username: "m@x.it", secret: "t" };

describe("Settings → Connections", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;
  let other: Caller;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  const callerFor = async (username: string): Promise<Caller> => {
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const [user] = await getDb().insert(users).values({ username, displayName: username }).returning();
    return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  };

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    caller = await callerFor("mario");
    other = await callerFor("anna");
  });

  it("lists every tracker type: what inkledger can connect, and what is to come", async () => {
    const catalog = await caller.connections.catalog();
    expect(catalog.find((c) => c.type === "jira")).toMatchObject({ name: "Jira", status: "built", how: "jiraLogin" });
    expect(catalog.find((c) => c.type === "github")).toMatchObject({ name: "GitHub", status: "built" });
    expect(catalog.find((c) => c.type === "gitlab")).toMatchObject({ name: "GitLab", status: "built", how: "token", asksAddress: true });
    expect(catalog.find((c) => c.type === "shortcut")).toMatchObject({ name: "Shortcut", status: "experimental", how: "token", asksAddress: false });
  });

  it("the same Jira added twice at once is one connection, both told so", async () => {
    const both = await Promise.allSettled([caller.connections.addJira({ ...login, label: "" }), caller.connections.addJira({ ...login, label: "" })]);
    expect(both.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const ids = both.map((r) => (r.status === "fulfilled" ? r.value.id : 0));
    expect(ids[0]).toBe(ids[1]);
  });

  it("adds a Jira (confirmed live); the same account again is the same connection; another user can't take it", async () => {
    const added = await caller.connections.addJira({ ...login, label: "Client B" });
    expect(added).toMatchObject({ type: "jira", name: "Jira", host: "two.atlassian.net", label: "Client B", status: "ok", legacy: false });
    const again = await caller.connections.addJira({ ...login, label: "" });
    expect(again.id).toBe(added.id);
    expect(await caller.connections.list()).toHaveLength(1);
    await expect(other.connections.addJira({ ...login, label: "" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Its secret lives sealed on the connection only.
    const { q } = await import("../queries/connection");
    const [row] = await q<{ encrypted_secret: string }>("SELECT encrypted_secret FROM connections WHERE id = ?", added.id);
    expect(row.encrypted_secret.startsWith("v1.")).toBe(true);
  });

  it("tests a connection live and keeps what it found; renames it", async () => {
    const [c] = await caller.connections.list();
    const tested = await caller.connections.test({ id: c.id });
    expect(tested.connection.probedAt).not.toBeNull();
    expect(tested.sources.length).toBeGreaterThan(0);
    expect((await caller.connections.rename({ id: c.id, label: "Client B (old)" })).label).toBe("Client B (old)");
    const [e] = await q<{ action: string; target_id: string; after: string }>("SELECT action, target_id, after FROM audit_events ORDER BY id DESC LIMIT 1");
    expect([e.action, e.target_id, JSON.parse(e.after)]).toEqual(["connections.rename", String(c.id), { label: "Client B (old)" }]);
  });

  it("reconnecting takes the same account's new credentials, never another account's", async () => {
    const [c] = await caller.connections.list();
    expect((await caller.connections.reconnectJira({ id: c.id, ...login, secret: "new" })).status).toBe("ok");
    const elsewhere = jiraSimulator("https://three.atlassian.net", "acc-three");
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      (String(input instanceof Request ? input.url : input).startsWith("https://three.") ? elsewhere : sim).fetch(input, init),
    );
    await expect(caller.connections.reconnectJira({ id: c.id, ...login, siteUrl: "https://three.atlassian.net" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a refused reconnect keeps the session and says why; after a CAPTCHA, that it may still be the CAPTCHA", async () => {
    const [c] = await caller.connections.list();
    const { t } = await import("@contracts/i18n");
    vi.stubGlobal("fetch", async () => new Response("<html></html>", { status: 401, headers: { "Content-Type": "text/html" } }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // UNAUTHORIZED is the session's own answer: the app would sign out and the form start over.
      await expect(caller.connections.reconnectJira({ id: c.id, ...login })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: t("server.auth.invalidCredentialsCloud") });
      await expect(caller.connections.addJira({ ...login, label: "" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await q(
        "INSERT INTO connection_sync (connection_id, stream, last_error, last_error_at) VALUES (?, 'issues', ?, ?) ON CONFLICT (connection_id, stream) DO UPDATE SET last_error = excluded.last_error",
        c.id,
        "auth (401): Jira refused the sign-in (CAPTCHA_CHALLENGE): sign in to Jira in a browser, then reconnect",
        Date.now(),
      );
      await expect(caller.connections.reconnectJira({ id: c.id, ...login })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: t("server.auth.captchaMaybe") });
      // A sync that went through since: that CAPTCHA is over, the credentials are the reason.
      await q("UPDATE connection_sync SET last_ok_at = ? WHERE connection_id = ?", Date.now() + 1000, c.id);
      await expect(caller.connections.reconnectJira({ id: c.id, ...login })).rejects.toMatchObject({ message: t("server.auth.invalidCredentialsCloud") });
    } finally {
      warn.mockRestore();
      await q("DELETE FROM connection_sync WHERE connection_id = ?", c.id);
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => sim.fetch(input, init));
    }
  });

  it("archived: its issues leave the lists, its time stays", async () => {
    const [c] = await caller.connections.list();
    await caller.issues.sync();
    expect((await caller.issues.all()).map((i) => i.key)).toContain("TWO-1");
    const started = new Date(2026, 9, 14, 9).getTime();
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) SELECT user_id, ?, 'TWO-1', 'w-1', 1800, ?, ? FROM connections WHERE id = ?", c.id, started, started, c.id);
    await caller.connections.archive({ id: c.id });
    expect((await q<{ action: string }>("SELECT action FROM audit_events ORDER BY id DESC LIMIT 1"))[0].action).toBe("connections.archive");
    expect(await caller.connections.list()).toEqual([]);
    expect((await caller.issues.all()).map((i) => i.key)).not.toContain("TWO-1");
    expect((await caller.issues.list({ includeDone: true, includeUnassigned: true })).issues).toEqual([]);
    expect((await caller.worklogs.list({ issueKey: "TWO-1" })).map((w) => w.timeSpentSeconds)).toEqual([1800]);
    // Added again: back, with its issues.
    await caller.connections.addJira({ ...login, label: "" });
    expect((await caller.issues.all()).map((i) => i.key)).toContain("TWO-1");
  });
});
