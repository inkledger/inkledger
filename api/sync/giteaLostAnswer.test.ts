import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

// Gitea's tracked time keeps no words and reports the start sent as its creation time: a create
// whose answer was lost is told from a twin logged by hand only by the second its start was sent with.
describe("gitea: a write whose answer was lost, beside a twin logged by hand", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  type Sim = ReturnType<typeof import("../providers/gitea/simulator").giteaSimulator>;
  let caller: Caller;
  let sim: Sim;
  let connId = 0;
  const key = "acme/web#1";
  /** A create lands, its answer never comes back. */
  let loseAnswer = false;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  beforeAll(async () => {
    const { giteaSimulator } = await import("../providers/gitea/simulator");
    sim = giteaSimulator();
    sim.add("acme/web", "Login fails on Safari");
    await (await import("../queries/connection")).resetDbForTests();
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const res = await sim.fetch(url, init);
      if (loseAnswer && init?.method === "POST" && String(url).endsWith("/times")) return new Response(null, { status: 504 });
      return res;
    });
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('t', 'T', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, writes_allowed, created_at) VALUES (?, 'gitea', ?, ?, '{}', 'x', 1, 1) RETURNING id", u.id, sim.apiBase, String(sim.me.id));
    connId = c.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("gt_test", c.id), c.id);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 'Login', 'Open', 'acme/web', 'acme/web', 'u', 1)", u.id, c.id, String(sim.issues[0].id), key);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const replay = async () => {
    const { replayContract } = await import("./timeWrites");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    return replayContract(conn);
  };
  const sinkOf = async (id: number) => (await q<{ remote_id: string | null; state: string }>("SELECT remote_id, state FROM worklog_sinks WHERE worklog_id = ?", id))[0];
  /** What Gitea holds that minute: [id, second of its start, seconds]. */
  const there = (minute: number) => sim.times.filter((t) => Math.floor(t.created / 60_000) * 60_000 === minute).map((t) => [String(t.id), (t.created / 1000) % 60, t.time]);
  const lost = async (started: number, seconds: number, comment: string) => {
    loseAnswer = true;
    try {
      return await caller.worklogs.create({ issueKey: key, seconds, started: new Date(started).toISOString(), comment });
    } finally {
      loseAnswer = false;
    }
  };

  afterEach(async () => {
    loseAnswer = false;
    for (const w of await caller.worklogs.list({ issueKey: key })) await caller.worklogs.delete({ id: w.id });
    sim.times.length = 0;
    await q("DELETE FROM outbox");
  });

  it("a lost create of last week is adopted, not logged again; the twin logged by hand that minute stays its own", async () => {
    const at = Date.parse("2026-11-10T09:00:00+01:00");
    // Logged by hand on Gitea first (to the minute): the same length, the same minute.
    const twin = sim.time(sim.issues[0], { seconds: 1800, created: at });
    const made = await lost(at, 1800, "standup");
    expect(made.remoteId).toMatch(/^pending-/);
    const [, ours] = there(at);
    // Sent at a second of its minute, never the whole minute a twin is logged at.
    expect(ours[1]).toBeGreaterThanOrEqual(1);
    expect(ours[1]).toBeLessThanOrEqual(59);
    expect(await replay()).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    // The time once: ours linked, the twin untouched.
    expect(there(at)).toEqual([[String(twin.id), 0, 1800], ours]);
    expect(await sinkOf(made.id)).toEqual({ remote_id: ours[0], state: "synced" });
    await caller.issues.syncConnection({ id: connId });
    const here = await caller.worklogs.list({ issueKey: key });
    // The worklog keeps the user's start; the twin is read back beside it.
    expect(here.find((w) => w.id === made.id)).toMatchObject({ remoteId: ours[0], started: new Date(at) });
    expect(here.find((w) => w.remoteId === String(twin.id))).toMatchObject({ timeSpentSeconds: 1800 });
    expect(here).toHaveLength(2);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("a lost create of a minute ago never takes the twin logged by hand that minute", async () => {
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    const twin = sim.time(sim.issues[0], { seconds: 600, created: at });
    const made = await lost(at, 600, "");
    const [, ours] = there(at);
    expect(await replay()).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    expect(there(at)).toEqual([[String(twin.id), 0, 600], ours]);
    expect((await sinkOf(made.id))?.remote_id).toBe(ours[0]);
  });

  it("a lost create deleted while queued: only its own entry goes, the twin logged by hand stays", async () => {
    const at = Date.parse("2026-11-11T14:00:00+01:00");
    const twin = sim.time(sim.issues[0], { seconds: 900, created: at });
    const made = await lost(at, 900, "review");
    expect(there(at)).toHaveLength(2);
    await caller.worklogs.delete({ id: made.id });
    expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
    expect(there(at)).toEqual([[String(twin.id), 0, 900]]);
    await caller.issues.syncConnection({ id: connId });
    expect((await caller.worklogs.list({ issueKey: key })).map((w) => w.remoteId)).toEqual([String(twin.id)]);
  });

  it("an edit whose new entry landed with its answer lost: taken at the replay, the old one goes, the time once", async () => {
    const at = Date.parse("2026-11-12T10:00:00+01:00");
    const made = await caller.worklogs.create({ issueKey: key, seconds: 1200, started: new Date(at).toISOString(), comment: "pairing" });
    const first = (await sinkOf(made.id))?.remote_id;
    expect(first).toMatch(/^\d+$/);
    loseAnswer = true;
    try {
      await caller.worklogs.update({ id: made.id, seconds: 1500, started: new Date(at).toISOString(), comment: "pairing" });
    } finally {
      loseAnswer = false;
    }
    expect(sim.times.map((t) => t.time)).toEqual([1200, 1500]);
    expect(await replay()).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    const [landed] = sim.times;
    expect(sim.times.map((t) => t.time)).toEqual([1500]);
    expect(await sinkOf(made.id)).toEqual({ remote_id: String(landed.id), state: "synced" });
  });
  it("a lost create read back by a sync before its replay is linked to its own entry, the twin read back beside it", async () => {
    const at = Date.parse("2026-11-13T11:00:00+01:00");
    const twin = sim.time(sim.issues[0], { seconds: 2400, created: at });
    const made = await lost(at, 2400, "design");
    const [, ours] = there(at);
    // Its replay held by another process: the sync reads the entries first.
    await q("UPDATE outbox SET claimed_at = ?", Date.now());
    await caller.issues.syncConnection({ id: connId });
    expect(await sinkOf(made.id)).toEqual({ remote_id: ours[0], state: "synced" });
    const here = await caller.worklogs.list({ issueKey: key });
    expect(here.map((w) => w.remoteId).sort()).toEqual([String(twin.id), String(ours[0])].sort());
    expect(here.find((w) => w.id === made.id)).toMatchObject({ started: new Date(at) });
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    expect(there(at)).toHaveLength(2);
  });

  it("a lost create deleted while queued, its delete held during a sync: only its own entry is kept out of reads, then deleted", async () => {
    const at = Date.parse("2026-11-14T16:00:00+01:00");
    const twin = sim.time(sim.issues[0], { seconds: 300, created: at });
    const made = await lost(at, 300, "call");
    await caller.worklogs.delete({ id: made.id });
    await q("UPDATE outbox SET claimed_at = ?", Date.now());
    await caller.issues.syncConnection({ id: connId });
    expect((await caller.worklogs.list({ issueKey: key })).map((w) => w.remoteId)).toEqual([String(twin.id)]);
    await q("UPDATE outbox SET claimed_at = NULL");
    expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
    expect(there(at)).toEqual([[String(twin.id), 0, 300]]);
  });
});
