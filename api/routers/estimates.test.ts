// The estimates API (docs/work/ideas/estimates.md R-3.1–R-3.4, R-3.10, R-3.14, R-3.15): samples from proven
// histories, the universe of 2000, the cache held to the revision, the TODO habit, statuses that count.
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { jiraSimulator } from "../providers/jira/simulator";
import { countQueries } from "../testing/countQueries";

// The tracker answers statuses() for Settings → Estimates: 41 is a "doing" status, as a waiting one often is.
const sim = jiraSimulator("https://est.atlassian.net", "acc-e", { moreStatuses: [{ id: "41", name: "Waiting for customer", category: "indeterminate" }] });
vi.stubGlobal("fetch", sim.fetch);

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const H = 3_600_000;
const BASE = Date.UTC(2026, 8, 1, 8);
const NOW = Date.UTC(2026, 9, 29, 12);

type State = "available" | "unsupported" | "stale" | "invalid" | "pending" | "retry";
type Fixture = {
  key: string;
  state?: State | null;
  type?: string;
  summary?: string;
  estimate?: number | null;
  category?: string;
  /** Status changes after creation, each an hour apart: [from, to] ids */
  path?: [string | null, string][];
  /** [hours after BASE + day, seconds] */
  worklogs?: [number, number][];
  /** Days after BASE */
  day?: number;
};

async function makeUser(name: string) {
  const { encrypt } = await import("../lib/crypto");
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name);
  const [{ id: connId }] = await q<{ id: number }>(
    "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', ?, ?, ?, ?, 1) RETURNING id",
    userId,
    sim.site,
    sim.me,
    JSON.stringify({ deployment: "cloud", authType: "basic", username: `${name}@x.it` }),
    encrypt("token"),
  );
  for (const [id, n, c] of [["11", "To Do", "todo"], ["21", "In Progress", "doing"], ["31", "Done", "done"], ["41", "Waiting for customer", "doing"]])
    await q("INSERT INTO status_snapshots (connection_id, status_id, name, category, seen_at) VALUES (?, ?, ?, ?, 1)", connId, id, n, c);
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });

  /** A closed issue of mine: created at its day, each status change 7 h after the one before (the first after 1 h); 1 h logged at 2 h */
  const issue = async (f: Fixture) => {
    const start = BASE + (f.day ?? 0) * 24 * H;
    const path = f.path ?? [["11", "21"], ["21", "31"]];
    const last = path.at(-1)?.[1] ?? "11";
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_id, category, issue_type, components, time_estimate_seconds,
         project_key, project_name, url, jira_created_at, jira_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?, '[]', ?, 'APP', 'App', 'https://x', ?, ?, ?) RETURNING id`,
      userId,
      connId,
      `r-${f.key}`,
      f.key,
      f.summary ?? f.key,
      last,
      f.category ?? "done",
      f.type ?? "Task",
      f.estimate ?? null,
      start,
      start + 9 * H,
      NOW,
    );
    for (const [n, [h, s]] of (f.worklogs ?? [[2, 3600]]).entries())
      await q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, item_id, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        userId,
        connId,
        f.key,
        id,
        `w-${f.key}-${n}`,
        s,
        start + h * H,
        NOW,
      );
    const state = f.state === undefined ? "available" : f.state;
    if (state !== null) {
      await q(
        "INSERT INTO issue_history_reads (item_id, user_id, state, read_at, source_updated_at, status_id_at_read, changes, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        userId,
        state,
        NOW,
        start + 9 * H,
        last,
        path.length,
        state === "retry" ? NOW + H : null,
      );
      if (state !== "unsupported")
        for (const [n, [from, to]] of path.entries())
          await q("INSERT INTO issue_status_changes (item_id, ordinal, at, from_status_id, to_status_id) VALUES (?, ?, ?, ?, ?)", id, n, start + (1 + 7 * n) * H, from, to);
    }
    return id;
  };
  return { userId, connId, caller, issue };
}

describe("estimates", () => {
  let mod: typeof import("../estimates/estimate");

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    mod = await import("../estimates/estimate");
  });

  it("only proven histories make samples, and the left-out are counted", async () => {
    const u = await makeUser("e1");
    for (const [n, state] of (["available", "available", "available", "unsupported", "stale", "invalid", null] as const).entries()) await u.issue({ key: `A-${n}`, state });
    await u.issue({ key: "T-1", category: "doing" });
    const e = await mod.estimateForIssue(u.userId, { issueKey: "T-1" }, NOW, new mod.EstimateCache());
    expect(e).toMatchObject({ none: true, n: 4, excluded: { pending: 1, stale: 1, retry: 0, invalid: 1 } });
  });

  it("without history on the tracker every worklog counts, and it says so", async () => {
    const u = await makeUser("e2");
    for (let n = 0; n < 4; n++) await u.issue({ key: `B-${n}`, type: "Bug" });
    // Its 2 h are logged before any status change: only "all worklogs" counts them.
    await u.issue({ key: "B-9", type: "Bug", state: "unsupported", worklogs: [[0, 7200]] });
    for (let n = 0; n < 6; n++) await u.issue({ key: `S-${n}`, type: "Story" });
    await u.issue({ key: "T-2", type: "Bug", category: "doing" });
    const e = await mod.estimateForIssue(u.userId, { issueKey: "T-2" }, NOW, new mod.EstimateCache());
    // All in one project: the same type there is tier 2.
    expect(e).toMatchObject({ none: false, tier: 2, n: 5, allWorklogs: 1 });
  });

  it("the sample limit applies to issues, not worklogs", async () => {
    const u = await makeUser("e3");
    // 2100 issues of 30 min each, the 100 oldest the only bugs; the 400 newest logged in two worklogs (2500 in all).
    await q(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_id, category, issue_type, components, project_key, project_name, url, jira_created_at, synced_at)
       SELECT ?, ?, 'r' || n, 'L-' || n, 'L ' || n, 'x', '31', 'done', CASE WHEN n <= 100 THEN 'Bug' ELSE 'Task' END, '[]', 'APP', 'App', 'https://x', ?::bigint + n::bigint * 3600000, ? FROM generate_series(1, 2100) n`,
      u.userId,
      u.connId,
      BASE,
      NOW,
    );
    await q(
      `INSERT INTO worklogs (user_id, connection_id, issue_key, item_id, jira_worklog_id, time_spent_seconds, started, synced_at)
       SELECT i.user_id, i.connection_id, i.key, i.id, 'w' || i.id || '-' || k, CASE WHEN i.jira_created_at >= ?::bigint + 1701::bigint * 3600000 THEN 900 ELSE 1800 END, i.jira_created_at + k * 60000, ?
       FROM issues i, generate_series(1, 2) k WHERE i.user_id = ? AND (k = 1 OR i.jira_created_at >= ?::bigint + 1701::bigint * 3600000)`,
      BASE,
      NOW,
      u.userId,
      BASE,
    );
    await q("INSERT INTO issue_history_reads (item_id, user_id, state) SELECT id, user_id, 'unsupported' FROM issues WHERE user_id = ?", u.userId);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM worklogs WHERE user_id = ?", u.userId))[0].n).toBe(2500);
    await u.issue({ key: "T-3", type: "Bug", category: "doing" });
    const e = await mod.estimateForIssue(u.userId, { issueKey: "T-3" }, NOW, new mod.EstimateCache());
    // The bugs are the oldest 100: outside the newest 2000, so no tier of bugs (only the project's), and every sample is one issue's 30 min.
    expect(e).toMatchObject({ none: false, tier: 4, n: 2000, p20: 1800, p80: 1800 });
  });

  it("another user's issue has no estimate", async () => {
    const a = await makeUser("e4a");
    const b = await makeUser("e4b");
    await a.issue({ key: "T-4", category: "doing" });
    await expect(b.caller.estimates.forIssue({ issueKey: "T-4" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.estimates.forIssue({ issueKey: "T-4", connectionId: a.connId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.estimates.workStatuses({ connectionId: a.connId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.caller.estimates.setWorkStatus({ connectionId: a.connId, statusId: "21", counts: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a closed issue shows no estimate", async () => {
    const u = await makeUser("e5");
    await u.issue({ key: "T-5" });
    expect(await u.caller.estimates.forIssue({ issueKey: "T-5" })).toEqual({ hidden: "closed" });
  });

  it("a cache never outlives a write made by another instance", async () => {
    const u = await makeUser("e6");
    for (let n = 0; n < 5; n++) await u.issue({ key: `C-${n}` });
    await u.issue({ key: "T-6", category: "doing" });
    const mine = new mod.EstimateCache();
    await mod.estimateForIssue(u.userId, { issueKey: "T-6" }, NOW, mine);
    // Another server process logs time on one of the samples (its own cache, the same database).
    const theirs = new mod.EstimateCache();
    await mod.estimateForIssue(u.userId, { issueKey: "T-6" }, NOW, theirs);
    await q("UPDATE worklogs SET time_spent_seconds = 36000 WHERE issue_key = 'C-0' AND user_id = ?", u.userId);
    const counter = countQueries();
    try {
      await mod.estimateForIssue(u.userId, { issueKey: "T-6" }, NOW, mine);
      // Recomputed: the revision, then the samples (a cached answer is the revision alone).
      expect(counter.n).toBe(2);
    } finally {
      counter.stop();
    }
  });

  it("an estimate reads the revision, then the samples once", async () => {
    const u = await makeUser("e7");
    for (let n = 0; n < 6; n++) await u.issue({ key: `D-${n}` });
    await u.issue({ key: "T-7", category: "doing" });
    const cache = new mod.EstimateCache();
    const counter = countQueries();
    try {
      await mod.estimateForIssue(u.userId, { issueKey: "T-7" }, NOW, cache);
      expect(counter.n).toBe(2);
      counter.reset();
      await mod.estimateForIssue(u.userId, { issueKey: "T-7" }, NOW, cache);
      expect(counter.n).toBe(1);
    } finally {
      counter.stop();
    }
  });

  /** A TODO of mine with an estimate and the time its sessions took */
  const todo = async (userId: number, estimate: number | null, sessions: number[], at = BASE) => {
    const [{ id }] = await q<{ id: number }>("INSERT INTO todos (user_id, text, estimate_seconds, created_at, updated_at) VALUES (?, 'x', ?, ?, ?) RETURNING id", userId, estimate, at, at);
    for (const [n, s] of sessions.entries())
      await q("INSERT INTO todo_sessions (user_id, todo_id, label, started_at, ended_at) VALUES (?, ?, 'x', ?, ?)", userId, id, at + n * 2 * H, at + n * 2 * H + s * 1000);
    return id;
  };

  it("a TODO without issue gets my TODO habit", async () => {
    const u = await makeUser("e8");
    for (let n = 0; n < 6; n++) await todo(u.userId, 3600, [3000, 1320], BASE + n * 24 * H);
    const open = await todo(u.userId, null, []);
    expect(await u.caller.estimates.forTodo({ id: open })).toEqual({ todoRatio: 1.2, n: 6 });
  });

  it("a status switched off stops counting", async () => {
    const u = await makeUser("e9");
    // An hour In Progress, then waiting for the customer with 3 h logged there, then done.
    for (let n = 0; n < 5; n++)
      await u.issue({
        key: `W-${n}`,
        path: [["11", "21"], ["21", "41"], ["41", "31"]],
        worklogs: [[2, 1800], [9, 10800]],
      });
    await u.issue({ key: "T-9", category: "doing" });
    const before = await u.caller.estimates.forIssue({ issueKey: "T-9" });
    expect(before).toMatchObject({ none: false, p50: 1800 + 10800 });
    const [{ revision: r0 }] = await q<{ revision: string }>("SELECT revision FROM estimate_revisions WHERE user_id = ?", u.userId);
    const listed = await u.caller.estimates.workStatuses({ connectionId: u.connId });
    expect(listed.find((s) => s.statusId === "41")).toMatchObject({ name: "Waiting for customer", counts: true, byDefault: true });
    await u.caller.estimates.setWorkStatus({ connectionId: u.connId, statusId: "41", counts: false });
    const [{ revision: r1 }] = await q<{ revision: string }>("SELECT revision FROM estimate_revisions WHERE user_id = ?", u.userId);
    expect(BigInt(r1)).toBe(BigInt(r0) + 1n);
    expect(await u.caller.estimates.forIssue({ issueKey: "T-9" })).toMatchObject({ none: false, p50: 1800 });
    expect((await u.caller.estimates.workStatuses({ connectionId: u.connId })).find((s) => s.statusId === "41")).toMatchObject({ counts: false, byDefault: false });
    await expect(u.caller.estimates.setWorkStatus({ connectionId: u.connId, statusId: "99", counts: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a TODO's estimate or session changes the TODO ratio", async () => {
    const u = await makeUser("e10");
    const ids: number[] = [];
    for (let n = 0; n < 6; n++) ids.push(await todo(u.userId, 3600, [4320], BASE + n * 24 * H));
    const open = await todo(u.userId, null, []);
    const cache = new mod.EstimateCache();
    const rev = async () => BigInt((await q<{ revision: string }>("SELECT revision FROM estimate_revisions WHERE user_id = ?", u.userId))[0].revision);
    /** Queries an answer costs: 1 from the cache (the revision), 2 recomputed */
    const cost = async () => {
      const counter = countQueries();
      try {
        await mod.estimateForTodo(u.userId, open, NOW, cache);
        return counter.n;
      } finally {
        counter.stop();
      }
    };
    expect(await mod.estimateForTodo(u.userId, open, NOW, cache)).toEqual({ todoRatio: 1.2, n: 6 });
    expect(await cost()).toBe(1);
    let r = await rev();
    await q("INSERT INTO todo_sessions (user_id, todo_id, label, started_at, ended_at) VALUES (?, ?, 'x', ?, ?)", u.userId, ids[0], NOW - 2 * H, NOW - H);
    expect(await rev()).toBe(r + 1n);
    expect(await cost()).toBe(2);
    r = await rev();
    await q("UPDATE todos SET estimate_seconds = 7200 WHERE id = ?", ids[1]);
    expect(await rev()).toBe(r + 1n);
    expect(await cost()).toBe(2);
    expect(await cost()).toBe(1);
  });

  it("counters count within their universe", async () => {
    const u = await makeUser("e11");
    // 2100 candidates, 10 min apart: the 100 oldest never read; the rest proven.
    await q(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_id, category, issue_type, components, project_key, project_name, url, jira_created_at, synced_at)
       SELECT ?, ?, 'r' || n, 'U-' || n, 'U ' || n, 'x', '31', 'done', CASE WHEN n = 2050 THEN 'Bug' ELSE 'Task' END, '[]', 'APP', 'App', 'https://x', ?::bigint + n::bigint * 600000, ? FROM generate_series(1, 2100) n`,
      u.userId,
      u.connId,
      BASE,
      NOW,
    );
    await q(
      `INSERT INTO worklogs (user_id, connection_id, issue_key, item_id, jira_worklog_id, time_spent_seconds, started, synced_at)
       SELECT user_id, connection_id, key, id, 'w' || id, 3600, jira_created_at + 7200000, ? FROM issues WHERE user_id = ?`,
      NOW,
      u.userId,
    );
    await q(
      `INSERT INTO issue_history_reads (item_id, user_id, state, read_at, source_updated_at, status_id_at_read, changes)
       SELECT id, user_id, CASE WHEN key IN ('U-2040', 'U-2050') THEN 'unsupported' ELSE 'available' END, ?, jira_created_at, '31', 2 FROM issues WHERE user_id = ? AND jira_created_at >= ?::bigint + 101 * 600000`,
      NOW,
      u.userId,
      BASE,
    );
    await q(
      `INSERT INTO issue_status_changes (item_id, ordinal, at, from_status_id, to_status_id)
       SELECT i.id, k - 1, i.jira_created_at + CASE k WHEN 1 THEN 3600000 ELSE 28800000 END, CASE k WHEN 1 THEN '11' ELSE '21' END, CASE k WHEN 1 THEN '21' ELSE '31' END
       FROM issues i JOIN issue_history_reads r ON r.item_id = i.id AND r.state = 'available', generate_series(1, 2) k WHERE i.user_id = ?`,
      u.userId,
    );
    await u.issue({ key: "T-11", type: "Task", category: "doing" });
    const e = await mod.estimateForIssue(u.userId, { issueKey: "T-11" }, NOW, new mod.EstimateCache());
    expect(e).toMatchObject({ none: false, tier: 2, allWorklogs: 1, excluded: { pending: 0, stale: 0, retry: 0, invalid: 0 } });
    expect(await u.caller.estimates.historyStates()).toEqual({ available: 1998, pending: 100, unsupported: 2, stale: 0, retry: 0, invalid: 0 });
  });

  it("the statuses already seen stand in when the tracker can't be reached", async () => {
    const u = await makeUser("e12");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    try {
      const listed = await u.caller.estimates.workStatuses({ connectionId: u.connId });
      expect(listed.map((s) => s.statusId).sort()).toEqual(["11", "21", "31", "41"]);
      await u.caller.estimates.setWorkStatus({ connectionId: u.connId, statusId: "41", counts: false });
    } finally {
      vi.stubGlobal("fetch", sim.fetch);
    }
  });

  it("accuracy predicts each issue from the ones worked before it", async () => {
    const u = await makeUser("e13");
    for (let n = 0; n < 6; n++) await u.issue({ key: `R-${n}`, day: n });
    // The first five have too little before them; the sixth is predicted from five alike 1 h issues: exact.
    expect(await mod.accuracyFor(u.userId, NOW, new mod.EstimateCache())).toEqual({ n: 1, skipped: 5, mdape: 0, coverage: 100 });
  });
});
