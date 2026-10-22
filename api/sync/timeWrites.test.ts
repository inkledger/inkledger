import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** The test's tracker that keeps entries (the contract's fake, as "gitlab"), and whether it answers. */
type TestTracker = { adapter: unknown; offline: boolean; refuse: boolean; loseAnswer: boolean; calls: string[] };
const tracker: TestTracker = vi.hoisted(() => ({ adapter: null, offline: false, refuse: false, loseAnswer: false, calls: [] }));

vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  return { ...real, trackerAdapter: (type: Parameters<typeof real.trackerAdapter>[0]) => (type === "gitlab" ? tracker.adapter : real.trackerAdapter(type)) };
});

describe("time on a tracker that keeps entries, through the contract (write-through, queue, replay)", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;
  let connId = 0;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  const started = "2026-10-14T09:00:00+02:00";

  beforeAll(async () => {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { ProviderError } = await import("../providers/core/errors");
    const fake = fakeTracker([{ key: "FAKE-1", title: "First" }]);
    const guarded = Object.fromEntries(
      Object.entries(fake.worklogs ?? {}).map(([name, fn]) => [
        name,
        async (...args: unknown[]) => {
          if (tracker.offline) throw new ProviderError("unavailable", "fake: down");
          if (tracker.refuse) throw new ProviderError("invalid", "fake: no");
          tracker.calls.push(name);
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          // It landed, but the answer never came back.
          if (tracker.loseAnswer && name === "create") throw new ProviderError("unavailable", "fake: timed out");
          return out;
        },
      ]),
    );
    tracker.adapter = Object.assign(Object.create(Object.getPrototypeOf(fake) as object), fake, { worklogs: guarded });
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('t', 'T', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', ?, 'x', 1) RETURNING id", u.id, JSON.stringify({ region: "eu" }));
    connId = c.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", c.id), c.id);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'r-1', 'FAKE-1', 'First', 'To Do', 'FAKE', 'Fake', 'u', 1)", u.id, c.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const sinkOf = async (id: number) => (await q<{ remote_id: string | null; state: string }>("SELECT remote_id, state FROM worklog_sinks WHERE worklog_id = ?", id))[0];
  const replay = async () => {
    const { replayContract } = await import("./timeWrites");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    return replayContract(conn);
  };

  it("time logged on the tracker itself shows up at the next sync; removed there, it goes here too", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const { instant } = await import("@contracts/values");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const b = boundTracker(conn)!;
    const meta = { signal: new AbortController().signal, correlationId: "t" };
    const there = await b.worklogs!.create!(meta, { remoteId: "r-1", key: "FAKE-1" }, { time: { kind: "session", start: instant(Date.parse("2026-10-13T15:00:00+02:00")), seconds: 2700 }, comment: "on the tracker" }, { idempotencyKey: "remote-1" });
    const before = await q<{ n: number }>("SELECT count(*)::int AS n FROM worklogs WHERE jira_worklog_id = ?", there.remoteId);
    expect(before).toEqual([{ n: 0 }]);
    await caller.issues.syncConnection({ id: connId });
    expect(await q("SELECT issue_key, time_spent_seconds, comment FROM worklogs WHERE jira_worklog_id = ?", there.remoteId)).toEqual([{ issue_key: "FAKE-1", time_spent_seconds: 2700, comment: "on the tracker" }]);
    await b.worklogs!.delete!(meta, { remoteId: "r-1", key: "FAKE-1" }, there.remoteId, {});
    await caller.issues.syncConnection({ id: connId });
    expect(await q("SELECT count(*)::int AS n FROM worklogs WHERE jira_worklog_id = ?", there.remoteId)).toEqual([{ n: 0 }]);
    tracker.calls.length = 0;
  });

  it("logs, changes and deletes on the tracker at once", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started, comment: "on it" });
    expect(made.remoteId).not.toMatch(/^(new|pending)-/);
    expect(await sinkOf(made.id)).toEqual({ remote_id: made.remoteId, state: "synced" });
    const changed = await caller.worklogs.update({ id: made.id, seconds: 2400, started, comment: "longer" });
    expect(changed).toMatchObject({ timeSpentSeconds: 2400, comment: "longer" });
    await caller.worklogs.delete({ id: made.id });
    expect(tracker.calls).toEqual(["create", "update", "delete"]);
    expect(await caller.worklogs.list({ issueKey: "FAKE-1" })).toEqual([]);
  });

  it("while the tracker can't be reached: kept here and queued, then sent in order when it answers", async () => {
    tracker.calls = [];
    tracker.offline = true;
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started, comment: "offline" });
    expect(made.remoteId).toMatch(/^pending-\d+$/);
    expect(await sinkOf(made.id)).toEqual({ remote_id: null, state: "pending" });
    // Edited while queued: the queued create carries the new time.
    await caller.worklogs.update({ id: made.id, seconds: 900, started, comment: "offline, longer" });
    expect(await replay()).toMatchObject({ synced: 0, failed: 1 });
    tracker.offline = false;
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    const [now] = await caller.worklogs.list({ issueKey: "FAKE-1" });
    expect(now).toMatchObject({ id: made.id, timeSpentSeconds: 900, comment: "offline, longer" });
    expect(now.remoteId).not.toMatch(/^pending-/);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    // Deleted offline: gone here at once, from the tracker at the next replay.
    tracker.offline = true;
    await caller.worklogs.delete({ id: made.id });
    expect(await caller.worklogs.list({ issueKey: "FAKE-1" })).toEqual([]);
    tracker.offline = false;
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    // Before logging it again, the replay looks whether it already landed.
    expect(tracker.calls).toEqual(["list", "create", "delete"]);
  });

  it("refused by the tracker: nothing is kept, the reason comes back", async () => {
    const trashed = (await caller.worklogs.trash()).length;
    tracker.refuse = true;
    try {
      await expect(caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started, comment: "" })).rejects.toThrow(/fake: no/);
      expect(await caller.worklogs.list({ issueKey: "FAKE-1" })).toEqual([]);
      // Never kept, so nothing to the trash either.
      expect(await caller.worklogs.trash()).toHaveLength(trashed);
    } finally {
      tracker.refuse = false;
    }
  });

  it("a create that landed but whose answer was lost is adopted at the replay, not logged twice", async () => {
    tracker.calls = [];
    tracker.loseAnswer = true;
    // A key no idempotency can match: the service took it under another (as one without native keys would).
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: "2026-10-15T09:00:00+02:00", comment: "lost" });
    tracker.loseAnswer = false;
    expect(made.remoteId).toMatch(/^pending-/);
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    expect(tracker.calls).toEqual(["create", "list"]);
    const [now] = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === made.id);
    expect(now.remoteId).not.toMatch(/^pending-/);
    expect(now.sink.state).toBe("synced");
    await caller.worklogs.delete({ id: made.id });
  });

  it("a lost answer's replay never takes a twin's entry: an older worklog with the same time keeps its own", async () => {
    const started2 = "2026-10-18T09:00:00+02:00";
    const twin = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: started2, comment: "twin" });
    const twinEntry = (await sinkOf(twin.id))?.remote_id;
    expect(twinEntry).toBeTruthy();
    tracker.loseAnswer = true;
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: started2, comment: "mine" });
    tracker.loseAnswer = false;
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    const rows = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === twin.id || w.id === made.id);
    expect(rows.map((w) => w.id).sort()).toEqual([twin.id, made.id].sort());
    expect((await sinkOf(twin.id))?.remote_id).toBe(twinEntry);
    expect((await sinkOf(made.id))?.remote_id).not.toBe(twinEntry);
    await caller.worklogs.delete({ id: made.id });
    await caller.worklogs.delete({ id: twin.id });
  });

  it("a lost answer's replay never takes a newer twin's entry either: one logged while it was queued keeps its own", async () => {
    const started3 = "2026-10-19T09:00:00+02:00";
    tracker.offline = true;
    const queued = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: started3, comment: "queued" });
    tracker.offline = false;
    const twin = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: started3, comment: "twin" });
    expect(twin.id).toBeGreaterThan(queued.id);
    const twinEntry = (await sinkOf(twin.id))?.remote_id;
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    const ids = (await caller.worklogs.list({ issueKey: "FAKE-1" })).map((w) => w.id);
    expect(ids).toContain(twin.id);
    expect(ids).toContain(queued.id);
    expect((await sinkOf(twin.id))?.remote_id).toBe(twinEntry);
    expect((await sinkOf(queued.id))?.remote_id).not.toBe(twinEntry);
    await caller.worklogs.delete({ id: queued.id });
    await caller.worklogs.delete({ id: twin.id });
  });

  it("a worklog locked on its tracker can't be changed or deleted here; a conflict is settled either way", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-16T09:00:00+02:00", comment: "to lock" });
    await q("UPDATE worklog_sinks SET locked = ? WHERE worklog_id = ?", JSON.stringify({ cause: "approved", message: "Approved by the team lead" }), made.id);
    await expect(caller.worklogs.update({ id: made.id, seconds: 600, started: "2026-10-16T09:00:00+02:00", comment: "" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Approved by the team lead") });
    await expect(caller.worklogs.delete({ id: made.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [listed] = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === made.id);
    expect(listed.sink.locked).toEqual({ cause: "approved", message: "Approved by the team lead" });
    await q("UPDATE worklog_sinks SET locked = NULL WHERE worklog_id = ?", made.id);

    // In conflict: take theirs.
    await q("UPDATE worklog_sinks SET state = 'conflict', remote_snapshot = ? WHERE worklog_id = ?", JSON.stringify({ seconds: 900, started: Date.parse("2026-10-16T09:00:00+02:00"), comment: "theirs" }), made.id);
    const theirs = await caller.worklogs.resolveConflict({ id: made.id, keep: "theirs" });
    expect(theirs).toMatchObject({ timeSpentSeconds: 900, comment: "theirs" });
    // In conflict again: keep mine (sent over theirs).
    tracker.calls = [];
    await q("UPDATE worklog_sinks SET state = 'conflict', remote_snapshot = ? WHERE worklog_id = ?", JSON.stringify({ seconds: 300, started: Date.parse("2026-10-16T09:00:00+02:00"), comment: "theirs again" }), made.id);
    const mine = await caller.worklogs.resolveConflict({ id: made.id, keep: "mine" });
    expect(mine).toMatchObject({ timeSpentSeconds: 900, comment: "theirs" });
    expect(tracker.calls).toEqual(["update"]);
    expect(await sinkOf(made.id)).toMatchObject({ state: "synced" });
    await expect(caller.worklogs.resolveConflict({ id: made.id, keep: "mine" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keep mine, refused by the tracker: the conflict stays as it was, theirs kept beside it, to settle again", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: "2026-10-17T09:00:00+02:00", comment: "mine" });
    const snapshot = JSON.stringify({ seconds: 600, started: Date.parse("2026-10-17T09:00:00+02:00"), comment: "theirs" });
    await q("UPDATE worklog_sinks SET state = 'conflict', remote_snapshot = ? WHERE worklog_id = ?", snapshot, made.id);
    tracker.refuse = true;
    try {
      await expect(caller.worklogs.resolveConflict({ id: made.id, keep: "mine" })).rejects.toThrow();
    } finally {
      tracker.refuse = false;
    }
    expect(await q("SELECT state, remote_snapshot FROM worklog_sinks WHERE worklog_id = ?", made.id)).toEqual([{ state: "conflict", remote_snapshot: snapshot }]);
    const mine = await caller.worklogs.resolveConflict({ id: made.id, keep: "mine" });
    expect(mine).toMatchObject({ timeSpentSeconds: 1200, comment: "mine" });
    expect(await sinkOf(made.id)).toMatchObject({ state: "synced" });
    await caller.worklogs.delete({ id: made.id });
  });
});
