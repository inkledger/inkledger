import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { timeZone } from "@contracts/values";
import { unlimited } from "./budget";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const zone = timeZone("Europe/Rome");
const meta = { signal: new AbortController().signal, correlationId: "t" };
const ref = { remoteId: "r-1", key: "FAKE-1" };

describe("worklog registry against any service, through the contract", () => {
  let userId = 0;
  let connId = 0;
  type Fake = ReturnType<typeof import("../providers/fake/adapter").fakeTracker>;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('wl', 'Wl', ?) RETURNING id", Date.now());
    userId = u.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM worklogs WHERE user_id = ?", userId);
    await q("DELETE FROM connections WHERE user_id = ?", userId);
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://fake.example', 'me', '{}', 'x', ?) RETURNING id",
      userId,
      Date.now(),
    );
    connId = c.id;
  });

  async function setup(o: { entryUpdate?: boolean } = {}) {
    const { fakeTracker } = await import("../providers/fake/adapter");
    const { bindTracker } = await import("../providers/core/bind");
    const fake: Fake = fakeTracker([{ key: "FAKE-1", title: "First" }], o);
    const b = bindTracker(fake, { id: connId, userId, type: "gitlab", baseUrl: "https://fake.example", remoteAccountId: "me", options: { region: "eu" }, timeZone: zone, credential: async () => ({ kind: "token", token: "t" }) });
    const conn = { id: connId, userId, remoteAccountId: "me" };
    return { fake, b, conn };
  }

  /** A worklog logged in inkledger, not on the service yet. */
  async function local(seconds = 1800, comment = "") {
    const { getDb } = await import("../queries/connection");
    const { worklogs } = await import("@db/schema");
    const [w] = await getDb()
      .insert(worklogs)
      .values({ userId, connectionId: connId, issueKey: "FAKE-1", remoteId: "pending-0", timeSpentSeconds: seconds, started: new Date(Date.UTC(2026, 9, 14, 7)), comment })
      .returning();
    return w;
  }

  const sink = async (worklogId: number) => (await q<{ remote_id: string | null; state: string; version: string | null }>("SELECT remote_id, state, version FROM worklog_sinks WHERE worklog_id = ?", worklogId))[0];

  it("a worklog lands once however often it is pushed (its uuid is the key); the registry follows the service", async () => {
    const { b, conn } = await setup();
    const { pushCreate } = await import("./worklogs");
    const w = await local();
    expect(await sink(w.id)).toMatchObject({ remote_id: null, state: "pending" });
    const first = await pushCreate(b, conn, w, ref, meta, zone);
    const again = await pushCreate(b, conn, w, ref, meta, zone);
    expect(again.remoteId).toBe(first.remoteId);
    expect(await sink(w.id)).toEqual({ remote_id: first.remoteId, state: "synced", version: "1" });
    expect(await q("SELECT jira_worklog_id FROM worklogs WHERE id = ?", w.id)).toEqual([{ jira_worklog_id: first.remoteId }]);
  });

  it("changed in place at its revision; someone else's change in between is a conflict", async () => {
    const { b, conn, fake } = await setup();
    const { pushCreate, pushUpdate } = await import("./worklogs");
    const w = await local();
    const made = await pushCreate(b, conn, w, ref, meta, zone);
    const updated = await pushUpdate(b, conn, { ...w, timeSpentSeconds: 2400 }, ref, meta, zone);
    expect(updated.remoteId).toBe(made.remoteId);
    expect((await sink(w.id)).version).toBe("2");
    fake.outside.touchWorklog(made.remoteId);
    await expect(pushUpdate(b, conn, { ...w, timeSpentSeconds: 3000 }, ref, meta, zone)).rejects.toMatchObject({ kind: "conflict" });
  });

  it("where entries can only be logged again, a change deletes and recreates it, still the same worklog in inkledger", async () => {
    const { b, conn } = await setup({ entryUpdate: false });
    const { pushCreate, pushUpdate } = await import("./worklogs");
    const w = await local();
    const made = await pushCreate(b, conn, w, ref, meta, zone);
    const again = await pushUpdate(b, conn, { ...w, timeSpentSeconds: 2400 }, ref, meta, zone);
    expect(again.remoteId).not.toBe(made.remoteId);
    expect(await sink(w.id)).toMatchObject({ remote_id: again.remoteId, state: "synced" });
    expect(await b.worklogs!.list(meta, ref)).toHaveLength(1);
  });

  it("deleted on the service and out of the registry; deleting again is fine", async () => {
    const { b, conn } = await setup();
    const { pushCreate, pushDelete } = await import("./worklogs");
    const w = await local();
    await pushCreate(b, conn, w, ref, meta, zone);
    await pushDelete(b, conn, w, ref, meta);
    expect(await sink(w.id)).toBeUndefined();
    await pushDelete(b, conn, w, ref, meta);
    expect(await b.worklogs!.list(meta, ref)).toEqual([]);
  });

  it("the service's feed fills the registry: entries logged elsewhere come in, ours are recognised, removals go", async () => {
    const { b, conn } = await setup();
    const { pushCreate, syncEntries } = await import("./worklogs");
    const w = await local(1800, "from inkledger");
    await pushCreate(b, conn, w, ref, meta, zone);
    const elsewhere = await b.worklogs!.create!(meta, ref, { time: { kind: "session", start: Date.UTC(2026, 9, 15, 8) as never, seconds: 900 }, comment: "on the service" }, { idempotencyKey: "outside-1" });
    const first = await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
    expect(first.upserted).toBe(2);
    expect(await q("SELECT comment, time_spent_seconds FROM worklogs WHERE user_id = ? ORDER BY comment", userId)).toEqual([
      { comment: "from inkledger", time_spent_seconds: 1800 },
      { comment: "on the service", time_spent_seconds: 900 },
    ]);
    await b.worklogs!.delete!(meta, ref, elsewhere.remoteId, {});
    const next = await syncEntries(b, conn, { since: first.checkpoint, meta, budget: unlimited, zone });
    expect(next.removed).toBe(1);
    expect(await q("SELECT comment FROM worklogs WHERE user_id = ?", userId)).toEqual([{ comment: "from inkledger" }]);
  });

  it("an entry of ours read back before its answer came is the same worklog, never a second one (±60 s, same length)", async () => {
    const { b, conn } = await setup();
    const { syncEntries } = await import("./worklogs");
    const w = await local(1800, "lost answer");
    // On the service a few seconds off (its clock), the answer never reached us.
    await b.worklogs!.create!(meta, ref, { time: { kind: "session", start: (w.started.getTime() + 20_000) as never, seconds: 1800 }, comment: "lost answer" }, { idempotencyKey: "other-key" });
    await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM worklogs WHERE user_id = ?", userId)).toEqual([{ n: 1 }]);
    expect(await sink(w.id)).toMatchObject({ state: "synced" });
  });

  it("a service that keeps only the day (dayOnly): the clock time here stands that day; another day moves it", async () => {
    const { b, conn } = await setup();
    const { pushCreate, syncEntries } = await import("./worklogs");
    const w = await local(1800, "mine");
    await pushCreate(b, conn, w, ref, meta, zone);
    // Its clock time a guess, as GitLab 13 notes give it: first later the same day, then on the next.
    let shift = 3 * 3_600_000;
    const dayOnly = {
      ...b,
      worklogs: {
        ...b.worklogs!,
        changed: async (m: typeof meta, q: Parameters<NonNullable<typeof b.worklogs>["changed"] & object>[1]) => {
          const p = await b.worklogs!.changed!(m, q);
          return { ...p, items: p.items.map((x) => ({ ...x, dayOnly: true, span: x.span.kind === "session" ? { ...x.span, start: (x.span.start + shift) as never } : x.span })) };
        },
      },
    } as typeof b;
    await syncEntries(dayOnly, conn, { since: null, meta, budget: unlimited, zone });
    expect(await q("SELECT started FROM worklogs WHERE id = ?", w.id)).toEqual([{ started: w.started.getTime() }]);
    shift = 24 * 3_600_000;
    await syncEntries(dayOnly, conn, { since: null, meta, budget: unlimited, zone });
    expect(await q("SELECT started FROM worklogs WHERE id = ?", w.id)).toEqual([{ started: w.started.getTime() + shift }]);
  });

  it("changed on both sides: kept here, the service's version beside it (conflict); unchanged here: the service wins; locked there: said", async () => {
    const { b, conn, fake } = await setup();
    const { pushCreate, syncEntries } = await import("./worklogs");
    const w = await local(1800, "mine");
    const made = await pushCreate(b, conn, w, ref, meta, zone);
    const first = await syncEntries(b, conn, { since: null, meta, budget: unlimited, zone });
    // Unchanged here: the service's change comes in.
    fake.outside.changeWorklog(made.remoteId, { comment: "edited there" });
    const second = await syncEntries(b, conn, { since: first.checkpoint, meta, budget: unlimited, zone });
    expect(await q("SELECT comment FROM worklogs WHERE id = ?", w.id)).toEqual([{ comment: "edited there" }]);
    // Changed here too (not sent yet): a conflict, nothing overwritten.
    await q("UPDATE worklogs SET time_spent_seconds = 2400 WHERE id = ?", w.id);
    await q("UPDATE worklog_sinks SET state = 'pending' WHERE worklog_id = ?", w.id);
    fake.outside.changeWorklog(made.remoteId, { seconds: 1200 });
    const third = await syncEntries(b, conn, { since: second.checkpoint, meta, budget: unlimited, zone });
    expect(await q("SELECT time_spent_seconds FROM worklogs WHERE id = ?", w.id)).toEqual([{ time_spent_seconds: 2400 }]);
    const [c] = await q<{ state: string; remote_snapshot: string }>("SELECT state, remote_snapshot FROM worklog_sinks WHERE worklog_id = ?", w.id);
    expect(c.state).toBe("conflict");
    expect(JSON.parse(c.remote_snapshot)).toMatchObject({ seconds: 1200, comment: "edited there" });
    // Approved there: the lock is kept with its reason.
    await q("UPDATE worklog_sinks SET state = 'synced', remote_snapshot = NULL WHERE worklog_id = ?", w.id);
    fake.outside.lockWorklog(made.remoteId);
    await syncEntries(b, conn, { since: third.checkpoint, meta, budget: unlimited, zone });
    const [l] = await q<{ locked: string }>("SELECT locked FROM worklog_sinks WHERE worklog_id = ?", w.id);
    expect(JSON.parse(l.locked)).toEqual({ cause: "approved", message: "Approved by the team lead" });
  });
});
