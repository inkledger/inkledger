import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** The test's tracker that keeps entries (the contract's fake, as "gitlab"), and whether it answers. */
type TestTracker = { adapter: unknown; offline: boolean; refuse: boolean; loseAnswer: boolean; calls: string[]; refuseOnly?: string; downOnly?: string; recreating?: boolean; recreator?: unknown };
const tracker: TestTracker = vi.hoisted(() => ({ adapter: null, offline: false, refuse: false, loseAnswer: false, calls: [] }));

vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  return { ...real, trackerAdapter: (type: Parameters<typeof real.trackerAdapter>[0]) => (type === "gitlab" ? (tracker.recreating ? tracker.recreator : tracker.adapter) : real.trackerAdapter(type)) };
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
    // The tracker as the test sets it: offline, refusing, or losing a create's answer.
    const guard = (fake: ReturnType<typeof fakeTracker>, keyless = false) => {
      const guarded = Object.fromEntries(
      Object.entries(fake.worklogs ?? {}).map(([name, fn]) => [
        name,
        async (...args: unknown[]) => {
          if (tracker.offline) throw new ProviderError("unavailable", "fake: down");
          if (tracker.refuse || tracker.refuseOnly === name) throw new ProviderError("invalid", "fake: no");
          if (tracker.downOnly === name) throw new ProviderError("unavailable", "fake: down");
          tracker.calls.push(name);
          // A key the service doesn't keep (GitLab, Gitea): a retried create is a new entry.
          if (keyless && name === "create") args[3] = { ...(args[3] as object), idempotencyKey: `unkept-${Math.random()}` };
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          // It landed, but the answer never came back.
          if (tracker.loseAnswer && name === "create") throw new ProviderError("unavailable", "fake: timed out");
          return out;
        },
      ]),
    );
      return Object.assign(Object.create(Object.getPrototypeOf(fake) as object), fake, { worklogs: guarded }) as unknown;
    };
    tracker.adapter = guard(fakeTracker([{ key: "FAKE-1", title: "First" }]));
    // One that logs an entry again to change it (GitLab, Gitea).
    tracker.recreator = guard(fakeTracker([{ key: "FAKE-1", title: "First" }], { entryUpdate: false }), true);
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

  it("a lost answer's replay sends the comment changed while it waited, on the entry that landed", async () => {
    const started4 = "2026-10-20T09:00:00+02:00";
    tracker.loseAnswer = true;
    tracker.calls = [];
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: started4, comment: "typo" });
    tracker.loseAnswer = false;
    await caller.worklogs.update({ id: made.id, seconds: 600, started: started4, comment: "fixed" });
    tracker.calls = [];
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    const entry = (await sinkOf(made.id))?.remote_id;
    const [now] = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === made.id);
    expect(now.comment).toBe("fixed");
    expect(now.sink.state).toBe("synced");
    const there = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).getTime() === Date.parse(started4));
    expect(there).toHaveLength(1);
    expect(entry).toBeTruthy();
    expect(tracker.calls).toContain("update");
    await caller.worklogs.delete({ id: made.id });
  });

  it("after adoption, a comment the tracker refuses stays here only; one it can't take now is sent at the next replay", async () => {
    const started5 = "2026-10-21T09:00:00+02:00";
    tracker.loseAnswer = true;
    const refused = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 300, started: started5, comment: "a" });
    tracker.loseAnswer = false;
    await caller.worklogs.update({ id: refused.id, seconds: 300, started: started5, comment: "b" });
    tracker.refuseOnly = "update";
    try {
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    } finally {
      tracker.refuseOnly = undefined;
    }
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    await caller.worklogs.delete({ id: refused.id });

    const started6 = "2026-10-21T11:00:00+02:00";
    tracker.loseAnswer = true;
    const later = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 300, started: started6, comment: "c" });
    tracker.loseAnswer = false;
    await caller.worklogs.update({ id: later.id, seconds: 300, started: started6, comment: "d" });
    tracker.downOnly = "update";
    try {
      expect(await replay()).toMatchObject({ synced: 0 });
    } finally {
      tracker.downOnly = undefined;
    }
    tracker.calls = [];
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    expect(tracker.calls).toContain("update");
    await caller.worklogs.delete({ id: later.id });
  });

  it("where a change logs the entry again, a retry after a lost answer takes the entry that landed: the time once", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    tracker.recreating = true;
    try {
      const there = async (at: string) => {
        const all = await boundTracker(conn)!.worklogs!.list({ signal: new AbortController().signal, correlationId: "t" }, { remoteId: "r-1", key: "FAKE-1" });
        return all.filter((w) => w.span.kind === "session" && w.span.start === Date.parse(at)).map((w) => ({ id: w.remoteId, seconds: w.span.seconds, comment: w.comment }));
      };
      for (const [at, change] of [
        ["2026-10-22T09:00:00+02:00", { seconds: 900, comment: "first" }],
        ["2026-10-22T11:00:00+02:00", { seconds: 600, comment: "words only" }],
      ] as const) {
        const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "first" });
        const [old] = await there(at);
        tracker.loseAnswer = true;
        try {
          await caller.worklogs.update({ id: made.id, started: at, ...change });
        } finally {
          tracker.loseAnswer = false;
        }
        expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
        const now = await there(at);
        expect(now).toEqual([{ id: (await sinkOf(made.id))?.remote_id, ...change }]);
        expect(now[0].id).not.toBe(old.id);
        expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
        await caller.worklogs.delete({ id: made.id });
      }
    } finally {
      tracker.recreating = false;
    }
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

describe("sameWords", () => {
  it("a comment read back trimmed (Jira's copy) is the same comment; other words are not", async () => {
    const { sameWords } = await import("./timeWrites");
    expect(sameWords("fixed login\n", "fixed login")).toBe(true);
    expect(sameWords("  note ", "note")).toBe(true);
    expect(sameWords("two\n\nlines", "two lines")).toBe(true);
    expect(sameWords("", "")).toBe(true);
    expect(sameWords("twin", "queued")).toBe(false);
    expect(sameWords("note", "")).toBe(false);
  });
});
