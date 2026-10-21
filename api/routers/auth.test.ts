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

/** How Jira answers: ok, 401 (bad / revoked credentials), 500, or unreachable. */
let jira: "ok" | "401" | "500" | "down" = "ok";

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (jira === "down") throw new TypeError("fetch failed");
    if (jira === "401") return json({ errorMessages: ["Unauthorized"] }, 401);
    if (jira === "500") return json({ errorMessages: ["boom"] }, 500);
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (url.includes("/search")) return json({ isLast: true, issues: [], total: 0 });
    return json({ errorMessages: [`unmocked ${url}`] }, 500);
  }),
);

type Router = typeof import("../router").appRouter;
type Ctx = import("../context").TrpcContext;

describe("auth: sessions, cookies, login hardening", () => {
  let appRouter: Router;
  let app: typeof import("../boot").default;
  let ip = 0;

  /** A request from its own client address (each test's sign-ins don't share a rate limit by accident). */
  const anon = (url = "http://localhost/api/trpc", headers: Record<string, string> = {}): Ctx => ({
    req: new Request(url, { headers }),
    resHeaders: new Headers(),
    user: null,
    sessionId: null,
    remoteAddress: `192.0.2.${++ip % 250}`,
  });

  const PASSWORD = "a long enough password";

  /** A local account with a password (as after an invite). */
  const account = async (username: string, extra: Record<string, unknown> = {}) => {
    const { hashPassword } = await import("../lib/password");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const [u] = await getDb()
      .insert(users)
      .values({ username, displayName: username, passwordHash: await hashPassword(PASSWORD), ...extra })
      .returning();
    return u;
  };

  const login = async (ctx = anon(), input: { username?: string; password?: string } = {}) => {
    await appRouter.createCaller(ctx).auth.login({ username: "mario", password: PASSWORD, ...input });
    return ctx.resHeaders.get("set-cookie") ?? "";
  };

  /** The signed-in context a cookie gives (as the HTTP layer builds it). */
  const fromCookie = async (setCookie: string, url = "http://localhost/api/trpc"): Promise<Ctx> => {
    const cookie = setCookie.split(";")[0];
    const { userFromRequest } = await import("../context");
    const req = new Request(url, { headers: { cookie } });
    const { user, sessionId } = await userFromRequest(req);
    return { req, resHeaders: new Headers(), user, sessionId };
  };

  const session = async (input: { username?: string } = {}) => fromCookie(await login(anon(), input));

  const sessionCount = async () => ((await q("SELECT count(*) AS n FROM sessions"))[0] as { n: number }).n;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    ({ appRouter } = await import("../router"));
    app = (await import("../boot")).default;
    await account("mario", { role: "admin" });
  });

  it("signs in with username (any case) and password, and refuses anything else with one message", async () => {
    expect(await login(anon(), { username: "Mario" })).toMatch(/ikl_session=/);
    for (const input of [{ password: "wrong password!" }, { username: "nobody" }]) {
      await expect(login(anon(), input)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Wrong username or password." });
    }
  });

  it("an account without a password (not activated yet) can't sign in with one", async () => {
    await account("legacy", { passwordHash: null });
    await expect(login(anon(), { username: "legacy" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("two servers on one host get separate session cookies (port in the name)", async () => {
    const { userFromRequest } = await import("../context");
    const dev = (await login(anon("http://localhost:3000/api/trpc"))).split(";")[0];
    const prod = (await login(anon("http://localhost:47823/api/trpc"))).split(";")[0];
    expect(dev).toMatch(/^ikl_session_3000=/);
    expect(prod).toMatch(/^ikl_session_47823=/);
    // Default port (Tailscale https): the plain name, as before.
    expect(await login(anon("https://mac.tail1.ts.net/api/trpc"))).toMatch(/^ikl_session=/);
    // A browser sends both cookies to either port: each server picks its own.
    const both = { cookie: `${dev}; ${prod}` };
    const onDev = await userFromRequest(new Request("http://localhost:3000/api/trpc", { headers: both }));
    const onProd = await userFromRequest(new Request("http://localhost:47823/api/trpc", { headers: both }));
    expect(onDev.user).not.toBeNull();
    expect(onProd.user).not.toBeNull();
    expect(onDev.sessionId).not.toBe(onProd.sessionId);
  });

  it("still accepts the old plain cookie, and logout clears both names", async () => {
    const { userFromRequest } = await import("../context");
    const plain = (await login(anon("https://mac.tail1.ts.net/api/trpc"))).split(";")[0];
    const req = new Request("http://localhost:47823/api/trpc", { headers: { cookie: plain } });
    const { user, sessionId } = await userFromRequest(req);
    expect(user).not.toBeNull();
    const ctx = { ...anon("http://localhost:47823/api/trpc"), user, sessionId };
    await appRouter.createCaller(ctx).auth.logout();
    const cleared = ctx.resHeaders.get("set-cookie") ?? "";
    expect(cleared).toMatch(/ikl_session_47823=deleted/);
    expect(cleared).toMatch(/ikl_session=deleted/);
  });

  it("COOKIE_SECURE=1 forces Secure behind a proxy that hides the scheme", async () => {
    process.env.COOKIE_SECURE = "1";
    try {
      expect(await login(anon("http://127.0.0.1:47823/api/trpc"))).toMatch(/Secure/);
    } finally {
      delete process.env.COOKIE_SECURE;
    }
  });

  it("sets Secure only when the request came over HTTPS", async () => {
    expect(await login(anon("http://127.0.0.1:47823/api/trpc"))).not.toMatch(/Secure/);
    expect(await login(anon("https://ikl.example.it/api/trpc"))).toMatch(/Secure/);
    expect(await login(anon("http://127.0.0.1/api/trpc", { "x-forwarded-proto": "https" }))).toMatch(/Secure/);
  });

  it("rate limits sign-in attempts per account and per client address", async () => {
    await account("target");
    const from = (address: string) => ({ ...anon("http://localhost/api/trpc", { "x-forwarded-for": "203.0.113.9" }), remoteAddress: address });
    for (let i = 0; i < 10; i++) await expect(login(from(`198.51.100.${i}`), { username: "target", password: "wrong password!" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(login(from("198.51.100.99"), { username: "target" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // The socket address counts; a spoofed X-Forwarded-For does not.
    for (let i = 0; i < 30; i++) await login(from("198.51.100.200"), { username: "nobody" }).catch(() => null);
    await expect(login(from("198.51.100.200"))).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(login(from("198.51.100.201"))).resolves.toBeTruthy();
  });

  it("logout works without a session and always clears the cookie", async () => {
    const ctx = anon();
    expect(await appRouter.createCaller(ctx).auth.logout()).toEqual({ ok: true });
    expect(ctx.resHeaders.get("set-cookie")).toMatch(/Max-Age=0/);
    // an expired session is still removed
    const s = await session();
    await q("UPDATE sessions SET expires_at = 0 WHERE id = ?", s.sessionId);
    const before = await sessionCount();
    await appRouter.createCaller({ ...s, user: null }).auth.logout();
    expect(await sessionCount()).toBe(before - 1);
  });

  describe("a new server", () => {
    it("starts with one admin whose default password opens only the change of password", async () => {
      const { ensureAdmin, defaultAdminPending } = await import("../queries/accounts");
      await q("UPDATE users SET role = 'member'");
      expect(await ensureAdmin()).toBe(true);
      expect(await ensureAdmin()).toBe(false);
      expect(await defaultAdminPending()).toBe(true);
      const s = await fromCookie(await login(anon(), { username: "admin", password: "admin" }));
      expect(await appRouter.createCaller(s).auth.me()).toMatchObject({ username: "admin", role: "admin", mustChangePassword: true });
      await expect(appRouter.createCaller(s).issues.list()).rejects.toMatchObject({ code: "FORBIDDEN", message: "PASSWORD_CHANGE_REQUIRED" });
      await expect(appRouter.createCaller(s).auth.changePassword({ current: "admin", next: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(appRouter.createCaller(s).auth.changePassword({ current: "admin", next: "admin" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const changed = await appRouter.createCaller(s).auth.changePassword({ current: "admin", next: "the admin's own password" });
      expect(changed.mustChangePassword).toBe(false);
      expect(await defaultAdminPending()).toBe(false);
      const { userFromRequest } = await import("../context");
      const after = await userFromRequest(s.req);
      expect(after.user, "this session stays").not.toBeNull();
      await q("UPDATE users SET role = 'admin' WHERE username = 'mario'");
    });
  });

  describe("invites and account management", () => {
    const admin = () => session();

    it("an admin invites someone with permissions; the link sets their password once and signs them in", async () => {
      const a = await admin();
      const { link, user } = await appRouter.createCaller(a).users.invite({ username: "Giulia", displayName: "Giulia", role: "member", permissions: ["manageStore"] });
      expect(user).toMatchObject({ username: "giulia", role: "member", permissions: ["manageStore"], pending: true });
      const token = link.split("/").pop()!;
      expect(await appRouter.createCaller(anon()).auth.invite({ token })).toEqual({ username: "giulia", displayName: "Giulia" });
      await expect(appRouter.createCaller(anon()).auth.acceptInvite({ token, password: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const signedIn = anon();
      expect(await appRouter.createCaller(signedIn).auth.acceptInvite({ token, password: "giulia's password" })).toMatchObject({ username: "giulia" });
      expect(signedIn.resHeaders.get("set-cookie")).toMatch(/ikl_session=/);
      await expect(appRouter.createCaller(anon()).auth.acceptInvite({ token, password: "another password" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await login(anon(), { username: "giulia", password: "giulia's password" })).toMatch(/ikl_session=/);
    });

    it("an admin sees how many trackers each account has, never which (T6)", async () => {
      const a = await admin();
      const [mine] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('counted', 'Counted', 1) RETURNING id");
      for (const host of ["https://c1.example", "https://c2.example"]) {
        await q("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', ?, 'x', '{}', 'x', 1)", mine.id, host);
      }
      const listed = (await appRouter.createCaller(a).users.list()).find((u) => u.username === "counted")!;
      expect(listed.connections).toBe(2);
      expect(JSON.stringify(listed)).not.toContain("c1.example");
    });

    it("permissions are checked on the server: a member can't manage accounts", async () => {
      await account("member1");
      const m = await session({ username: "member1" });
      await expect(appRouter.createCaller(m).users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(appRouter.createCaller(m).users.invite({ username: "x1", displayName: "X", role: "admin", permissions: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
      // Server-wide powers, each behind its permission.
      for (const call of [() => appRouter.createCaller(m).backup.get(), () => appRouter.createCaller(m).store.pending(), () => appRouter.createCaller(m).info.setAccess({ customHosts: [] })]) {
        await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      // Granted one, it has that one only.
      await q("UPDATE users SET permissions = '[\"manageBackups\"]' WHERE username = 'member1'");
      const granted = await session({ username: "member1" });
      await expect(appRouter.createCaller(granted).backup.get()).resolves.toBeTruthy();
      await expect(appRouter.createCaller(granted).store.pending()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a reset gives a temporary password, signs the account out everywhere, and forces a change", async () => {
      const target = await account("resetme");
      const before = await session({ username: "resetme" });
      const { password } = await appRouter.createCaller(await admin()).users.resetPassword({ id: target.id });
      const { userFromRequest } = await import("../context");
      expect((await userFromRequest(before.req)).user, "old session ended").toBeNull();
      const s = await fromCookie(await login(anon(), { username: "resetme", password }));
      await expect(appRouter.createCaller(s).issues.list()).rejects.toMatchObject({ message: "PASSWORD_CHANGE_REQUIRED" });
    });

    it("a turned-off account can't sign in or use its sessions; the last admin can't be removed", async () => {
      const target = await account("leaving");
      const s = await session({ username: "leaving" });
      const a = await admin();
      await appRouter.createCaller(a).users.setDisabled({ id: target.id, disabled: true });
      const { userFromRequest } = await import("../context");
      expect((await userFromRequest(s.req)).user).toBeNull();
      await expect(login(anon(), { username: "leaving" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(appRouter.createCaller(a).users.setDisabled({ id: a.user!.id, disabled: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await q("UPDATE users SET role = 'member' WHERE username <> 'mario'");
      const other = await account("admin2", { role: "admin" });
      await appRouter.createCaller(a).users.setAccess({ id: other.id, role: "member", permissions: [] });
      const solo = await account("solo-admin", { role: "admin" });
      await q("UPDATE users SET role = 'member' WHERE username = 'mario'");
      const soloSession = await session({ username: "solo-admin" });
      await expect(appRouter.createCaller(soloSession).users.setAccess({ id: solo.id, role: "member", permissions: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await q("UPDATE users SET role = 'admin' WHERE username = 'mario'");
    });
  });

  describe("an account from before local accounts", () => {
    it("activates itself with its Jira login, picks a username and password, then signs in with those", async () => {
      // An account from a Jira login, before local accounts: no password, its Jira connection (a secret no key opens any more).
      const [old] = await q<{ id: number }>("INSERT INTO users (email, display_name, created_at) VALUES ('m@x.it', 'Mario', ?) RETURNING id", Date.now());
      await q(
        "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, legacy, status, created_at) VALUES (?, 'jira', ?, 'acc-1', '{}', 'x', 1, 'unreadable', ?)",
        old.id,
        SITE,
        Date.now(),
      );
      const activate = (input: Record<string, string> = {}) =>
        appRouter.createCaller(anon()).auth.activate({ siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t", newUsername: "mrossi", newPassword: "mario's new password", ...input });
      await expect(activate({ newUsername: "Bad Name!" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await activate()).toMatchObject({ username: "mrossi", id: old.id });
      await expect(activate({ newUsername: "again" })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await login(anon(), { username: "mrossi", password: "mario's new password" })).toMatch(/ikl_session=/);
      // Its Jira connection is the one it had, working again with the login just confirmed (sealed for it).
      expect(await q("SELECT count(*)::int AS n FROM connections c JOIN users u ON u.id = c.user_id WHERE u.username = 'mrossi'")).toEqual([{ n: 1 }]);
      const [conn] = await q<{ id: number; status: string; encrypted_secret: string }>("SELECT id, status, encrypted_secret FROM connections WHERE user_id = ?", old.id);
      expect(conn.status).toBe("ok");
      const { openSecret } = await import("../lib/crypto");
      expect(openSecret(conn.encrypted_secret, conn.id).plain).toBe("t");
    });

    it("a Jira login with no account behind it gets nothing; Jira failures answer as before", async () => {
      const activate = (input: Record<string, string> = {}) =>
        appRouter.createCaller(anon()).auth.activate({ siteUrl: "https://other.atlassian.net", deployment: "cloud", authType: "basic", username: "x@x.it", secret: "t", newUsername: "newbie", newPassword: "a fine password", ...input });
      await expect(activate()).rejects.toMatchObject({ code: "NOT_FOUND" });
      for (const mode of ["down", "500"] as const) {
        jira = mode;
        await expect(activate()).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Can't sign in: check the address and credentials" });
      }
      jira = "401";
      await expect(activate({ deployment: "server" })).rejects.toMatchObject({ code: "UNAUTHORIZED", message: expect.stringMatching(/username and password/) });
      await expect(activate()).rejects.toMatchObject({ message: expect.stringMatching(/email and API token/) });
      jira = "ok";
    });
  });

  it("connecting Jira: the site URL is normalized, and one Jira account belongs to one inkledger account", async () => {
    await account("conn1");
    await account("conn2");
    const one = await session({ username: "conn1" });
    const two = await session({ username: "conn2" });
    const site = "https://ACME2.atlassian.net:443/?x=1#top";
    const connected = await appRouter.createCaller(one).connections.addJira({ siteUrl: site, deployment: "cloud", authType: "basic", username: "c@x.it", secret: "t" });
    expect(connected.host).toBe("acme2.atlassian.net");
    await expect(appRouter.createCaller(two).connections.addJira({ siteUrl: "https://acme2.atlassian.net///", deployment: "cloud", authType: "basic", username: "c@x.it", secret: "t" })).rejects.toMatchObject({ code: "CONFLICT" });
    const { normalizeSiteUrl } = await import("./auth");
    expect(normalizeSiteUrl("http://Jira.Example.it:80/jira/")).toBe("http://jira.example.it/jira");
    expect(normalizeSiteUrl("https://jira.example.it:8443/")).toBe("https://jira.example.it:8443");
  });

  it("a revoked Jira token keeps the user signed in and sets the connection aside to reconnect", async () => {
    await account("jirauser");
    const s = await session({ username: "jirauser" });
    const added = await appRouter.createCaller(s).connections.addJira({ siteUrl: "https://revoked.atlassian.net", deployment: "cloud", authType: "basic", username: "r@x.it", secret: "t" });
    const { userFromRequest } = await import("../context");
    const fresh = { ...(await userFromRequest(s.req)), req: s.req, resHeaders: new Headers() };
    const before = await sessionCount();
    jira = "401";
    try {
      await expect(appRouter.createCaller(fresh).issues.sync()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/reconnect/) });
    } finally {
      jira = "ok";
    }
    expect(await sessionCount()).toBe(before);
    expect(fresh.resHeaders.get("set-cookie")).toBeNull();
    expect(await appRouter.createCaller(fresh).connections.list()).toMatchObject([{ status: "auth_failed" }]);
    // Reconnected with working credentials: back to normal.
    await appRouter.createCaller(fresh).connections.reconnectJira({ id: added.id, siteUrl: "https://revoked.atlassian.net", deployment: "cloud", authType: "basic", username: "r@x.it", secret: "new" });
    expect(await appRouter.createCaller(fresh).connections.list()).toMatchObject([{ status: "ok" }]);
  });

  it("an undecryptable stored secret keeps the session; the connection is marked unreadable", async () => {
    await account("garbled");
    const s = await session({ username: "garbled" });
    await appRouter.createCaller(s).connections.addJira({ siteUrl: "https://garbled.atlassian.net", deployment: "cloud", authType: "basic", username: "g@x.it", secret: "t" });
    await q("UPDATE connections SET encrypted_secret = 'garbage' WHERE user_id = ?", s.user!.id);
    const { userFromRequest } = await import("../context");
    const ctx = { ...(await userFromRequest(s.req)), req: s.req, resHeaders: new Headers() };
    expect(await appRouter.createCaller(ctx).auth.me()).toMatchObject({ username: "garbled" });
    await expect(appRouter.createCaller(ctx).issues.sync()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await appRouter.createCaller(ctx).connections.list()).toMatchObject([{ status: "unreadable" }]);
    expect((await userFromRequest(s.req)).user).not.toBeNull();
  });

  describe("remembered device", () => {
    /** The cookies a login (or resume) set, as the browser would send them back. */
    const cookiesOf = (setCookie: string) =>
      setCookie
        .split(/,(?=\s*ikl_)/)
        .map((c) => c.trim().split(";")[0])
        .filter((c) => !c.endsWith("=deleted"))
        .join("; ");
    const rememberOf = (set: string) => cookiesOf(set).split("; ").find((c) => c.startsWith("ikl_remember="))!;

    it("signs in again without the password after a sign-out, asking no tracker", async () => {
      const set = await login();
      expect(set).toMatch(/ikl_remember=/);
      const remember = rememberOf(set);
      const back = anon("http://localhost/api/trpc", { cookie: remember });
      expect(await appRouter.createCaller(back).auth.remembered()).toMatchObject({ displayName: "mario", username: "mario" });
      const before = await sessionCount();
      jira = "down";
      try {
        expect((await appRouter.createCaller(back).auth.resume()).username).toBe("mario");
      } finally {
        jira = "ok";
      }
      expect(await sessionCount()).toBe(before + 1);
      // The token rotates: the old one no longer works.
      expect(back.resHeaders.get("set-cookie")).toMatch(/ikl_remember=/);
      await expect(appRouter.createCaller(anon("http://localhost/api/trpc", { cookie: remember })).auth.resume()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("another port's device cookie is not this server's", async () => {
      const remember = rememberOf(await login());
      const other = anon("http://localhost:3000/api/trpc", { cookie: remember, host: "localhost:3000" });
      expect(await appRouter.createCaller(other).auth.remembered()).toBeNull();
    });

    it("a password change forgets the account's other devices", async () => {
      await account("changer");
      const remember = rememberOf(await login(anon(), { username: "changer" }));
      const s = await session({ username: "changer" });
      await appRouter.createCaller(s).auth.changePassword({ current: PASSWORD, next: "a different long password" });
      expect(await appRouter.createCaller(anon("http://localhost/api/trpc", { cookie: remember })).auth.remembered()).toBeNull();
    });

    it("forget drops it for good", async () => {
      const remember = rememberOf(await login());
      await appRouter.createCaller(anon("http://localhost/api/trpc", { cookie: remember })).auth.forget();
      expect(await appRouter.createCaller(anon("http://localhost/api/trpc", { cookie: remember })).auth.remembered()).toBeNull();
    });
  });

  it("a session in use is extended past half its life; a fresh one is left alone", async () => {
    const cookie = (await login()).split(";")[0];
    const { createContext } = await import("../context");
    const ctxFor = () => {
      const req = new Request("http://localhost/api/trpc", { headers: { cookie } });
      return { req, resHeaders: new Headers(), info: {} } as unknown as Parameters<typeof createContext>[0];
    };
    const fresh = ctxFor();
    const s = await createContext(fresh);
    expect(fresh.resHeaders.get("set-cookie")).toBeNull();
    await q("UPDATE sessions SET expires_at = ? WHERE id = ?", Date.now() + 3600_000, s.sessionId);
    const old = ctxFor();
    await createContext(old);
    expect(old.resHeaders.get("set-cookie")).toMatch(/ikl_session=/);
    const [row] = await q<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE id = ?", s.sessionId);
    expect(row.expires_at).toBeGreaterThan(Date.now() + 20 * 24 * 3600_000);
  });

  it("refuses unparseable or opaque origins on state-changing requests", async () => {
    for (const origin of ["null", "not a url"]) {
      const res = await app.request("/api/trpc/auth.logout", {
        method: "POST",
        headers: { origin, host: "localhost", "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, origin).toBe(403);
    }
    const ok = await app.request("http://localhost/api/trpc/auth.logout", {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});
