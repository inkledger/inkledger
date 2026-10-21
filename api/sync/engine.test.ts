import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { timeZone } from "@contracts/values";

type Q = typeof import("../queries/connection").q;
const q: Q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

const seed = [
  { key: "FAKE-1", title: "First" },
  { key: "FAKE-2", title: "Second", category: "doing" as const },
  { key: "FAKE-3", title: "Third" },
  { key: "OPS-4", title: "Fourth", category: "done" as const },
];

describe("sync engine, through the provider contract", () => {
  let connId = 0;
  let userId = 0;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('eng', 'Eng', ?) RETURNING id", Date.now());
    userId = u.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM worklogs WHERE user_id = ?", userId);
    await q("DELETE FROM issues WHERE user_id = ?", userId);
    await q("DELETE FROM connections WHERE user_id = ?", userId);
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'github', 'https://fake.example', 'me', '{\"region\":\"eu\"}', 'x', ?) RETURNING id",
      userId,
      Date.now(),
    );
    connId = c.id;
    await (await import("./engine")).forgetProbes();
  });

  type Fake = ReturnType<typeof import("../providers/fake/adapter").fakeTracker>;
  async function setup(o: Parameters<typeof import("../providers/fake/adapter").fakeTracker>[1] = {}, tamper: (f: Fake) => Fake = (f) => f) {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { bindTracker } = await import("../providers/core/bind");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const fake = fakeTracker(seed, o);
    const [row] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const bound = bindTracker(tamper(fake), { id: connId, userId, type: "github", baseUrl: "https://fake.example", remoteAccountId: "me", options: { region: "eu" }, timeZone: timeZone("Europe/Rome"), credential: async () => ({ kind: "token", token: "t" }) });
    const { syncConnectionIssues } = await import("./engine");
    const run = (opts: { full?: boolean; background?: boolean } = {}) => syncConnectionIssues(row, { full: opts.full ?? false, background: opts.background ?? true, bound });
    return { fake, run, row };
  }

  const catalog = () => q<{ key: string; summary: string; status_category: string; gone_reason: string | null }>("SELECT key, summary, status_category, gone_reason FROM issues WHERE connection_id = ? ORDER BY key", connId);
  const state = async () => (await q<{ checkpoint: string | null; failures: number; retry_after: number | null; lease_owner: string | null; last_full_at: number | null }>("SELECT * FROM connection_sync WHERE connection_id = ?", connId))[0];

  it("a first pass fills the catalogue page by page; the checkpoint is kept only at its end; the next pass reads only what changed", async () => {
    const { fake, run } = await setup({ pageSize: 2 });
    const first = await run({ full: true });
    expect(first).toMatchObject({ ran: true, result: { seen: 4, gone: 0, missing: 0 } });
    expect((await catalog()).map((r) => [r.key, r.status_category])).toEqual([
      ["FAKE-1", "To Do"],
      ["FAKE-2", "In Progress"],
      ["FAKE-3", "To Do"],
      ["OPS-4", "Done"],
    ]);
    const s = await state();
    expect(s.checkpoint).toMatch(/^cp1\./);
    expect(s.lease_owner).toBeNull();
    expect(s.last_full_at).not.toBeNull();
    fake.outside.edit("FAKE-2", "Second, edited");
    const next = await run();
    expect(next).toMatchObject({ ran: true, result: { seen: 1 } });
    expect((await catalog()).find((r) => r.key === "FAKE-2")?.summary).toBe("Second, edited");
  });

  it("probes the tracker once a day, the probe kept on the connection (not in a process's memory)", async () => {
    let probes = 0;
    const { run } = await setup({}, (f) => {
      const probe: typeof f.probe = async (...args) => {
        probes++;
        return f.probe(...args);
      };
      return Object.assign(Object.create(Object.getPrototypeOf(f) as object) as Fake, f, { probe });
    });
    await run({ full: true });
    await run();
    expect(probes).toBe(1);
    const [row] = await q<{ probe: string | null; probed_at: number | null }>("SELECT probe, probed_at FROM connections WHERE id = ?", connId);
    expect(JSON.parse(row.probe ?? "{}")).toHaveProperty("rateLimit");
    // Its credentials changed: probed again.
    await (await import("./engine")).forgetProbes(connId);
    await run();
    expect(probes).toBe(2);
  });

  it("a new key on the same issue renames its row; the old key stays an alias", async () => {
    const { fake, run } = await setup();
    await run({ full: true });
    fake.outside.rename("FAKE-1", "NEW-1");
    await run();
    expect((await catalog()).map((r) => r.key)).toContain("NEW-1");
    expect((await catalog()).map((r) => r.key)).not.toContain("FAKE-1");
    expect(await q("SELECT a.key FROM item_aliases a JOIN issues i ON i.id = a.item_id WHERE i.key = 'NEW-1'")).toEqual([{ key: "FAKE-1" }]);
  });

  it("a transfer to a new id carries the issue's time and notes to its successor", async () => {
    const { fake, run } = await setup();
    await run({ full: true });
    const [old] = await q<{ id: number }>("SELECT id FROM issues WHERE connection_id = ? AND key = 'FAKE-3'", connId);
    await q(
      "INSERT INTO worklogs (user_id, connection_id, item_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, 'FAKE-3', 'w-1', 1800, ?, ?)",
      userId,
      connId,
      old.id,
      Date.now(),
      Date.now(),
    );
    fake.outside.moveWithNewId("FAKE-3", "OPS-9");
    expect(await run()).toMatchObject({ ran: true, result: { gone: 1 } });
    const rows = await catalog();
    expect(rows.find((r) => r.key === "FAKE-3")?.gone_reason).toBe("transferred");
    expect(rows.find((r) => r.key === "OPS-9")?.gone_reason).toBeNull();
    expect(await q("SELECT issue_key FROM worklogs WHERE jira_worklog_id = 'w-1'")).toEqual([{ issue_key: "OPS-9" }]);
    expect(await q("SELECT a.key FROM item_aliases a JOIN issues i ON i.id = a.item_id WHERE i.key = 'OPS-9'")).toEqual([{ key: "FAKE-3" }]);
  });

  it("a full pass asks for what it didn't list: gone silently is missing (kept, marked), never deleted", async () => {
    const { fake, run } = await setup();
    await run({ full: true });
    fake.outside.vanish("FAKE-1");
    expect(await run({ full: true })).toMatchObject({ ran: true, result: { missing: 1 } });
    expect((await catalog()).find((r) => r.key === "FAKE-1")?.gone_reason).toBe("missing");
    // An incremental pass never concludes missing.
    fake.outside.vanish("FAKE-2");
    expect(await run()).toMatchObject({ ran: true, result: { missing: 0 } });
  });

  describe("the stream's state", () => {
    it("one process at a time: a live lease is respected, an expired one taken over", async () => {
      const { run } = await setup();
      await q("INSERT INTO connection_sync (connection_id, stream, lease_owner, lease_until) VALUES (?, 'issues', 'other-process', ?)", connId, Date.now() + 60_000);
      expect(await run({ full: true })).toMatchObject({ ran: false, reason: "busy" });
      expect(await run({ full: true, background: false })).toMatchObject({ ran: false, reason: "busy" });
      await q("UPDATE connection_sync SET lease_until = ? WHERE connection_id = ?", Date.now() - 1, connId);
      expect(await run({ full: true })).toMatchObject({ ran: true });
    });

    it("a rate limit makes background passes wait for its Retry-After; a pass the user asks for goes anyway", async () => {
      const { run } = await setup();
      const { failed } = await import("./state");
      const { ProviderError } = await import("../providers/core/errors");
      await q("INSERT INTO connection_sync (connection_id, stream, lease_owner, lease_until) VALUES (?, 'issues', (SELECT 1)::text, 0)", connId);
      await q("UPDATE connection_sync SET lease_owner = ? WHERE connection_id = ?", (await import("./state")).PROCESS_ID, connId);
      await failed(connId, "issues", new ProviderError("rateLimit", "slow down", { rateLimit: { retryAfterMs: 120_000 } }));
      const s = await state();
      expect(Number(s.retry_after) - Date.now()).toBeGreaterThan(100_000);
      expect(await run()).toMatchObject({ ran: false, reason: "waiting" });
      expect(await run({ background: false })).toMatchObject({ ran: true });
      expect((await state()).retry_after).toBeNull();
    });

    it("failures back off from the second in a row; refused credentials mark the connection until a pass succeeds; an unusable checkpoint is dropped", async () => {
      const { run } = await setup();
      await run({ full: true });
      const { failed, backoffMs, PROCESS_ID } = await import("./state");
      const { ProviderError } = await import("../providers/core/errors");
      expect([1, 2, 3, 4].map(backoffMs)).toEqual([0, 60_000, 120_000, 240_000]);
      const hold = () => q("UPDATE connection_sync SET lease_owner = ? WHERE connection_id = ?", PROCESS_ID, connId);
      await hold();
      await failed(connId, "issues", new ProviderError("auth", "token revoked"));
      expect(await q("SELECT status FROM connections WHERE id = ?", connId)).toEqual([{ status: "auth_failed" }]);
      await hold();
      await failed(connId, "issues", new ProviderError("invalidCheckpoint", "old format"));
      expect(await state()).toMatchObject({ checkpoint: null, failures: 2 });
      expect(await run({ background: false })).toMatchObject({ ran: true });
      expect(await q("SELECT status FROM connections WHERE id = ?", connId)).toEqual([{ status: "ok" }]);
      expect((await state()).failures).toBe(0);
    });

    it("an adapter whose page token comes back fails the pass as incompatible, and keeps the old checkpoint", async () => {
      let looping = false;
      const { run } = await setup({}, (f) => ({ ...f, listChanged: (x, q) => (looping ? Promise.resolve({ last: false as const, items: [], gone: [], next: "pg1.same" as never }) : f.listChanged(x, q)) }));
      await run({ full: true });
      const before = (await state()).checkpoint;
      looping = true;
      await expect(run({ background: false })).rejects.toMatchObject({ kind: "incompatible" });
      expect((await state()).checkpoint).toBe(before);
    });
  });
});

describe("call budget", () => {
  it("spaces calls at the stricter rate and stops when the call is cancelled", async () => {
    const { budgetOf } = await import("./budget");
    let now = 0;
    const waits: number[] = [];
    const clock = { now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } };
    const b = budgetOf({ perSecond: 10, perHour: 3600 }, clock);
    for (let i = 0; i < 3; i++) await b.take();
    expect(waits).toEqual([1000, 1000]);
    const real = budgetOf({ perSecond: 1 });
    await real.take();
    const ctl = new AbortController();
    const waiting = real.take(ctl.signal);
    ctl.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
  });
});
