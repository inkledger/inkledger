import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "52.1.2.3", family: 4 }]),
}));

/** The contract's fake tracker stands for the Jira (as "gitlab": the core only knows it by its connection). */
const fakes = vi.hoisted((): { tracker: unknown } => ({ tracker: null }));
vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  return {
    ...real,
    trackerAdapter: (type: Parameters<typeof real.trackerAdapter>[0]) => (type === "gitlab" ? fakes.tracker : real.trackerAdapter(type)),
  };
});

describe("a time sink standing in for its tracker (Tempo for its Jira)", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  type Sim = ReturnType<typeof import("../providers/tempo/simulator").tempoSimulator>;
  let caller: Caller;
  let sim: Sim;
  let userId = 0;
  let trackerId = 0;
  let tempoId = 0;
  let issueId = 0;
  let down = false;
  /** Tempo takes the next write but answers outside its API (the answer lost on the way, a proxy's page). */
  let garbleNext = false;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  const push = async () => (await import("./extraSinks")).pushSinks(userId);
  type Entries = { list(x: unknown, ref: { remoteId: string; key: string }): Promise<{ remoteId: string; span: { seconds: number } }[]> };
  const nativeEntries = () => (fakes.tracker as { worklogs: Entries }).worklogs.list({}, { remoteId: String(issueId), key: "FAKE-1" });
  const row = async (id: number) =>
    (await q<{ remote_id: string; seconds: number }>("SELECT jira_worklog_id AS remote_id, time_spent_seconds AS seconds FROM worklogs WHERE id = ?", id))[0];
  const tempoRow = async (id: number) => (await q<{ state: string; remote_id: string | null }>("SELECT state, remote_id FROM worklog_sinks WHERE worklog_id = ? AND sink_connection_id = ?", id, tempoId))[0];

  beforeAll(async () => {
    const { tempoSimulator } = await import("../providers/tempo/simulator");
    sim = tempoSimulator();
    const issue = sim.issue("FAKE-1");
    issueId = issue.id;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      if (down) return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }));
      if (garbleNext && init?.method === "POST") {
        garbleNext = false;
        return Promise.resolve(sim.fetch(input, init)).then(() => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }));
      }
      return sim.fetch(input, init);
    });
    const { fakeTracker } = await import("../providers/fake/adapter");
    fakes.tracker = fakeTracker([{ key: "FAKE-1", title: "First", remoteId: String(issue.id) }]);
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('c', 'C', 1) RETURNING id");
    userId = u.id;
    const [t] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', '{\"region\":\"eu\"}', 'x', 1) RETURNING id", u.id);
    trackerId = t.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", t.id), t.id);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, 'FAKE-1', 'First', 'To Do', 'FAKE', 'Fake', 'https://fake.example/FAKE-1', 1)", u.id, t.id, String(issue.id));
    // Tempo, not linked to the tracker yet, writes not allowed yet (not verified on a real account).
    const [s] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'tempo', ?, ?, '{}', 'x', 1) RETURNING id", u.id, sim.apiBase, sim.me.accountId);
    tempoId = s.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret(sim.token, s.id), s.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  let before = 0;

  it("not linked, or not allowed to write: the tracker's own worklogs, Tempo untouched", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-14T09:00:00+02:00", comment: "before" });
    before = made.id;
    expect((await nativeEntries()).length).toBe(1);
    expect(sim.worklogs).toEqual([]);
    // Linked but its writes not allowed: still the tracker's.
    await q("UPDATE connections SET options = ? WHERE id = ?", JSON.stringify({ jiraConnectionId: trackerId, accountId: sim.me.accountId }), tempoId);
    const second = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: "2026-10-14T11:00:00+02:00", comment: "" });
    expect((await nativeEntries()).length).toBe(2);
    expect(sim.worklogs).toEqual([]);
    await caller.worklogs.delete({ id: second.id });
    await caller.connections.allowWrites({ id: tempoId, on: true });
  });

  it("linked: a new worklog goes to Tempo, the worklog keeps the Jira id Tempo made, the tracker isn't written", async () => {
    const native = (await nativeEntries()).length;
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: "2026-10-15T09:00:00+02:00", comment: "on tempo" });
    expect(sim.worklogs).toHaveLength(1);
    const [w] = sim.worklogs;
    expect(w).toMatchObject({ issueId, timeSpentSeconds: 3600, startDate: "2026-10-15", author: sim.me.accountId });
    expect(await row(made.id)).toEqual({ remote_id: String(w.jiraWorklogId), seconds: 3600 });
    expect(await tempoRow(made.id)).toEqual({ state: "synced", remote_id: String(w.tempoWorklogId) });
    expect((await nativeEntries()).length).toBe(native);

    // Changed and deleted there too.
    await caller.worklogs.update({ id: made.id, seconds: 5400, started: "2026-10-15T09:00:00+02:00", comment: "longer" });
    expect(sim.worklogs[0]).toMatchObject({ timeSpentSeconds: 5400 });
    expect((await nativeEntries()).length).toBe(native);
    await caller.worklogs.delete({ id: made.id });
    expect(sim.worklogs).toEqual([]);
    expect(await q("SELECT count(*)::int AS n FROM worklogs WHERE id = ?", made.id)).toEqual([{ n: 0 }]);
    // To the trash with its Jira id: Jira's own feed won't bring it back while its delete is on the way.
    expect(await q("SELECT reason, remote_id FROM worklog_trash WHERE issue_key = 'FAKE-1' AND time_spent_seconds = 5400")).toEqual([{ reason: "user", remote_id: String(w.jiraWorklogId) }]);
  });

  it("a worklog from before Tempo stays the tracker's: changed there, not on Tempo", async () => {
    await caller.worklogs.update({ id: before, seconds: 2400, started: "2026-10-14T09:00:00+02:00", comment: "before" });
    expect((await nativeEntries()).find((e) => e.span.seconds === 2400)).toBeTruthy();
    expect(sim.worklogs).toEqual([]);
  });

  it("Tempo out of reach: kept here, pending; sent on a later pass, then with its Jira id", async () => {
    down = true;
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-16T09:00:00+02:00", comment: "" });
    down = false;
    expect((await row(made.id)).remote_id).toMatch(/^new-/);
    expect(await tempoRow(made.id)).toMatchObject({ state: "pending", remote_id: null });
    // Changed while still waiting: the pending create sends the new length.
    await caller.worklogs.update({ id: made.id, seconds: 1200, started: "2026-10-16T09:00:00+02:00", comment: "" });
    expect(sim.worklogs).toEqual([]);
    await push();
    expect(sim.worklogs).toHaveLength(1);
    expect(sim.worklogs[0]).toMatchObject({ timeSpentSeconds: 1200 });
    expect(await row(made.id)).toEqual({ remote_id: String(sim.worklogs[0].jiraWorklogId), seconds: 1200 });
    await caller.worklogs.delete({ id: made.id });
  });

  it("deleted while Tempo is out of reach: queued, gone there on a later pass", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-17T09:00:00+02:00", comment: "" });
    expect(sim.worklogs).toHaveLength(1);
    down = true;
    await caller.worklogs.delete({ id: made.id });
    down = false;
    expect(sim.worklogs).toHaveLength(1);
    await push();
    expect(sim.worklogs).toEqual([]);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("Tempo took it but answered outside its API: kept here, pending, and on Tempo once after the next pass", async () => {
    const at = "2026-10-19T09:00:00+02:00";
    garbleNext = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: at, comment: "odd" });
      expect(await tempoRow(made.id)).toMatchObject({ state: "pending" });
      await push();
      expect(sim.worklogs.filter((w) => w.timeSpentSeconds === 900 && w.description.endsWith("\nodd"))).toHaveLength(1);
      expect(await tempoRow(made.id)).toMatchObject({ state: "synced" });
      await caller.worklogs.delete({ id: made.id });
    } finally {
      garbleNext = false;
      quiet.mockRestore();
    }
  });

  it("a pending entry another server process is sending is left to it; past its lease, sent", async () => {
    const at = "2026-10-20T09:00:00+02:00";
    down = true;
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "leased" });
    down = false;
    const n = sim.worklogs.length;
    await q("UPDATE worklog_sinks SET claimed_at = ? WHERE worklog_id = ? AND sink_connection_id = ?", Date.now(), made.id, tempoId);
    await push();
    expect(sim.worklogs).toHaveLength(n);
    expect(await tempoRow(made.id)).toMatchObject({ state: "pending" });
    // Its sender died: the lease runs out, the next pass sends it.
    await q("UPDATE worklog_sinks SET claimed_at = ? WHERE worklog_id = ? AND sink_connection_id = ?", Date.now() - 10 * 60_000, made.id, tempoId);
    await push();
    expect(sim.worklogs).toHaveLength(n + 1);
    expect(await q("SELECT state, claimed_at FROM worklog_sinks WHERE worklog_id = ? AND sink_connection_id = ?", made.id, tempoId)).toEqual([{ state: "synced", claimed_at: null }]);
    await caller.worklogs.delete({ id: made.id });
  });

  it("Tempo can't stop standing in while it still has that tracker's time to send", async () => {
    const at = "2026-10-21T09:00:00+02:00";
    down = true;
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "waiting" });
    down = false;
    await expect(caller.connections.standIn({ id: tempoId, trackerId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    // Still the stand-in, still sent on the next pass.
    await push();
    expect(await tempoRow(made.id)).toMatchObject({ state: "synced" });
    await caller.worklogs.delete({ id: made.id });
  });

  it("refused by Tempo: nothing kept", async () => {
    sim.revoke();
    try {
      await expect(caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-18T09:00:00+02:00", comment: "" })).rejects.toThrow();
      expect(await q("SELECT count(*)::int AS n FROM worklogs WHERE started = ?", Date.parse("2026-10-18T09:00:00+02:00"))).toEqual([{ n: 0 }]);
    } finally {
      sim.unrevoke();
    }
  });

  it("linking from Settings: only a connection of its tracker's kind, with that tracker's account", async () => {
    // The fake tracker isn't a Jira: refused.
    await expect(caller.connections.standIn({ id: tempoId, trackerId })).rejects.toThrow(/stand in/);
    // A tracker connection isn't a stand-in sink.
    await expect(caller.connections.standIn({ id: trackerId, trackerId: null })).rejects.toThrow(/stand in/);
    await caller.connections.standIn({ id: tempoId, trackerId: null });
    expect(await q("SELECT options FROM connections WHERE id = ?", tempoId)).toEqual([{ options: "{}" }]);
    const shown = (await caller.connections.list()).find((c) => c.id === tempoId);
    expect(shown?.standsIn).toEqual({ tracker: "jira", connectionId: null });
  });
});
