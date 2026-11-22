import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHmac } from "node:crypto";

process.env.DATABASE_URL = ":memory:";

const reads = vi.hoisted(() => [] as number[]);
const jiraPasses = vi.hoisted(() => [] as { id: number; full: boolean }[]);
const jiraGate = vi.hoisted(() => ({ wait: Promise.resolve() }));
vi.mock("./sync/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sync/engine")>();
  return {
    ...real,
    syncConnectionIssues: vi.fn(async (conn: { id: number }) => { reads.push(conn.id); return { ran: true }; }),
  };
});
// Jira's own pass: recorded, never a request.
vi.mock("./sync/jiraIssues", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sync/jiraIssues")>();
  return {
    ...real,
    runSync: vi.fn(async (_user: unknown, conn: { id: number }, full: boolean) => {
      jiraPasses.push({ id: conn.id, full });
      await jiraGate.wait;
      return { synced: 0, at: new Date(), full, outbox: { synced: 0, failed: 0, remaining: 0 } };
    }),
  };
});

/** Webhooks (D5): off by default; on, each delivery is checked before the connection reads again. */
describe("webhooks", () => {
  type Caller = ReturnType<typeof import("./router").appRouter.createCaller>;
  let caller: Caller;
  let gh = 0;
  let jira = 0;
  const q: typeof import("./queries/connection").q = async (text, ...params) => (await import("./queries/connection")).q(text, ...params);

  beforeAll(async () => {
    await (await import("./queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('h', 'H', 1) RETURNING id");
    [{ id: gh }] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'github', 'https://api.github.com', '1', '{}', 'x', 1) RETURNING id", u.id);
    [{ id: jira }] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://acme.atlassian.net', 'me', ?, 'x', 1) RETURNING id",
      u.id,
      JSON.stringify({ deployment: "cloud", authType: "basic", username: "m@x.it" }),
    );
    const { appRouter } = await import("./router");
    const { getDb } = await import("./queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("off by default; on, an address and a secret to register; a signed delivery makes the connection read again soon", async () => {
    vi.useFakeTimers();
    try {
      expect(await caller.connections.webhook({ id: gh })).toEqual({ available: true, on: false });
      await caller.connections.setWebhook({ id: gh, on: true });
      const hook = await caller.connections.webhook({ id: gh });
      if (!hook.on) throw new Error("not on");
      const [, , , id, token] = hook.path.split("/");
      expect(Number(id)).toBe(gh);
      const { takeDelivery } = await import("./hooks");
      const body = JSON.stringify({ action: "edited" });
      const headers = { "x-github-delivery": "d-1", "x-hub-signature-256": sign(hook.secret, body) };
      expect(await takeDelivery(gh, token, { headers, body })).toEqual({ status: 202, reason: "accepted" });
      // A burst makes one read.
      expect(await takeDelivery(gh, token, { headers: { ...headers, "x-github-delivery": "d-2" }, body })).toMatchObject({ status: 202 });
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.waitFor(() => expect(reads).toEqual([gh]));
      // The same delivery again: taken already.
      expect(await takeDelivery(gh, token, { headers, body })).toEqual({ status: 200, reason: "replay" });
      // Wrong token, wrong signature.
      expect(await takeDelivery(gh, "0".repeat(32), { headers, body })).toMatchObject({ status: 404 });
      expect(await takeDelivery(gh, token, { headers: { ...headers, "x-github-delivery": "d-3", "x-hub-signature-256": sign("other", body) }, body })).toMatchObject({ status: 401 });
      // Off again: the old address answers nothing.
      await caller.connections.setWebhook({ id: gh, on: false });
      expect(await takeDelivery(gh, token, { headers: { ...headers, "x-github-delivery": "d-4" }, body })).toMatchObject({ status: 404 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a webhook secret this server can't open (key changed) is off, not a server error", async () => {
    await caller.connections.setWebhook({ id: gh, on: true });
    const hook = await caller.connections.webhook({ id: gh });
    if (!hook.on) throw new Error("not on");
    const token = hook.path.split("/")[4];
    await q("UPDATE connections SET webhook_secret = 'v1:not-a-sealed-secret' WHERE id = ?", gh);
    const { takeDelivery } = await import("./hooks");
    expect(await takeDelivery(gh, token, { headers: {}, body: "{}" })).toEqual({ status: 404, reason: "off" });
    await caller.connections.setWebhook({ id: gh, on: false });
  });

  it("Jira: unsigned deliveries count on the token; a stale one is refused", async () => {
    await caller.connections.setWebhook({ id: jira, on: true });
    const hook = await caller.connections.webhook({ id: jira });
    if (!hook.on) throw new Error("not on");
    const token = hook.path.split("/")[4];
    const { takeDelivery } = await import("./hooks");
    const now = Date.now();
    const fresh = JSON.stringify({ timestamp: now, webhookEvent: "jira:issue_updated" });
    expect(await takeDelivery(jira, token, { headers: { "x-atlassian-webhook-identifier": "j-1" }, body: fresh }, now)).toMatchObject({ status: 202 });
    const old = JSON.stringify({ timestamp: now - 10 * 60_000 });
    expect(await takeDelivery(jira, token, { headers: { "x-atlassian-webhook-identifier": "j-2" }, body: old }, now)).toEqual({ status: 400, reason: "stale" });
    // Signed on Jira: the signature must hold.
    expect(await takeDelivery(jira, token, { headers: { "x-atlassian-webhook-identifier": "j-3", "x-hub-signature": "sha256=00" }, body: fresh }, now)).toMatchObject({ status: 401 });
  });

  /** Pending reads from earlier tests go: each test below starts with none. */
  const noPendingReads = () => {
    const timers = (globalThis as { __iklHookTimers?: Map<number, NodeJS.Timeout> }).__iklHookTimers;
    timers?.forEach((h) => clearTimeout(h));
    timers?.clear();
  };

  it("Jira: a delivery reads through Jira's own pass, never the generic one (it would blank Jira's fields)", async () => {
    noPendingReads();
    const hook = await caller.connections.webhook({ id: jira });
    if (!hook.on) throw new Error("not on");
    const token = hook.path.split("/")[4];
    const { takeDelivery } = await import("./hooks");
    reads.length = 0;
    jiraPasses.length = 0;
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const body = JSON.stringify({ timestamp: now, webhookEvent: "jira:issue_updated" });
      expect(await takeDelivery(jira, token, { headers: { "x-atlassian-webhook-identifier": "j-10" }, body }, now)).toMatchObject({ status: 202 });
      await vi.advanceTimersByTimeAsync(6_000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(jiraPasses).toEqual([{ id: jira, full: false }]));
    expect(reads).not.toContain(jira);
  });

  it("no read starts during a restore or a shutdown, even for a delivery taken just before", async () => {
    noPendingReads();
    const hook = await caller.connections.webhook({ id: jira });
    if (!hook.on) throw new Error("not on");
    const token = hook.path.split("/")[4];
    const { takeDelivery } = await import("./hooks");
    const maintenance = await import("./lib/maintenance");
    const shutdown = await import("./lib/shutdown");
    reads.length = 0;
    jiraPasses.length = 0;
    const deliver = async (id: string, during: () => void) => {
      vi.useFakeTimers();
      try {
        const now = Date.now();
        const body = JSON.stringify({ timestamp: now, webhookEvent: "jira:issue_updated" });
        expect(await takeDelivery(jira, token, { headers: { "x-atlassian-webhook-identifier": id }, body }, now)).toMatchObject({ status: 202 });
        during();
        await vi.advanceTimersByTimeAsync(6_000);
      } finally {
        vi.useRealTimers();
      }
      await new Promise((r) => setTimeout(r, 100));
    };
    try {
      await deliver("j-20", () => maintenance.enterMaintenance("restore"));
      maintenance.leaveMaintenance();
      await deliver("j-21", () => shutdown.beginShutdown());
    } finally {
      maintenance.leaveMaintenance();
      shutdown.resetShutdownForTests();
    }
    expect(jiraPasses).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("a read under way is waited for by a shutdown or a restore", async () => {
    noPendingReads();
    const hook = await caller.connections.webhook({ id: jira });
    if (!hook.on) throw new Error("not on");
    const token = hook.path.split("/")[4];
    const { takeDelivery } = await import("./hooks");
    const { settleInFlightSyncs } = await import("./sync/orchestrator");
    jiraPasses.length = 0;
    let release = () => {};
    jiraGate.wait = new Promise<void>((r) => (release = r));
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const body = JSON.stringify({ timestamp: now, webhookEvent: "jira:issue_updated" });
      expect(await takeDelivery(jira, token, { headers: { "x-atlassian-webhook-identifier": "j-30" }, body }, now)).toMatchObject({ status: 202 });
      await vi.advanceTimersByTimeAsync(6_000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(jiraPasses).toHaveLength(1));
    let settled = false;
    const settling = settleInFlightSyncs(10_000).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    release();
    await settling;
    expect(settled).toBe(true);
    jiraGate.wait = Promise.resolve();
  });

  it("only the owner sees or changes a connection's webhooks; old delivery ids are purged", async () => {
    const [o] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('o', 'O', 1) RETURNING id");
    const { appRouter } = await import("./router");
    const { getDb } = await import("./queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [other] = await getDb().select().from(users).where(eq(users.id, o.id));
    const them = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: other, sessionId: null });
    await expect(them.connections.webhook({ id: gh })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(them.connections.setWebhook({ id: gh, on: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { purgeWebhookDeliveries } = await import("./hooks");
    expect(await purgeWebhookDeliveries(Date.now() + 3 * 86_400_000)).toBeGreaterThan(0);
  });
});
