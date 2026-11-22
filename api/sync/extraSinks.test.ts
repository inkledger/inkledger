import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "52.200.10.20", family: 4 }]),
}));

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

  // Mapped, as every test but the first expects (each runs on its own too).
  beforeEach(async () => {
    await q("INSERT INTO sink_mappings (sink_connection_id, container_id, target_remote_id, target_name, target_path, activity_id) VALUES (?, NULL, 't-1', 'Build', '[]', 'dev') ON CONFLICT DO NOTHING", sinkId);
  });

  const sinkRow = async (worklogId: number) => (await q<{ state: string; remote_id: string | null; last_error: string | null }>("SELECT state, remote_id, last_error FROM worklog_sinks WHERE worklog_id = ? AND sink_connection_id = ?", worklogId, sinkId))[0];

  it("no target mapped where the sink needs one: said on the worklog, nothing sent", async () => {
    await q("DELETE FROM sink_mappings WHERE sink_connection_id = ?", sinkId);
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-14T09:00:00+02:00", comment: "a" });
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "failed", last_error: "noTarget" });
    await caller.worklogs.delete({ id: made.id });
  });

  it("mapped: logged, changed and deleted there too, filed under the target with its activity", async () => {
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

  it("a sink keeping only days, honouring no key: a create it took with its answer lost is found the next pass, not filed twice", async () => {
    const { ProviderError } = await import("../providers/core/errors");
    const { instant } = await import("@contracts/values");
    const entries = (fakes.sink as { entries: { create: (...a: unknown[]) => Promise<{ createdAt?: unknown }> } }).entries;
    const real = entries.create;
    let lose = true;
    entries.create = async (...args: unknown[]) => {
      const made = await real(...args);
      made.createdAt = instant(Date.now());
      if (lose) {
        lose = false;
        throw new ProviderError("unavailable", "fake: timed out");
      }
      return made;
    };
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-16T09:00:00+02:00", comment: "once" });
      await push();
      expect(await sinkRow(made.id)).toMatchObject({ state: "pending", remote_id: null });
      await push();
      const there = (await sinkEntries()).filter((e) => e.span.date === "2026-10-16");
      expect(there.map((e) => [e.span.seconds, e.comment])).toEqual([[1800, "once"]]);
      expect(await sinkRow(made.id)).toMatchObject({ state: "synced", remote_id: there[0].remoteId });
      await caller.worklogs.delete({ id: made.id });
      await push();
    } finally {
      entries.create = real;
    }
  });

  it("a create the sink took with its answer lost, then its worklog deleted: the entry there goes at the next pass", async () => {
    const { ProviderError } = await import("../providers/core/errors");
    const { instant } = await import("@contracts/values");
    const entries = (fakes.sink as { entries: { create: (...a: unknown[]) => Promise<{ createdAt?: unknown }> } }).entries;
    const real = entries.create;
    let lose = true;
    entries.create = async (...args: unknown[]) => {
      const made = await real(...args);
      made.createdAt = instant(Date.now());
      if (lose) {
        lose = false;
        throw new ProviderError("unavailable", "fake: timed out");
      }
      return made;
    };
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-17T09:00:00+02:00", comment: "lost, then gone" });
      await push();
      expect(await sinkRow(made.id)).toMatchObject({ state: "pending", remote_id: null });
      await caller.worklogs.delete({ id: made.id });
      await push();
      expect((await sinkEntries()).filter((e) => e.span.date === "2026-10-17")).toEqual([]);
      expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    } finally {
      entries.create = real;
    }
  });

  it("a worklog never sent to the sink, deleted: nothing is queued for it there", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-21T09:00:00+02:00", comment: "never sent" });
    await caller.worklogs.delete({ id: made.id });
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("a queued create discarded after the sink filed its worklog: the entry there goes too", async () => {
    const tracker = fakes.tracker as { worklogs: Record<string, (...a: unknown[]) => Promise<unknown>> };
    const { ProviderError } = await import("../providers/core/errors");
    const real = tracker.worklogs.create;
    tracker.worklogs.create = async () => {
      throw new ProviderError("unavailable", "fake: down");
    };
    try {
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-22T09:00:00+02:00", comment: "discarded" });
      expect(made.remoteId).toMatch(/^pending-/);
      await push();
      expect((await sinkEntries()).filter((e) => e.span.date === "2026-10-22")).toHaveLength(1);
      const [queued] = await q<{ id: number }>("SELECT id FROM outbox WHERE kind = 'create'");
      await caller.outbox.discard({ id: queued.id });
      await push();
      expect((await sinkEntries()).filter((e) => e.span.date === "2026-10-22")).toEqual([]);
    } finally {
      tracker.worklogs.create = real;
      await q("DELETE FROM outbox");
    }
  });

  it("a worklog deleted while its create to the sink is under way: the entry that lands goes at once", async () => {
    const { pushOne, boundSink } = await import("./extraSinks");
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-18T09:00:00+02:00", comment: "under way" });
    const { getDb } = await import("../queries/connection");
    const { connections, worklogs } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    // The push read the worklog, then it was deleted before its create went out.
    const [w] = await getDb().select().from(worklogs).where(eq(worklogs.id, made.id));
    await caller.worklogs.delete({ id: made.id });
    const [sink] = await getDb().select().from(connections).where(eq(connections.id, sinkId));
    await pushOne(boundSink(sink)!, sink, w, null);
    expect((await sinkEntries()).filter((e) => e.span.date === "2026-10-18")).toEqual([]);
    await push();
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("Harvest on a timestamp account (start and end to the minute): a create it took with its answer lost is found the next pass, not filed twice", async () => {
    const { harvestSimulator } = await import("../providers/harvest/simulator");
    const { harvestSink } = await import("../providers/harvest/adapter");
    const { sealSecret } = await import("../lib/crypto");
    const sim = harvestSimulator(undefined, { timestamps: true });
    const [before] = await q<{ base_url: string; options: string; remote_account_id: string; encrypted_secret: string }>("SELECT base_url, options, remote_account_id, encrypted_secret FROM connections WHERE id = ?", sinkId);
    const fake = fakes.sink;
    let lose = true;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const res = await sim.fetch(input, init);
      // The first entry taken, its answer lost on the way.
      if (lose && init?.method === "POST" && String(input).includes("/time_entries")) {
        lose = false;
        throw new TypeError("fetch failed");
      }
      return res;
    });
    try {
      fakes.sink = harvestSink;
      await q("UPDATE connections SET base_url = ?, options = ?, remote_account_id = ?, encrypted_secret = ? WHERE id = ?", sim.apiBase, JSON.stringify({ accountId: sim.accountId }), String(sim.me.id), sealSecret(sim.token, sinkId), sinkId);
      const { boundSink } = await import("./extraSinks");
      const { getDb } = await import("../queries/connection");
      const { connections } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const [sink] = await getDb().select().from(connections).where(eq(connections.id, sinkId));
      const [target] = (await boundSink(sink)!.targets!({ signal: new AbortController().signal, correlationId: "t" }, "", 10)).items;
      await q("UPDATE sink_mappings SET target_remote_id = ?, activity_id = NULL WHERE sink_connection_id = ?", target.remoteId, sinkId);
      // 630 s from 14:00:30: kept as 14:00 to 14:11, read back as 660 s.
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 630, started: "2026-10-19T14:00:30+02:00", comment: "to the minute" });
      await push();
      expect(await sinkRow(made.id)).toMatchObject({ state: "pending", remote_id: null });
      await push();
      const there = sim.entries.filter((e) => e.date === "2026-10-19");
      expect(there.map((e) => e.hours * 3600)).toEqual([660]);
      expect(await sinkRow(made.id)).toMatchObject({ state: "synced", remote_id: String(there[0].id) });
      await caller.worklogs.delete({ id: made.id });
      await push();
    } finally {
      fakes.sink = fake;
      vi.unstubAllGlobals();
      await q("UPDATE connections SET base_url = ?, options = ?, remote_account_id = ?, encrypted_secret = ? WHERE id = ?", before.base_url, before.options, before.remote_account_id, before.encrypted_secret, sinkId);
      await q("UPDATE sink_mappings SET target_remote_id = 't-1', activity_id = 'dev' WHERE sink_connection_id = ?", sinkId);
    }
  });

  it("Harvest on a duration account (only the day): a create it took with its answer lost, then its worklog deleted, goes from there at the next pass", async () => {
    const { harvestSimulator } = await import("../providers/harvest/simulator");
    const { harvestSink } = await import("../providers/harvest/adapter");
    const { sealSecret } = await import("../lib/crypto");
    const sim = harvestSimulator();
    const [before] = await q<{ base_url: string; options: string; remote_account_id: string; encrypted_secret: string }>("SELECT base_url, options, remote_account_id, encrypted_secret FROM connections WHERE id = ?", sinkId);
    const fake = fakes.sink;
    let lose = true;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const res = await sim.fetch(input, init);
      // The first entry taken, its answer lost on the way.
      if (lose && init?.method === "POST" && String(input).includes("/time_entries")) {
        lose = false;
        throw new TypeError("fetch failed");
      }
      return res;
    });
    try {
      fakes.sink = harvestSink;
      await q("UPDATE connections SET base_url = ?, options = ?, remote_account_id = ?, encrypted_secret = ? WHERE id = ?", sim.apiBase, JSON.stringify({ accountId: sim.accountId }), String(sim.me.id), sealSecret(sim.token, sinkId), sinkId);
      const { boundSink } = await import("./extraSinks");
      const { getDb } = await import("../queries/connection");
      const { connections } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const [sink] = await getDb().select().from(connections).where(eq(connections.id, sinkId));
      const [target] = (await boundSink(sink)!.targets!({ signal: new AbortController().signal, correlationId: "t" }, "", 10)).items;
      await q("UPDATE sink_mappings SET target_remote_id = ?, activity_id = NULL WHERE sink_connection_id = ?", target.remoteId, sinkId);
      const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1800, started: "2026-10-20T14:00:00+02:00", comment: "lost, then gone" });
      await push();
      expect(await sinkRow(made.id)).toMatchObject({ state: "pending", remote_id: null });
      expect(sim.entries.filter((e) => e.date === "2026-10-20")).toHaveLength(1);
      await caller.worklogs.delete({ id: made.id });
      await push();
      expect(sim.entries.filter((e) => e.date === "2026-10-20")).toEqual([]);
      expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    } finally {
      fakes.sink = fake;
      vi.unstubAllGlobals();
      await q("UPDATE connections SET base_url = ?, options = ?, remote_account_id = ?, encrypted_secret = ? WHERE id = ?", before.base_url, before.options, before.remote_account_id, before.encrypted_secret, sinkId);
      await q("UPDATE sink_mappings SET target_remote_id = 't-1', activity_id = 'dev' WHERE sink_connection_id = ?", sinkId);
    }
  });

  it("\"Send now\" sends a delete that background passes no longer try (past the attempts cap)", async () => {
    const { MAX_OUTBOX_ATTEMPTS } = await import("@contracts/types");
    await q("INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, attempts, created_at) VALUES (?, ?, 'delete', 'FAKE-1', 'gone-1', ?, 1)", userId, sinkId, MAX_OUTBOX_ATTEMPTS);
    await push();
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE jira_worklog_id = 'gone-1'")).toEqual([{ n: 1 }]);
    await caller.sinks.push({ id: sinkId });
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE jira_worklog_id = 'gone-1'")).toEqual([{ n: 0 }]);
  });

  it("a delete its tracker refuses leaves the sink's entry where it is: nothing queued, nothing sent", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1200, started: "2026-10-20T09:00:00+02:00", comment: "kept" });
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "synced" });
    const { ProviderError } = await import("../providers/core/errors");
    const tracker = fakes.tracker as { worklogs: { delete: (...a: unknown[]) => Promise<unknown> } };
    const real = tracker.worklogs.delete;
    tracker.worklogs.delete = async () => {
      throw new ProviderError("forbidden", "locked there");
    };
    try {
      await expect(caller.worklogs.delete({ id: made.id })).rejects.toThrow();
    } finally {
      tracker.worklogs.delete = real;
    }
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "synced" });
    expect((await sinkEntries()).map((e) => e.comment)).toContain("kept");
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE kind = 'delete'")).toEqual([{ n: 0 }]);
    // Then deleted for real: the sink follows.
    await caller.worklogs.delete({ id: made.id });
    await push();
    expect((await sinkEntries()).map((e) => e.comment)).not.toContain("kept");
  });

  it("a sink delete held while its worklog's delete is under way: a pass meanwhile sends nothing; gone, it is due even if nothing else ran (a crash)", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-21T09:00:00+02:00", comment: "held" });
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "synced" });
    const { holdSinkDeletes } = await import("./extraSinks");
    const { getDb } = await import("../queries/connection");
    const { worklogs } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [w] = await getDb().select().from(worklogs).where(eq(worklogs.id, made.id));
    // Held: the tracker's delete is on its way; a background pass runs right now.
    await holdSinkDeletes(w);
    await holdSinkDeletes(w);
    await push();
    expect((await sinkEntries()).map((e) => e.comment)).toContain("held");
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE worklog_id = ?", made.id)).toEqual([{ n: 1 }]);
    // Tied to its issue too: a day-totals sink recounts that tracker's day only.
    expect(await q("SELECT i.key, i.connection_id = w.connection_id AS same FROM outbox o JOIN issues i ON i.id = o.item_id JOIN worklogs w ON w.id = o.worklog_id WHERE o.worklog_id = ?", made.id)).toEqual([{ key: "FAKE-1", same: true }]);
    // Not shown as queued to the user while held.
    expect((await caller.outbox.list()).filter((o) => o.kind === "delete")).toEqual([]);
    // The tracker deleted it and the process died before anything else: the database alone makes the sink's delete due.
    await q("DELETE FROM worklogs WHERE id = ?", made.id);
    await push();
    expect((await sinkEntries()).map((e) => e.comment)).not.toContain("held");
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE kind = 'delete'")).toEqual([{ n: 0 }]);
  });

  it("two deletes of one worklog: the one that finds it already gone holds nothing (never a foreign-key 500)", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 700, started: "2026-10-24T09:00:00+02:00", comment: "twice" });
    await push();
    expect(await sinkRow(made.id)).toMatchObject({ state: "synced" });
    const { holdSinkDeletes } = await import("./extraSinks");
    const { getDb } = await import("../queries/connection");
    const { worklogs } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    // The second delete has read the worklog and its sink entries; the first deletes it,
    // all the way, just before the second one's transaction.
    const [seen] = await getDb().select().from(worklogs).where(eq(worklogs.id, made.id));
    const db = getDb();
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (...a: Parameters<typeof transaction>) => {
      await caller.worklogs.delete({ id: made.id });
      return transaction(...a);
    });
    try {
      await expect(holdSinkDeletes(seen)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    // The first one's sink delete only: queued once, sent once.
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM outbox WHERE kind = 'delete'")).toEqual([{ n: 1 }]);
    await push();
    expect((await sinkEntries()).map((e) => e.comment)).not.toContain("twice");
  });

  it("a sinks pass running while the tracker's delete is in flight sends nothing for it; once through, the sink follows", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 600, started: "2026-10-22T09:00:00+02:00", comment: "in flight" });
    await push();
    const tracker = fakes.tracker as { worklogs: { delete: (...a: unknown[]) => Promise<unknown> } };
    const real = tracker.worklogs.delete;
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const inFlight = new Promise<void>((r) => (started = r));
    tracker.worklogs.delete = async (...a: unknown[]) => {
      started();
      await new Promise<void>((r) => (release = r));
      return real(...a);
    };
    const deleting = caller.worklogs.delete({ id: made.id });
    try {
      await inFlight;
      await push();
      expect((await sinkEntries()).map((e) => e.comment)).toContain("in flight");
    } finally {
      // Released whatever happened: never a delete left hanging for the tests after.
      release();
      await deleting.catch(() => undefined);
      tracker.worklogs.delete = real;
    }
    await push();
    expect((await sinkEntries()).map((e) => e.comment)).not.toContain("in flight");
  });

  it("a worklog back from the trash is restored once however many asks race, and reaches the sinks again", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 1500, started: "2026-10-23T09:00:00+02:00", comment: "binned" });
    await push();
    await caller.worklogs.delete({ id: made.id });
    await push();
    expect((await sinkEntries()).map((e) => e.comment)).not.toContain("binned");
    const [item] = (await caller.worklogs.trash()).filter((t) => t.comment === "binned");
    // Two asks at once (a double click, two devices).
    const both = await Promise.allSettled([caller.worklogs.restore({ id: item.id }), caller.worklogs.restore({ id: item.id })]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM worklogs WHERE comment = 'binned'")).toEqual([{ n: 1 }]);
    expect((await caller.worklogs.trash()).filter((t) => t.comment === "binned")).toEqual([]);
    await push();
    expect((await sinkEntries()).filter((e) => e.comment === "binned")).toHaveLength(1);
    const [back] = await q<{ id: number }>("SELECT id FROM worklogs WHERE comment = 'binned'");
    await caller.worklogs.delete({ id: back.id });
    await push();
  });

  it("a restore that fails leaves the worklog in the trash", async () => {
    const made = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-23T14:00:00+02:00", comment: "stays binned" });
    await caller.worklogs.delete({ id: made.id });
    const [item] = (await caller.worklogs.trash()).filter((t) => t.comment === "stays binned");
    // Something now overlaps it, and overlaps are refused: the restore fails.
    const blocker = await caller.worklogs.create({ issueKey: "FAKE-1", seconds: 900, started: "2026-10-23T14:00:00+02:00", comment: "in the way" });
    await caller.settings.update({ overlapPolicy: "block" });
    try {
      await expect(caller.worklogs.restore({ id: item.id })).rejects.toThrow();
    } finally {
      await caller.settings.update({ overlapPolicy: "warn" });
    }
    expect((await caller.worklogs.trash()).filter((t) => t.comment === "stays binned")).toHaveLength(1);
    await caller.worklogs.delete({ id: blocker.id });
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
