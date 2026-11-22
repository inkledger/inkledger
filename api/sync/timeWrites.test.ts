import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** The test's tracker that keeps entries (the contract's fake, as "gitlab"), and whether it answers. */
type TestTracker = {
  adapter: unknown; offline: boolean; refuse: boolean; loseAnswer: boolean; calls: string[]; refuseOnly?: string; downOnly?: string; recreating?: boolean; recreator?: unknown;
  /** Its name doesn't resolve from the server: no request ever leaves. */
  unresolved?: boolean;
  unresolvedOnly?: string;
  /** When each entry was made there, by id (the tracker's creation time). */
  made: Map<string, number>;
  /** After the call landed, what the answer turns into (a timeout, an answer outside the contract), by call name. */
  afterLanding?: Partial<Record<string, (signal: AbortSignal) => Promise<unknown>>>;
};
const tracker: TestTracker = vi.hoisted(() => ({ adapter: null, offline: false, refuse: false, loseAnswer: false, calls: [], made: new Map<string, number>() }));

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
          if (tracker.unresolved || tracker.unresolvedOnly === name) throw new ProviderError("unavailable", "fetch failed", { cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }) });
          if (tracker.offline) throw new ProviderError("unavailable", "fake: down");
          if (tracker.refuse || tracker.refuseOnly === name) throw new ProviderError("invalid", "fake: no");
          if (tracker.downOnly === name) throw new ProviderError("unavailable", "fake: down");
          tracker.calls.push(name);
          // A key the service doesn't keep (GitLab, Gitea): a retried create is a new entry.
          if (keyless && name === "create") args[3] = { ...(args[3] as object), idempotencyKey: `unkept-${Math.random()}` };
          const out = await (fn as (...a: unknown[]) => unknown)(...args);
          // Entries carry the time they were made there, as Jira's do.
          if (name === "create") {
            const id = (out as { remoteId: string }).remoteId;
            if (!tracker.made.has(id)) tracker.made.set(id, Date.now());
          }
          const dated = (w: { remoteId: string }) => (tracker.made.has(w.remoteId) ? { ...w, createdAt: tracker.made.get(w.remoteId) } : w);
          if (name === "list") return (out as { remoteId: string }[]).map(dated);
          if (name === "changed") return { ...(out as { items: { remoteId: string }[] }), items: (out as { items: { remoteId: string }[] }).items.map(dated) };
          // It landed, but the answer never came back.
          if (tracker.loseAnswer && name === "create") throw new ProviderError("unavailable", "fake: timed out");
          const after = tracker.afterLanding?.[name];
          if (after) await after((args[0] as { signal: AbortSignal }).signal);
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

  it("the user's own Sync never answers success when every tracker failed; a background pass stays quiet", async () => {
    const { syncUser } = await import("./orchestrator");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const [user] = await getDb().select().from(users).limit(1);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fakeTracker } = await import("../providers/fake/adapter");
    const real = tracker.adapter;
    // The tracker down for everything, its issues too.
    const down = fakeTracker([{ key: "FAKE-1", title: "First" }]);
    const { ProviderError } = await import("../providers/core/errors");
    down.listChanged = async () => { throw new ProviderError("unavailable", "fake: down"); };
    tracker.adapter = down;
    try {
      await expect(caller.issues.sync()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      await expect(syncUser(user, { background: true })).resolves.toMatchObject({ failed: [{ connectionId: connId }] });
    } finally {
      tracker.adapter = real;
      quiet.mockRestore();
    }
    await expect(caller.issues.sync()).resolves.toMatchObject({ failed: [] });
    tracker.calls = [];
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
    // Edited while queued: the replay sends the new time.
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

  /** Rows here and entries there for one start, after the test's own steps. */
  const countsAt = async (startedIso: string) => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const there = await boundTracker(conn)!.worklogs!.list({ signal: new AbortController().signal, correlationId: "t" }, { remoteId: "r-1", key: "FAKE-1" });
    const here = await q<{ id: number }>("SELECT id FROM worklogs WHERE connection_id = ? AND started = ?", connId, Date.parse(startedIso));
    return { here: here.length, there: there.filter((w) => w.span.kind === "session" && Number(w.span.start) === Date.parse(startedIso)).length };
  };

  it("a create whose call times out after it landed is kept and queued (a timeout is not a cancel), then adopted once", async () => {
    const at = "2026-10-16T08:00:00+02:00";
    // The call's own deadline, short: the signal aborts with a TimeoutError, as fetch's does.
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 5);
      return c.signal;
    });
    tracker.afterLanding = {
      create: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true })),
    };
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1500, started: at, comment: "slow" });
      expect(made.remoteId).toMatch(/^pending-/);
    } finally {
      tracker.afterLanding = undefined;
      spy.mockRestore();
    }
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    expect(await countsAt(at)).toEqual({ here: 1, there: 1 });
    const [row] = await q<{ id: number }>("SELECT id FROM worklogs WHERE started = ?", Date.parse(at));
    await caller.worklogs.delete({ id: row.id });
  });

  it("a create answered outside the contract after it landed is kept and adopted, never deleted", async () => {
    const at = "2026-10-16T10:00:00+02:00";
    const { ProviderError } = await import("../providers/core/errors");
    tracker.afterLanding = { create: async () => { throw new ProviderError("incompatible", "fake: odd answer"); } };
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1500, started: at, comment: "odd" });
      expect(made.remoteId).toMatch(/^pending-/);
    } finally {
      tracker.afterLanding = undefined;
    }
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    expect(await countsAt(at)).toEqual({ here: 1, there: 1 });
    const [row] = await q<{ id: number }>("SELECT id FROM worklogs WHERE started = ?", Date.parse(at));
    await caller.worklogs.delete({ id: row.id });
  });

  it("a local fault after the tracker accepted a create keeps the worklog; the replay links it, not a second entry", async () => {
    const at = "2026-10-16T12:00:00+02:00";
    // The database refuses to record the tracker's id on this worklog (a fault after the tracker said yes).
    await q(`CREATE FUNCTION refuse_link() RETURNS trigger AS $$ BEGIN
      IF NEW.comment = 'local fault' AND NEW.jira_worklog_id NOT LIKE 'new-%' AND NEW.jira_worklog_id NOT LIKE 'pending-%' THEN RAISE EXCEPTION 'disk full'; END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`);
    await q("CREATE TRIGGER refuse_link BEFORE UPDATE ON worklogs FOR EACH ROW EXECUTE FUNCTION refuse_link()");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1500, started: at, comment: "local fault" });
      expect(made.remoteId).toMatch(/^(new|pending)-/);
    } finally {
      await q("DROP TRIGGER refuse_link ON worklogs");
      await q("DROP FUNCTION refuse_link()");
      errors.mockRestore();
    }
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    expect(await countsAt(at)).toEqual({ here: 1, there: 1 });
    const [row] = await q<{ id: number; remote_id: string }>("SELECT id, jira_worklog_id AS remote_id FROM worklogs WHERE started = ?", Date.parse(at));
    expect(row.remote_id).not.toMatch(/^(new|pending)-/);
    await caller.worklogs.delete({ id: row.id });
  });

  it("a create recorded here whose issue total fails to move keeps the tracker's id: nothing queued, nothing to adopt", async () => {
    const at = "2026-10-16T14:00:00+02:00";
    // Only the issue's running total can't be written (the worklog and its link can).
    await q(`CREATE FUNCTION refuse_total() RETURNS trigger AS $$ BEGIN
      IF NEW.time_spent_seconds IS DISTINCT FROM OLD.time_spent_seconds THEN RAISE EXCEPTION 'disk full'; END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`);
    await q("CREATE TRIGGER refuse_total BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION refuse_total()");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let made;
    try {
      made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: at, comment: "total fault" });
    } finally {
      await q("DROP TRIGGER refuse_total ON issues");
      await q("DROP FUNCTION refuse_total()");
      errors.mockRestore();
    }
    expect(made.remoteId).not.toMatch(/^(new|pending)-/);
    expect(await q("SELECT id FROM outbox WHERE worklog_id = ?", made.id)).toEqual([]);
    await caller.worklogs.delete({ id: made.id });
  });

  it("an edit answered outside the contract is kept and queued, not refused (it may have landed)", async () => {
    const at = "2026-10-16T14:00:00+02:00";
    const { ProviderError } = await import("../providers/core/errors");
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "before" });
    tracker.afterLanding = { update: async () => { throw new ProviderError("incompatible", "fake: odd answer"); } };
    try {
      const changed = await caller.worklogs.update({ id: made.id, seconds: 900, started: at, comment: "after" });
      expect(changed).toMatchObject({ timeSpentSeconds: 900, comment: "after" });
    } finally {
      tracker.afterLanding = undefined;
    }
    expect(await q("SELECT kind FROM outbox WHERE worklog_id = ?", made.id)).toEqual([{ kind: "update" }]);
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    await caller.worklogs.delete({ id: made.id });
  });

  it("a queued edit another process is sending right now is never dropped: a new edit, a delete or a discard waits (CONFLICT)", async () => {
    const at = "2026-10-16T16:00:00+02:00";
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "v1" });
    tracker.offline = true;
    await caller.worklogs.update({ id: made.id, seconds: 900, started: at, comment: "v2" });
    tracker.offline = false;
    const [queued] = await q<{ id: number }>("SELECT id FROM outbox WHERE worklog_id = ? AND kind = 'update'", made.id);
    // Another server process on this database claimed it and is sending it.
    await q("UPDATE outbox SET claimed_at = ? WHERE id = ?", Date.now(), queued.id);
    await expect(caller.worklogs.update({ id: made.id, seconds: 1200, started: at, comment: "v3" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.worklogs.delete({ id: made.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.outbox.discard({ id: queued.id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await q("SELECT id, claimed_at IS NOT NULL AS claimed FROM outbox WHERE worklog_id = ?", made.id)).toEqual([{ id: queued.id, claimed: true }]);
    expect(await q("SELECT time_spent_seconds AS s, comment FROM worklogs WHERE id = ?", made.id)).toEqual([{ s: 900, comment: "v2" }]);
    // Its sender done (or gone past its lease): free again.
    await q("UPDATE outbox SET claimed_at = NULL WHERE id = ?", queued.id);
    const changed = await caller.worklogs.update({ id: made.id, seconds: 1200, started: at, comment: "v3" });
    expect(changed).toMatchObject({ timeSpentSeconds: 1200, comment: "v3" });
    expect(await q("SELECT id FROM outbox WHERE worklog_id = ?", made.id)).toEqual([]);
    await caller.worklogs.delete({ id: made.id });
  });

  it("an edit the tracker refuses keeps the older queued edit (it is the user's last accepted change)", async () => {
    const at = "2026-10-16T17:00:00+02:00";
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "v1" });
    tracker.offline = true;
    await caller.worklogs.update({ id: made.id, seconds: 900, started: at, comment: "v2" });
    tracker.offline = false;
    tracker.refuseOnly = "update";
    try {
      await expect(caller.worklogs.update({ id: made.id, seconds: 1200, started: at, comment: "v3" })).rejects.toThrow(/fake: no/);
    } finally {
      tracker.refuseOnly = undefined;
    }
    expect(await q("SELECT kind, claimed_at FROM outbox WHERE worklog_id = ?", made.id)).toEqual([{ kind: "update", claimed_at: null }]);
    expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
    await caller.worklogs.delete({ id: made.id });
  });

  it("another server process writing this user's time: a create waits for it, then sees what it did (the week it closed)", async () => {
    const at = "2026-10-21T09:00:00+02:00";
    const [{ id: userId }] = await q<{ id: number }>("SELECT id FROM users LIMIT 1");
    // The other process holds the user's write lease while it closes that week.
    await q("INSERT INTO write_leases (user_id, holder, expires_at) VALUES (?, 'other-process', ?)", userId, Date.now() + 60_000);
    let settled = false;
    const creating = caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "racing" }).finally(() => (settled = true));
    creating.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);
    await q("INSERT INTO week_locks (user_id, week_start, note, closed_at) VALUES (?, '2026-10-19', '', ?) ON CONFLICT DO NOTHING", userId, Date.now());
    await q("DELETE FROM write_leases WHERE holder = 'other-process'");
    await expect(creating).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await q("DELETE FROM week_locks WHERE week_start = '2026-10-19'");
    expect(await q("SELECT count(*)::int AS n FROM write_leases")).toEqual([{ n: 0 }]);
  });

  it("a write lease whose holder died runs out: the next write goes on", async () => {
    const at = "2026-10-21T11:00:00+02:00";
    const [{ id: userId }] = await q<{ id: number }>("SELECT id FROM users LIMIT 1");
    await q("INSERT INTO write_leases (user_id, holder, expires_at) VALUES (?, 'dead-process', ?)", userId, Date.now() - 1);
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: at, comment: "after" });
    expect(made.remoteId).not.toMatch(/^(new|pending)-/);
    expect(await q("SELECT count(*)::int AS n FROM write_leases")).toEqual([{ n: 0 }]);
    await caller.worklogs.delete({ id: made.id });
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

  it("where a change logs the entry again, a change queued offline never takes another worklog's entry of the same time", async () => {
    tracker.recreating = true;
    try {
      const at = "2026-10-23T09:00:00+02:00";
      const a = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-23T07:00:00+02:00", comment: "A" });
      const b = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: at, comment: "B" });
      tracker.offline = true;
      try {
        await caller.worklogs.update({ id: a.id, started: at, seconds: 3600, comment: "A" });
      } finally {
        tracker.offline = false;
      }
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      const mine = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === a.id || w.id === b.id);
      expect(mine.map((w) => [w.id, w.timeSpentSeconds, w.comment])).toEqual(expect.arrayContaining([[a.id, 3600, "A"], [b.id, 3600, "B"]]));
      const [ea, eb] = [(await sinkOf(a.id))?.remote_id, (await sinkOf(b.id))?.remote_id];
      expect(ea).toBeTruthy();
      expect(ea).not.toBe(eb);
      await caller.worklogs.delete({ id: a.id });
      await caller.worklogs.delete({ id: b.id });
    } finally {
      tracker.recreating = false;
    }
  });

  it("where a change logs the entry again, a queued change never takes an entry logged on the tracker itself at that time", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const { instant } = await import("@contracts/values");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    tracker.recreating = true;
    try {
      const at = "2026-10-24T14:00:00+02:00";
      const w = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: "2026-10-24T09:00:00+02:00", comment: "W" });
      tracker.offline = true;
      try {
        await caller.worklogs.update({ id: w.id, started: at, seconds: 3600, comment: "W edited" });
      } finally {
        tracker.offline = false;
      }
      const meta = { signal: new AbortController().signal, correlationId: "t" };
      const ref = { remoteId: "r-1", key: "FAKE-1" };
      const b = boundTracker(conn)!;
      const direct = await b.worklogs!.create!(meta, ref, { time: { kind: "session", start: instant(Date.parse(at) + 30_000), seconds: 3600 }, comment: "direct" }, { idempotencyKey: "direct-1" });
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      const all = await b.worklogs!.list(meta, ref);
      const near = all.filter((e) => e.span.kind === "session" && Math.abs(e.span.start - Date.parse(at)) < 60_000);
      expect(near.map((e) => e.comment).sort()).toEqual(["W edited", "direct"]);
      expect((await sinkOf(w.id))?.remote_id).not.toBe(direct.remoteId);
      await caller.worklogs.delete({ id: w.id });
      await b.worklogs!.delete!(meta, ref, direct.remoteId, {});
    } finally {
      tracker.recreating = false;
    }
  });

  it("a queued change never takes an entry whose delete is queued too: the worklog keeps its time", async () => {
    tracker.recreating = true;
    try {
      const at = "2026-10-25T14:00:00+02:00";
      // A change onto the time and words of a worklog deleted after it, both while offline.
      const c = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: at, comment: "W" });
      const a = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-25T09:00:00+02:00", comment: "A" });
      tracker.offline = true;
      try {
        await caller.worklogs.update({ id: a.id, started: at, seconds: 3600, comment: "W" });
        await caller.worklogs.delete({ id: c.id });
      } finally {
        tracker.offline = false;
      }
      expect(await replay()).toMatchObject({ failed: 0 });
      const [kept] = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === a.id);
      expect(kept).toMatchObject({ timeSpentSeconds: 3600, comment: "W" });
      expect(kept.sink.state).toBe("synced");
      await caller.worklogs.delete({ id: a.id });

      // The same for a create queued at that time.
      const d = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: at, comment: "W" });
      tracker.offline = true;
      let made: { id: number };
      try {
        made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: at, comment: "W" });
        await caller.worklogs.delete({ id: d.id });
      } finally {
        tracker.offline = false;
      }
      expect(await replay()).toMatchObject({ failed: 0 });
      const [still] = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => w.id === made.id);
      expect(still?.sink.state).toBe("synced");
      await caller.worklogs.delete({ id: made.id });
    } finally {
      tracker.recreating = false;
    }
  });

  it("a lost create whose time is changed while queued: the replay takes the entry that landed and changes it, the time once", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const meta = { signal: new AbortController().signal, correlationId: "t" };
    const there = async (day: string) =>
      (await boundTracker(conn)!.worklogs!.list(meta, { remoteId: "r-1", key: "FAKE-1" }))
        .filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day))
        .map((w) => ({ id: w.remoteId, seconds: w.span.kind === "session" ? w.span.seconds : 0 }));
    // Keyed (the key returns the first entry), keyless (a retry is a new entry), and read back by a sync before the replay.
    for (const [day, recreating, readBack] of [["2026-10-27", false, false], ["2026-10-28", true, false], ["2026-10-29", false, true]] as const) {
      tracker.recreating = recreating;
      try {
        tracker.loseAnswer = true;
        const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: `${day}T09:00:00+01:00`, comment: "lost" });
        tracker.loseAnswer = false;
        expect(made.remoteId).toMatch(/^pending-/);
        await caller.worklogs.update({ id: made.id, seconds: 1500, started: `${day}T09:00:00+01:00`, comment: "lost" });
        // The queue shows what it will send.
        expect((await caller.outbox.list()).map((o) => [o.kind, o.timeSpentSeconds, o.started?.getTime()])).toEqual([["create", 1500, Date.parse(`${day}T09:00:00+01:00`)]]);
        if (readBack) await caller.issues.syncConnection({ id: connId });
        await replay();
        const now = await there(day);
        expect(now).toEqual([{ id: (await sinkOf(made.id))?.remote_id, seconds: 1500 }]);
        const here = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
        expect(here.map((w) => [w.id, w.timeSpentSeconds])).toEqual([[made.id, 1500]]);
        expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
        await caller.worklogs.delete({ id: made.id });
      } finally {
        tracker.loseAnswer = false;
        tracker.recreating = false;
      }
    }
  });

  it("a create whose replay loses its answer too, after an edit while queued: the next replay takes it, the time once", async () => {
    const day = "2026-10-30";
    tracker.recreating = true;
    try {
      tracker.offline = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: `${day}T09:00:00+01:00`, comment: "twice lost" });
      tracker.offline = false;
      await caller.worklogs.update({ id: made.id, seconds: 900, started: `${day}T09:00:00+01:00`, comment: "twice lost" });
      tracker.loseAnswer = true;
      expect(await replay()).toMatchObject({ synced: 0, failed: 1 });
      tracker.loseAnswer = false;
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      const here = (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
      expect(here.map((w) => [w.id, w.timeSpentSeconds])).toEqual([[made.id, 900]]);
      const { boundTracker } = await import("./engine");
      const { getDb } = await import("../queries/connection");
      const { connections } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
      const there = (await boundTracker(conn)!.worklogs!.list({ signal: new AbortController().signal, correlationId: "t" }, { remoteId: "r-1", key: "FAKE-1" })).filter(
        (w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day),
      );
      expect(there.map((w) => [w.remoteId, w.span.seconds])).toEqual([[(await sinkOf(made.id))?.remote_id, 900]]);
      await caller.worklogs.delete({ id: made.id });
    } finally {
      tracker.loseAnswer = false;
      tracker.offline = false;
      tracker.recreating = false;
    }
  });

  it("a lost create deleted while queued: the entry that landed goes at the replay (as sent, not as edited), never read back", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const there = async (day: string) =>
      (await boundTracker(conn)!.worklogs!.list({ signal: new AbortController().signal, correlationId: "t" }, { remoteId: "r-1", key: "FAKE-1" }))
        .filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day))
        .map((w) => w.remoteId);
    const day = "2026-10-31";
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: `${day}T09:00:00+01:00`, comment: "wrong issue" });
      tracker.loseAnswer = false;
      expect(made.remoteId).toMatch(/^pending-/);
      expect(await there(day)).toHaveLength(1);
      await caller.worklogs.update({ id: made.id, seconds: 1500, started: `${day}T09:00:00+01:00`, comment: "wrong issue" });
      await caller.worklogs.delete({ id: made.id });
      // The user's Sync (its queue first) and a replay: deleted there, nothing read back.
      await caller.issues.syncConnection({ id: connId });
      expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
      expect(await there(day)).toEqual([]);
      await caller.issues.syncConnection({ id: connId });
      expect((await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day))).toEqual([]);
    } finally {
      tracker.loseAnswer = false;
    }
  });

  it("a lost create deleted while queued, its delete there failing for now: the sync after it leaves the entry out, the next replay deletes it", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const there = async (day: string) =>
      (await boundTracker(conn)!.worklogs!.list({ signal: new AbortController().signal, correlationId: "t" }, { remoteId: "r-1", key: "FAKE-1" }))
        .filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day))
        .map((w) => w.remoteId);
    const here = async (day: string) => (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
    const day = "2026-11-02";
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: `${day}T09:00:00+01:00`, comment: "later" });
      tracker.loseAnswer = false;
      await caller.worklogs.delete({ id: made.id });
      tracker.downOnly = "delete";
      await caller.issues.syncConnection({ id: connId });
      expect(await here(day)).toEqual([]);
      tracker.downOnly = undefined;
      expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
      expect(await there(day)).toEqual([]);
      await caller.issues.syncConnection({ id: connId });
      expect(await here(day)).toEqual([]);
    } finally {
      tracker.loseAnswer = false;
      tracker.downOnly = undefined;
    }
  });

  it("a lost create's delete discarded, or out of attempts, after a sync left its entry out: the entry is read back, once", async () => {
    const { MAX_OUTBOX_ATTEMPTS } = await import("@contracts/types");
    const here = async (day: string) => (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
    const tomb = async () => (await q<{ id: number }>("SELECT id FROM outbox WHERE kind = 'delete' AND jira_worklog_id = ''"))[0];
    for (const [day, end] of [["2026-11-03", "discard"], ["2026-11-04", "attempts"]] as const) {
      try {
        tracker.loseAnswer = true;
        const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: `${day}T09:00:00+01:00`, comment: "kept out" });
        tracker.loseAnswer = false;
        await caller.worklogs.delete({ id: made.id });
        tracker.downOnly = "delete";
        await caller.issues.syncConnection({ id: connId });
        expect(await here(day)).toEqual([]);
        tracker.downOnly = undefined;
        if (end === "discard") await caller.outbox.discard({ id: (await tomb()).id });
        else {
          // Its last try, refused.
          await q("UPDATE outbox SET attempts = ? WHERE id = ?", MAX_OUTBOX_ATTEMPTS - 1, (await tomb()).id);
          tracker.refuseOnly = "delete";
          expect(await replay()).toMatchObject({ failed: 1 });
          tracker.refuseOnly = undefined;
        }
        await caller.issues.syncConnection({ id: connId });
        const back = await here(day);
        expect(back.map((w) => [w.timeSpentSeconds, w.comment])).toEqual([[1200, "kept out"]]);
        await caller.worklogs.delete({ id: back[0].id });
        await q("DELETE FROM outbox");
      } finally {
        tracker.loseAnswer = false;
        tracker.downOnly = undefined;
        tracker.refuseOnly = undefined;
      }
    }
  });

  it("a lost create deleted, then restored from the trash: the replay deletes only the lost entry, the restored one stays", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const there = async (day: string) =>
      (await boundTracker(conn)!.worklogs!.list({ signal: new AbortController().signal, correlationId: "t" }, { remoteId: "r-1", key: "FAKE-1" }))
        .filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day))
        .map((w) => w.remoteId);
    const day = "2026-11-01";
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: `${day}T09:00:00+01:00`, comment: "back" });
      tracker.loseAnswer = false;
      await caller.worklogs.delete({ id: made.id });
      const trashed = (await caller.worklogs.trash()).find((t) => t.started.getTime() === Date.parse(`${day}T09:00:00+01:00`));
      const back = await caller.worklogs.restore({ id: trashed!.id });
      expect(await there(day)).toHaveLength(2);
      expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
      expect(await there(day)).toEqual([(await sinkOf(back.id))?.remote_id]);
      await caller.worklogs.delete({ id: back.id });
    } finally {
      tracker.loseAnswer = false;
    }
  });

  it("a create that never reached the tracker (its name not resolving from here), deleted while queued: no delete looks for it; the same time logged on the tracker by hand stays and is read back", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const { instant } = await import("@contracts/values");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const meta = { signal: new AbortController().signal, correlationId: "t" };
    const ref = { remoteId: "r-1", key: "FAKE-1" };
    const day = "2026-11-05";
    const at = `${day}T08:00:00+01:00`;
    const there = async () => (await boundTracker(conn)!.worklogs!.list(meta, ref)).filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day)).map((w) => w.remoteId);
    const here = async () => (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
    try {
      tracker.unresolved = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: at, comment: "Daily" });
      expect(made.remoteId).toMatch(/^pending-/);
      // Background passes still can't reach it.
      expect(await replay()).toMatchObject({ synced: 0 });
      // The user logs the same time on the tracker itself, then deletes the pending one.
      tracker.unresolved = false;
      const hand = await boundTracker(conn)!.worklogs!.create!(meta, ref, { time: { kind: "session", start: instant(Date.parse(at)), seconds: 3600 }, comment: "Daily" }, { idempotencyKey: "by-hand-1" });
      tracker.unresolved = true;
      await caller.worklogs.delete({ id: made.id });
      expect(await q("SELECT kind FROM outbox")).toEqual([]);
      tracker.unresolved = false;
      expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
      expect(await there()).toEqual([hand.remoteId]);
      await caller.issues.syncConnection({ id: connId });
      expect((await here()).map((w) => [w.remoteId, w.timeSpentSeconds, w.comment])).toEqual([[hand.remoteId, 3600, "Daily"]]);
      await caller.worklogs.delete({ id: (await here())[0].id });
    } finally {
      tracker.unresolved = false;
    }
  });

  it("a lost create deleted long after its last send: the same time logged on the tracker by hand since then stays (only entries made while a send could land are its)", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const { instant } = await import("@contracts/values");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const meta = { signal: new AbortController().signal, correlationId: "t" };
    const ref = { remoteId: "r-1", key: "FAKE-1" };
    const day = "2026-11-06";
    const at = `${day}T08:00:00+01:00`;
    const there = async () => (await boundTracker(conn)!.worklogs!.list(meta, ref)).filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day)).map((w) => w.remoteId);
    const here = async () => (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
    try {
      // Sent an hour ago with no answer (it may have landed, it didn't).
      tracker.offline = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: at, comment: "Daily" });
      tracker.offline = false;
      await q("UPDATE outbox SET created_at = created_at - 3600000, landed_after = landed_after - 3600000, landed_before = landed_before - 3600000");
      // A try that never left (the name not resolving as it sends) is no send.
      tracker.unresolvedOnly = "create";
      expect(await replay()).toMatchObject({ synced: 0 });
      tracker.unresolvedOnly = undefined;
      const hand = await boundTracker(conn)!.worklogs!.create!(meta, ref, { time: { kind: "session", start: instant(Date.parse(at)), seconds: 3600 }, comment: "Daily" }, { idempotencyKey: "by-hand-2" });
      tracker.unresolved = true;
      await caller.worklogs.delete({ id: made.id });
      tracker.unresolved = false;
      expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
      expect(await there()).toEqual([hand.remoteId]);
      await caller.issues.syncConnection({ id: connId });
      expect((await here()).map((w) => w.remoteId)).toEqual([hand.remoteId]);
      await caller.worklogs.delete({ id: (await here())[0].id });
    } finally {
      tracker.offline = false;
      tracker.unresolved = false;
      tracker.unresolvedOnly = undefined;
      await q("DELETE FROM outbox");
    }
  });

  it("a lost create deleted while queued, on a tracker whose entries carry no creation time: nothing there is deleted for it, the entry is read back", async () => {
    const { boundTracker } = await import("./engine");
    const { getDb } = await import("../queries/connection");
    const { connections } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
    const meta = { signal: new AbortController().signal, correlationId: "t" };
    const day = "2026-11-07";
    const there = async () => (await boundTracker(conn)!.worklogs!.list(meta, { remoteId: "r-1", key: "FAKE-1" })).filter((w) => w.span.kind === "session" && new Date(w.span.start).toISOString().startsWith(day)).map((w) => w.remoteId);
    const here = async () => (await caller.worklogs.list({ issueKey: "FAKE-1" })).filter((w) => new Date(w.started).toISOString().startsWith(day));
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: `${day}T09:00:00+01:00`, comment: "undated" });
      tracker.loseAnswer = false;
      const landed = await there();
      expect(landed).toHaveLength(1);
      // As GitLab's timelogs: no creation time.
      tracker.made.delete(landed[0]);
      await caller.worklogs.delete({ id: made.id });
      expect(await replay()).toMatchObject({ failed: 0, remaining: 0 });
      expect(await there()).toEqual(landed);
      await caller.issues.syncConnection({ id: connId });
      expect((await here()).map((w) => w.remoteId)).toEqual(landed);
      await caller.worklogs.delete({ id: (await here())[0].id });
    } finally {
      tracker.loseAnswer = false;
    }
  });

  it("on a tracker keeping a session's day and no words (GitLab's notes), a create whose answer was lost is adopted at the replay, not logged twice", async () => {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { ProviderError } = await import("../providers/core/errors");
    const { instant } = await import("@contracts/values");
    type Remote = import("../providers/types").RemoteWorklog;
    const base = fakeTracker([{ key: "FAKE-1", title: "First" }]);
    const time = base.capabilities.time;
    if (time.mode !== "entries" || time.entries.model !== "entries") throw new Error("fake keeps entries");
    const capabilities = { ...base.capabilities, time: { ...time, entries: { ...time.entries, idempotency: "local" as const } } };
    const kept = new Map<string, Remote>();
    let seq = 0;
    const worklogs = {
      list: async () => [...kept.values()],
      create: async (x: { conn: { remoteAccountId: string } }, ref: { remoteId: string; key: string }, w: { time: Remote["span"]; comment: string }) => {
        if (w.time.kind !== "session") throw new Error("sessions");
        // As GitLab's notes leave it: the day at 9:00, no words.
        const day = new Date(w.time.start).toISOString().slice(0, 10);
        const made: Remote = { remoteId: `n-${++seq}`, issue: { remoteId: ref.remoteId, key: ref.key }, span: { kind: "session", start: instant(Date.parse(`${day}T09:00:00+01:00`)), seconds: w.time.seconds }, comment: "", authorRemoteId: x.conn.remoteAccountId, editable: { update: false, delete: true }, createdAt: instant(Date.now()), dayOnly: true, noWords: true };
        kept.set(made.remoteId, made);
        if (tracker.loseAnswer) throw new ProviderError("unavailable", "fake: timed out");
        return made;
      },
      delete: async (_x: unknown, _ref: unknown, id: string) => {
        kept.delete(id);
      },
    };
    const real = tracker.adapter;
    tracker.adapter = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, { capabilities, worklogs });
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-11-10T14:00:00+01:00", comment: "no notes there" });
      tracker.loseAnswer = false;
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      expect([...kept.keys()]).toEqual(["n-1"]);
      expect((await sinkOf(made.id))?.remote_id).toBe("n-1");
      await caller.worklogs.delete({ id: made.id });
      expect(kept.size).toBe(0);
    } finally {
      tracker.loseAnswer = false;
      tracker.adapter = real;
    }
  });

  it("on a tracker keeping only days, a create whose answer was lost is adopted at the replay, not logged twice", async () => {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { ProviderError } = await import("../providers/core/errors");
    const { instant } = await import("@contracts/values");
    type Remote = import("../providers/types").RemoteWorklog;
    const base = fakeTracker([{ key: "FAKE-1", title: "First" }]);
    const time = base.capabilities.time;
    if (time.mode !== "entries" || time.entries.model !== "entries") throw new Error("fake keeps entries");
    // Days only, no key kept (Redmine, Wrike, YouTrack, OpenProject, Plane).
    const capabilities = { ...base.capabilities, time: { ...time, entries: { ...time.entries, shape: "date" as const, idempotency: "local" as const } } };
    const kept = new Map<string, Remote>();
    let seq = 0;
    let newestFirst = false;
    const worklogs = {
      list: async () => (newestFirst ? [...kept.values()].reverse() : [...kept.values()]),
      create: async (x: { conn: { remoteAccountId: string } }, ref: { remoteId: string; key: string }, w: { time: Remote["span"]; comment: string }) => {
        tracker.calls.push("create");
        const made: Remote = { remoteId: `d-${++seq}`, issue: { remoteId: ref.remoteId, key: ref.key }, span: w.time, comment: w.comment, authorRemoteId: x.conn.remoteAccountId, editable: { update: true, delete: true }, createdAt: instant(Date.now()) };
        kept.set(made.remoteId, made);
        if (tracker.loseAnswer) throw new ProviderError("unavailable", "fake: timed out");
        return made;
      },
      delete: async (_x: unknown, _ref: unknown, id: string) => {
        kept.delete(id);
      },
    };
    const real = tracker.adapter;
    tracker.adapter = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, { capabilities, worklogs });
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started: "2026-10-26T10:00:00+01:00", comment: "days" });
      tracker.loseAnswer = false;
      expect(made.remoteId).toMatch(/^pending-/);
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      expect([...kept.keys()]).toEqual(["d-1"]);
      expect((await sinkOf(made.id))?.remote_id).toBe("d-1");
      await caller.worklogs.delete({ id: made.id });
      expect(kept.size).toBe(0);

      const { getDb } = await import("../queries/connection");
      const { connections, worklogs: rows, worklogSinks } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const { connOf } = await import("../providers/connections");
      const { instantAtLocal, localDate } = await import("@contracts/values");
      const [conn] = await getDb().select().from(connections).where(eq(connections.id, connId));
      // A worklog of that entry, as a sync or the user would have it here.
      const linkedRow = async (remoteId: string, started: Date) => {
        const [row] = await getDb().insert(rows).values({ userId: made.userId, connectionId: connId, issueKey: "FAKE-1", remoteId, timeSpentSeconds: 3600, started, comment: "days", authorAccountId: "me", syncedAt: new Date() }).returning();
        await getDb()
          .insert(worklogSinks)
          .values({ worklogId: row.id, sinkConnectionId: connId, remoteId, state: "synced" })
          .onConflictDoUpdate({ target: [worklogSinks.worklogId, worklogSinks.sinkConnectionId], set: { remoteId, state: "synced" } });
        return row;
      };
      const lostCreate = async (started: string) => {
        tracker.loseAnswer = true;
        const w = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 3600, started, comment: "days" });
        tracker.loseAnswer = false;
        return { w, entry: [...kept.keys()].at(-1)! };
      };

      // Read back by a sync meanwhile (a day's entry comes in at 09:00): the copy goes, the time once.
      const second = await lostCreate("2026-11-03T12:00:00Z");
      const copy = await linkedRow(second.entry, new Date(instantAtLocal(localDate("2026-11-03"), 9, connOf(conn).timeZone)));
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      expect([...kept.keys()]).toEqual([second.entry]);
      expect((await sinkOf(second.w.id))?.remote_id).toBe(second.entry);
      expect(await q("SELECT count(*)::int AS n FROM worklogs WHERE id = ?", copy.id)).toEqual([{ n: 0 }]);
      await caller.worklogs.delete({ id: second.w.id });

      // Another worklog logged after it, the same day, length and words, with its own entry: never taken.
      newestFirst = true;
      const third = await lostCreate("2026-11-04T12:00:00Z");
      kept.set("d-twin", { ...kept.get(third.entry)!, remoteId: "d-twin" });
      const twin = await linkedRow("d-twin", new Date("2026-11-04T15:00:00Z"));
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      expect((await sinkOf(third.w.id))?.remote_id).toBe(third.entry);
      expect((await sinkOf(twin.id))?.remote_id).toBe("d-twin");
      await caller.worklogs.delete({ id: third.w.id });
      await caller.worklogs.delete({ id: twin.id });
      expect(kept.size).toBe(0);
    } finally {
      tracker.loseAnswer = false;
      tracker.adapter = real;
    }
  });

  it("on a tracker that rounds lengths (Redmine: hours to two places), a 600 s create whose answer was lost is adopted at the replay, not logged twice", async () => {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { ProviderError } = await import("../providers/core/errors");
    const { instant } = await import("@contracts/values");
    type Remote = import("../providers/types").RemoteWorklog;
    const base = fakeTracker([{ key: "FAKE-1", title: "First" }]);
    const time = base.capabilities.time;
    if (time.mode !== "entries" || time.entries.model !== "entries") throw new Error("fake keeps entries");
    const limits = { increment: { seconds: 36, rounding: "nearest" as const } };
    const capabilities = { ...base.capabilities, time: { ...time, entries: { ...time.entries, shape: "date" as const, idempotency: "local" as const, limits } } };
    const kept = new Map<string, Remote>();
    let seq = 0;
    const worklogs = {
      list: async () => [...kept.values()],
      create: async (x: { conn: { remoteAccountId: string } }, ref: { remoteId: string; key: string }, w: { time: Remote["span"]; comment: string }) => {
        // As Redmine keeps it: 600 s is 0.17 h, read back as 612 s.
        const seconds = Math.round((Math.round(w.time.seconds / 36) / 100) * 3600);
        const made: Remote = { remoteId: `r-${++seq}`, issue: { remoteId: ref.remoteId, key: ref.key }, span: { ...w.time, seconds }, comment: w.comment, authorRemoteId: x.conn.remoteAccountId, editable: { update: true, delete: true }, createdAt: instant(Date.now()) };
        kept.set(made.remoteId, made);
        if (tracker.loseAnswer) throw new ProviderError("unavailable", "fake: timed out");
        return made;
      },
      delete: async (_x: unknown, _ref: unknown, id: string) => {
        kept.delete(id);
      },
    };
    const real = tracker.adapter;
    tracker.adapter = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, { capabilities, worklogs });
    try {
      tracker.loseAnswer = true;
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: "2026-11-05T10:00:00+01:00", comment: "rounded" });
      tracker.loseAnswer = false;
      expect([...kept.values()].map((w) => w.span.seconds)).toEqual([612]);
      expect(await replay()).toMatchObject({ synced: 1, failed: 0 });
      expect([...kept.keys()]).toEqual(["r-1"]);
      expect((await sinkOf(made.id))?.remote_id).toBe("r-1");
      await caller.worklogs.delete({ id: made.id });
      expect(kept.size).toBe(0);
    } finally {
      tracker.loseAnswer = false;
      tracker.adapter = real;
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

describe("rounding services", () => {
  it("the trackers that round a length declare their step: what they store of 600 s is within the lost-answer slack", async () => {
    const { trackerAdapter } = await import("../providers/registry");
    const { roundingSlack } = await import("./worklogs");
    // Redmine and Wrike keep hours to two places (612 s), YouTrack, Plane, Asana and Basecamp whole minutes (600 s; 630 s is 660 s).
    for (const [type, sent, stored] of [["redmine", 600, 612], ["wrike", 600, 612], ["youtrack", 630, 660], ["plane", 630, 660], ["asana", 630, 660], ["basecamp", 630, 660]] as const) {
      const time = trackerAdapter(type)?.capabilities.time;
      const limits = time?.mode === "entries" && time.entries.model === "entries" ? time.entries.limits : undefined;
      expect(Math.abs(stored - sent), type).toBeLessThanOrEqual(roundingSlack(limits, sent));
    }
    // One that keeps seconds: none.
    const jira = trackerAdapter("jira")?.capabilities.time;
    expect(roundingSlack(jira?.mode === "entries" && jira.entries.model === "entries" ? jira.entries.limits : undefined, 600)).toBe(0);
  });
});

describe("holds", () => {
  it("a session kept only by its day (a Harvest duration account: read at the day's start) holds a time that day, of that length", async () => {
    const { holds } = await import("./timeWrites");
    const { instant } = await import("@contracts/values");
    const zone = "Europe/Rome" as import("@contracts/values").TimeZone;
    const midnight = { kind: "session" as const, start: instant(Date.UTC(2026, 9, 13, 22, 0)), seconds: 3600 };
    const sent = { started: new Date(Date.UTC(2026, 9, 14, 11, 45)), seconds: 3600 };
    expect(holds(midnight, sent, zone)).toBe(false);
    expect(holds(midnight, sent, zone, true)).toBe(true);
    expect(holds(midnight, { ...sent, seconds: 3000 }, zone, true)).toBe(false);
    expect(holds(midnight, { ...sent, started: new Date(Date.UTC(2026, 9, 14, 23, 0)) }, zone, true)).toBe(false);
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
