// The status history job (docs/work/ideas/estimates.md R-3.12, R-3.13): read only, stored whole, read again when stale.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { jiraSimulator } from "../providers/jira/simulator";
import { workStretches, type StatusChange } from "@contracts/estimate";

const sim = jiraSimulator("https://hist.atlassian.net", "acc-h", { moreStatuses: [{ id: "41", name: "In Review", category: "indeterminate" }, { id: "51", name: "Testing", category: "indeterminate" }] });
/** Every call the tracker got, and what to do on the next changelog read */
const calls: { method: string; path: string }[] = [];
let onChangelog: (() => Promise<void>) | null = null;
let unreachable = false;
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname });
  if (/\/changelog$/.test(url.pathname)) {
    if (unreachable) return new Response("down", { status: 503 });
    const hook = onChangelog;
    onChangelog = null;
    if (hook) await hook();
  }
  return sim.fetch(input, init);
});

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const MIN = 60_000;

describe("status history reads", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let userId = 0;
  let connId = 0;
  let readDue: typeof import("./history").readDueHistories;

  const itemId = async (key: string) => (await q<{ id: number }>("SELECT id FROM issues WHERE key = ? AND connection_id = ?", key, connId))[0].id;
  const read = async (key: string) =>
    (await q<{ state: string; attempts: number; next_attempt_at: string | null; generation: number; reason: string | null }>("SELECT state, attempts, next_attempt_at, generation, reason FROM issue_history_reads WHERE item_id = ?", await itemId(key)))[0];
  const rows = async (key: string) =>
    q<{ ordinal: number; from_status_id: string | null; to_status_id: string }>(
      "SELECT ordinal, from_status_id, to_status_id FROM issue_status_changes WHERE item_id = ? ORDER BY ordinal",
      await itemId(key),
    );
  /** A closed issue of mine with my time, synced */
  const closedWithTime = async (key: string, path: string[]) => {
    sim.add(key, `Issue ${key}`);
    for (const s of path) sim.outside.transition(key, s);
    await caller.issues.sync();
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, ?, 3600, ?, ?)",
      userId,
      connId,
      key,
      `w-${key}`,
      Date.UTC(2026, 9, 2),
      Date.now(),
    );
  };

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { encrypt } = await import("../lib/crypto");
    [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('hist', 'Hist', 'admin', ?) RETURNING id", Date.now());
    [{ id: connId }] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', ?, ?, ?, ?, ?) RETURNING id",
      userId,
      sim.site,
      sim.me,
      JSON.stringify({ deployment: "cloud", authType: "basic", username: "h@x.it" }),
      encrypt("token"),
      Date.now(),
    );
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, userId));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    readDue = (await import("./history")).readDueHistories;
  });

  beforeEach(() => {
    calls.length = 0;
    unreachable = false;
    onChangelog = null;
  });

  it("the status history is read once, replaced on a new read, never written", async () => {
    await closedWithTime("APP-1", ["21", "31"]);
    await readDue();
    const expected = [
      { ordinal: 0, from_status_id: "11", to_status_id: "21" },
      { ordinal: 1, from_status_id: "21", to_status_id: "31" },
    ];
    expect(await rows("APP-1")).toEqual(expected);
    expect((await read("APP-1")).state).toBe("available");
    // Read again (as when it goes stale): the same rows, none twice.
    await q("UPDATE issue_history_reads SET state = 'stale' WHERE item_id = ?", await itemId("APP-1"));
    await readDue();
    expect(await rows("APP-1")).toEqual(expected);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a reopened issue's history goes stale and is read again", async () => {
    await closedWithTime("APP-2", ["21", "31"]);
    await readDue();
    expect((await read("APP-2")).state).toBe("available");
    // A tester reopens it, then it is closed again: the sync stores the new status.
    sim.outside.transition("APP-2", "21");
    await caller.issues.sync();
    expect((await read("APP-2")).state).toBe("stale");
    sim.outside.transition("APP-2", "31");
    await caller.issues.sync();
    await readDue();
    expect((await read("APP-2")).state).toBe("available");
    const stored = await rows("APP-2");
    expect(stored.map((r) => r.to_status_id)).toEqual(["21", "31", "21", "31"]);
    // Both stays in "In Progress" are work stretches.
    const ats = await q<{ at: string }>("SELECT at FROM issue_status_changes WHERE item_id = ? ORDER BY ordinal", await itemId("APP-2"));
    const changes: StatusChange[] = stored.map((r, i) => ({ at: Number(ats[i].at), ordinal: r.ordinal, from: r.from_status_id, to: r.to_status_id }));
    const check = workStretches({ changes, createdAt: 0, readAt: Date.now(), statusNow: "31", classify: (id) => id === "21", closed: true });
    expect(check.ok && check.stretches.length).toBe(2);
  });

  it("a read overtaken by a change writes nothing", async () => {
    await closedWithTime("APP-3", ["21", "31"]);
    const id = await itemId("APP-3");
    // While the changelog is on its way, the sync stores a newer version of the issue.
    onChangelog = async () => void (await q("UPDATE issues SET jira_updated_at = jira_updated_at + 1000 WHERE id = ?", id));
    await readDue();
    expect(await rows("APP-3")).toEqual([]);
    expect((await read("APP-3")).state).not.toBe("available");
  });

  it("a failed read leaves no half history and waits", async () => {
    await closedWithTime("APP-4", ["21", "31"]);
    unreachable = true;
    const now = Date.now();
    await readDue(now);
    const r = await read("APP-4");
    expect(r).toMatchObject({ state: "retry", attempts: 1 });
    expect(Number(r.next_attempt_at)).toBe(now + 5 * MIN);
    expect(await rows("APP-4")).toEqual([]);
    // Not due yet: left alone.
    unreachable = false;
    await readDue(now + MIN);
    expect((await read("APP-4")).state).toBe("retry");
  });

  it("a renamed status keeps its identity", async () => {
    await closedWithTime("APP-5", ["21", "31"]);
    await readDue();
    await q("INSERT INTO work_statuses (user_id, connection_id, status_id, counts) VALUES (?, ?, '21', 1)", userId, connId);
    const before = await rows("APP-5");
    sim.outside.renameStatus("21", "Doing");
    await q("UPDATE issue_history_reads SET state = 'stale' WHERE item_id = ?", await itemId("APP-5"));
    await readDue();
    expect(await rows("APP-5")).toEqual(before);
    expect(await q("SELECT status_id, counts FROM work_statuses WHERE user_id = ? AND connection_id = ?", userId, connId)).toEqual([{ status_id: "21", counts: 1 }]);
  });

  it("a status deleted since is still read through its snapshot", async () => {
    await closedWithTime("APP-6", ["41", "31"]);
    await readDue();
    expect((await read("APP-6")).state).toBe("available");
    expect(await q("SELECT status_id, category FROM status_snapshots WHERE connection_id = ? AND status_id = '41'", connId)).toEqual([{ status_id: "41", category: "doing" }]);
    sim.outside.deleteStatus("41");
    await q("UPDATE issue_history_reads SET state = 'stale' WHERE item_id = ?", await itemId("APP-6"));
    await readDue();
    expect((await read("APP-6")).state).toBe("available");
    expect((await rows("APP-6")).map((r) => r.to_status_id)).toEqual(["41", "31"]);
    // Without the snapshot nothing places it.
    await q("DELETE FROM status_snapshots WHERE connection_id = ? AND status_id = '41'", connId);
    await q("UPDATE issue_history_reads SET state = 'stale' WHERE item_id = ?", await itemId("APP-6"));
    await readDue();
    expect(await read("APP-6")).toMatchObject({ state: "invalid", reason: "unknownStatus" });
  });

  it("a status the tracker doesn't list is placed by the issues in it", async () => {
    // APP-7 sits in "Testing" when the site stops listing it; APP-8 went through it.
    sim.add("APP-7", "Still testing");
    sim.outside.transition("APP-7", "51");
    await closedWithTime("APP-8", ["51", "31"]);
    sim.outside.deleteStatus("51");
    await readDue();
    expect((await rows("APP-8")).map((r) => r.to_status_id)).toEqual(["51", "31"]);
    expect((await read("APP-8")).state).toBe("available");
  });

  it("a history that can't be read as statuses keeps its issues out, unlike no history at all", async () => {
    const { withoutStatusHistory } = await import("./history");
    expect(withoutStatusHistory({ history: true })).toEqual({ state: "invalid", reason: "noStatusHistory" });
    expect(withoutStatusHistory({ history: false })).toEqual({ state: "unsupported", reason: null });
  });
});
