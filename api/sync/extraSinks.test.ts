import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** The contract's fake tracker as "gitlab" and fake time sink as "harvest"; the sink's build status set by the test. */
type Fakes = { tracker: unknown; sink: unknown; sinkStatus: string };
const fakes: Fakes = vi.hoisted((): Fakes => ({ tracker: null, sink: null, sinkStatus: "built" }));
vi.mock("../providers/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("../providers/registry")>();
  return {
    ...real,
    trackerAdapter: (type: Parameters<typeof real.trackerAdapter>[0]) => (type === "gitlab" ? fakes.tracker : real.trackerAdapter(type)),
    sinkAdapter: (type: string) => (type === "harvest" ? fakes.sink : null),
    sinkStatus: (type: string) => (type === "harvest" ? fakes.sinkStatus : "planned"),
  };
});

describe("time sinks beside the trackers: every worklog filed there too, in the background", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;
  let sinkId = 0;
  let userId = 0;
  type SinkEntries = { list(x: unknown, r: { from: string; to: string }): Promise<{ remoteId: string; span: { seconds: number; date: string }; comment: string; activity: { id: string } | null }[]> };
  const sinkEntries = () => (fakes.sink as { entries: SinkEntries }).entries.list({ conn: { remoteAccountId: "me" } }, { from: "2026-01-01", to: "2026-12-31" });
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  const push = async () => (await import("./extraSinks")).pushSinks(userId);

  beforeAll(async () => {
    const { fakeTracker, fakeSink } = await import("../providers/fake/adapter");
    fakes.tracker = fakeTracker([{ key: "FAKE-1", title: "First" }]);
    fakes.sink = fakeSink();
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('s', 'S', 1) RETURNING id");
    userId = u.id;
    const [t] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', '{\"region\":\"eu\"}', 'x', 1) RETURNING id", u.id);
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", t.id), t.id);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'r-1', 'FAKE-1', 'First', 'To Do', 'FAKE', 'Fake', 'https://fake.example/FAKE-1', 1)", u.id, t.id);
    const [s] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'harvest', 'https://sink.example', 'me', '{}', 'x', 1) RETURNING id", u.id);
    sinkId = s.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("k", s.id), s.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const sinkRow = async (worklogId: number) => (await q<{ state: string; remote_id: string | null; last_error: string | null }>("SELECT state, remote_id, last_error FROM worklog_sinks WHERE worklog_id = ? AND sink_connection_id = ?", worklogId, sinkId))[0];

  it("no target mapped where the sink needs one: said on the worklog, nothing sent", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-14T09:00:00+02:00", comment: "a" });
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "failed", last_error: "noTarget" });
    await caller.worklogs.delete({ id: made.id });
  });

  it("mapped: logged, changed and deleted there too, filed under the target with its activity", async () => {
    await q("INSERT INTO sink_mappings (sink_connection_id, container_id, target_remote_id, target_name, target_path, activity_id) VALUES (?, NULL, 't-1', 'Build', '[]', 'dev')", sinkId);
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-15T09:00:00+02:00", comment: "work" });
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "synced" });
    expect((await sinkEntries()).map((e) => [e.span.date, e.span.seconds, e.comment, e.activity?.id])).toEqual([["2026-10-15", 1800, "work", "dev"]]);
    await caller.worklogs.update({ id: made.id, seconds: 2400, started: "2026-10-15T09:00:00+02:00", comment: "more" });
    await push();
    expect((await sinkEntries()).map((e) => [e.span.seconds, e.comment])).toEqual([[2400, "more"]]);
    await caller.worklogs.delete({ id: made.id });
    await push();
    expect(await sinkEntries()).toEqual([]);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("\"Send now\" sends a delete that background passes no longer try (past the attempts cap)", async () => {
    const { MAX_OUTBOX_ATTEMPTS } = await import("@contracts/types");
    await q("INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, attempts, created_at) VALUES (?, ?, 'delete', 'FAKE-1', 'gone-1', ?, 1)", userId, sinkId, MAX_OUTBOX_ATTEMPTS);
    await push();
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE jira_worklog_id = 'gone-1'")).toEqual([{ n: 1 }]);
    await caller.sinks.push({ id: sinkId });
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE jira_worklog_id = 'gone-1'")).toEqual([{ n: 0 }]);
  });

  it("an integration not verified yet keeps its work pending until writes are allowed", async () => {
    fakes.sinkStatus = "experimental";
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: "2026-10-16T09:00:00+02:00", comment: "" });
      await push();
      expect(await sinkRow(made.id)).toMatchObject({ state: "pending" });
      await caller.connections.allowWrites({ id: sinkId, on: true });
      await push();
      expect(await sinkRow(made.id)).toMatchObject({ state: "synced" });
    } finally {
      fakes.sinkStatus = "built";
    }
  });
});
