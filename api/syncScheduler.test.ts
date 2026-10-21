import { jiraSignIn } from "./testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** Raw SQL on the test database (Postgres, "?" placeholders). */
const q: typeof import("./queries/connection").q = async (text, ...params) => (await import("./queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
let jiraDown = false;
let tokenRevoked = false;
let searches = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith("/rest/api/3/myself")) {
    return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
  }
  // The worklog sync (api/worklogSync.ts): nothing to import here, not counted.
  if (url.includes("/worklog/updated") || url.includes("/worklog/deleted")) {
    return json({ values: [], lastPage: true, until: Date.now() });
  }
  if (url.includes("/search/jql") && (new URL(url).searchParams.get("jql") ?? "").includes("worklogAuthor")) {
    return json({ isLast: true, issues: [] });
  }
  if (url.includes("/search/jql")) {
    searches++;
    if (tokenRevoked) return json({ errorMessages: ["Unauthorized"] }, 401);
    if (jiraDown) return json({ errorMessages: ["Jira is down"] }, 503);
    return json({
      isLast: true,
      issues: [
        {
          id: "1",
          key: "PRJ-1",
          fields: {
            summary: "First",
            status: { name: "To Do", statusCategory: { key: "new" } },
            project: { key: "PRJ", name: "Progetto" },
            assignee: { accountId: "acc-1", displayName: "Mario" },
          },
        },
      ],
    });
  }
  return json({ errorMessages: [`unmocked ${url}`] }, 500);
});

describe("background Jira sync", () => {
  let caller: ReturnType<typeof import("./router").appRouter.createCaller>;
  let mod: typeof import("./syncScheduler");

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchMock);
    const conn = await import("./queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("./router");
    mod = await import("./syncScheduler");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("./context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
  });

  it("syncs active users without a request and records the time", async () => {
    expect((await caller.issues.syncStatus()).lastSyncAt).toBeNull();
    expect(await mod.syncActiveUsers()).toEqual({ ok: 1, failed: 0 });
    const status = await caller.issues.syncStatus();
    expect(status.lastSyncAt).toBeInstanceOf(Date);
    expect(status.lastError).toBeNull();
    expect((await caller.issues.all()).map((i) => i.key)).toEqual(["PRJ-1"]);
  });

  it("shares one run between concurrent syncs of the same user", async () => {
    let before = searches;
    await Promise.all([mod.syncActiveUsers(), mod.syncActiveUsers()]);
    // one incremental run = recently updated issues + comments of the open ones
    expect(searches - before).toBe(2);
    before = searches;
    await Promise.all([caller.issues.sync(), caller.issues.sync()]);
    // one full run = assigned issues + watched issues + comments
    expect(searches - before).toBe(3);
  });

  it("a manual full sync asked during an incremental one runs after it", async () => {
    const before = searches;
    const incremental = mod.syncActiveUsers();
    // The incremental run has reached Jira: the manual full one comes during it.
    await vi.waitFor(() => expect(searches).toBeGreaterThan(before));
    const full = await caller.issues.sync();
    await incremental;
    expect(full.full).toBe(true);
    expect(searches - before).toBe(2 + 3);
  });

  it("the scheduler runs a full sync when the last full one is over an hour old", async () => {
    const users = await mod.activeUsers();
    expect(await mod.needsFullSync(users[0].id)).toBe(false);
    (await q("UPDATE sync_state SET last_full_sync_at = ?", Date.now() - 61 * 60_000));
    expect(await mod.needsFullSync(users[0].id)).toBe(true);
    const before = searches;
    await mod.syncActiveUsers();
    expect(searches - before).toBe(3);
    expect(await mod.needsFullSync(users[0].id)).toBe(false);
  });

  it("records failures without throwing", async () => {
    jiraDown = true;
    expect(await mod.syncActiveUsers()).toEqual({ ok: 0, failed: 1 });
    expect((await caller.issues.syncStatus()).lastError).toBeTruthy();
    jiraDown = false;
    await mod.syncActiveUsers();
    expect((await caller.issues.syncStatus()).lastError).toBeNull();
  });

  it("starts no sync once shutdown began", async () => {
    const shutdown = await import("./lib/shutdown");
    const before = searches;
    shutdown.beginShutdown();
    try {
      expect(await mod.syncActiveUsers()).toEqual({ ok: 0, failed: 0 });
      await expect(caller.issues.sync()).rejects.toThrow(/shutting down/);
      expect(searches).toBe(before);
    } finally {
      shutdown.resetShutdownForTests();
    }
  });

  it("first pass soon after boot, then every interval; stop waits for the pass", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stop = mod.startSyncScheduler(5);
      let before = searches;
      await vi.advanceTimersByTimeAsync(mod.FIRST_SYNC_DELAY_MS);
      expect(searches).toBeGreaterThan(before); // ran at +30s, not at +5min
      before = searches;
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(searches).toBe(before); // not yet
      await vi.advanceTimersByTimeAsync(60_000 + 1000);
      expect(searches).toBeGreaterThan(before); // the next one, 5 min later
      await stop();
      const after = searches;
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(searches).toBe(after); // stopped for good
    } finally {
      vi.useRealTimers();
    }
  });

  it("a revoked token sets the connection aside to be reconnected instead of retrying forever", async () => {
    tokenRevoked = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await mod.syncActiveUsers()).toEqual({ ok: 0, failed: 1 });
      expect(await mod.activeUsers()).toHaveLength(0);
      const before = searches;
      expect(await mod.syncActiveUsers()).toEqual({ ok: 0, failed: 0 });
      expect(searches).toBe(before);
    } finally {
      tokenRevoked = false;
      warn.mockRestore();
    }
  });

  it("skips users who logged out", async () => {
    await caller.auth.logout();
    expect(await mod.activeUsers()).toHaveLength(0);
  });
});
