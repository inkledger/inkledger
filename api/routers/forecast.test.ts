// The forecast API (docs/work/ideas/estimates.md R-3.17–R-3.21): capacity from my days, the finish
// of what's open, the trend of my closed issues; nothing until its service is ready.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, dayKey, startOfDay } from "@contracts/time";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const H = 3_600_000;
const DAY = 24 * H;

const { env } = await import("../lib/env");
const saved = { url: env.forecastUrl, sim: env.forecastSimulator };
afterEach(() => {
  env.forecastUrl = saved.url;
  env.forecastSimulator = saved.sim;
  vi.unstubAllGlobals();
});

async function makeUser(name: string) {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name);
  const [{ id: connId }] = await q<{ id: number }>(
    "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://f.example', 'me', '{}', 'x', 1) RETURNING id",
    userId,
  );
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  let seq = 0;
  /** An issue of mine; `closed` ones carry a history whose work stretch covers their worklogs. */
  const issue = async (key: string, o: { closed?: boolean; worklogs?: [number, number][]; assignee?: string; estimate?: number } = {}) => {
    const created = (o.worklogs?.[0]?.[0] ?? Date.now() - 30 * DAY) - H;
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_id, category, issue_type, components, time_estimate_seconds,
         project_key, project_name, url, assignee_id, jira_created_at, jira_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 'x', ?, ?, 'Task', '[]', ?, 'APP', 'App', 'https://x', ?, ?, ?, 1) RETURNING id`,
      userId, connId, `r-${key}`, key, key, o.closed ? "31" : "21", o.closed ? "done" : "doing", o.estimate ?? null, o.assignee ?? "me", created, created,
    );
    for (const [at, seconds] of o.worklogs ?? [])
      await q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, item_id, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        userId, connId, key, id, `w${++seq}-${key}`, seconds, at,
      );
    if (o.closed) {
      await q("INSERT INTO issue_history_reads (item_id, user_id, state, read_at, source_updated_at, status_id_at_read, changes) VALUES (?, ?, 'unsupported', ?, ?, '31', 0)", id, userId, Date.now(), created);
    }
    return id;
  };
  return { userId, connId, caller, issue };
}

/** Midday of the day `n` days from today (negative: past). */
const dayAt = (n: number, hour = 10) => addDays(startOfDay(new Date()), n).getTime() + hour * H;

describe("forecast", () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("capacity follows my week and my holidays", async () => {
    env.forecastSimulator = true;
    const u = await makeUser("f1");
    // Five hours on each working day of the last eight weeks (Monday to Friday by default).
    const logs: [number, number][] = [];
    for (let n = -56; n < 0; n++) {
      const d = new Date(dayAt(n));
      if (d.getDay() !== 0 && d.getDay() !== 6) logs.push([dayAt(n), 5 * 3600]);
    }
    await u.issue("APP-1", { worklogs: logs });
    // A holiday on the first working day after tomorrow.
    let holiday = 2;
    while ([0, 6].includes(new Date(dayAt(holiday)).getDay())) holiday++;
    await q("INSERT INTO planned_entries (user_id, kind, starts_at, ends_at, created_at, updated_at) VALUES (?, 'vacation', ?, ?, 1, 1)", u.userId, dayAt(holiday, 0), dayAt(holiday + 1, 0), );
    const { days } = await u.caller.forecast.capacity({ days: 28 });
    expect(days).toHaveLength(28);
    // From today: the history stops at yesterday.
    expect(days[0].day).toBe(dayKey(startOfDay(new Date())));
    for (const d of days) {
      expect(d.p10).toBeLessThanOrEqual(d.p50);
      expect(d.p50).toBeLessThanOrEqual(d.p90);
      const weekend = [0, 6].includes(new Date(`${d.day}T12:00:00`).getDay());
      if (d.day === dayKey(new Date(dayAt(holiday)))) expect(d).toMatchObject({ off: true, p10: 0, p50: 0, p90: 0 });
      else if (weekend) expect(d.p50).toBe(0);
      else expect(d.p50).toBeCloseTo(5, 5);
    }
    await expect(u.caller.forecast.capacity({ days: 91 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("no forecast until its service is ready", async () => {
    const u = await makeUser("f2");
    env.forecastSimulator = false;
    env.forecastUrl = null;
    expect(await u.caller.forecast.available()).toEqual({ available: false, model: null, reason: "off" });
    await expect(u.caller.forecast.capacity({ days: 28 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "The forecast isn't set up on this server." });
    // Up, its model still on the way.
    env.forecastUrl = "http://127.0.0.1:8601";
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input).endsWith("/ready") ? new Response(JSON.stringify({ reason: "loading" }), { status: 503 }) : new Response("{}", { status: 503 }),
    );
    expect(await u.caller.forecast.available()).toEqual({ available: false, model: null, reason: "loading" });
    await expect(u.caller.forecast.capacity({ days: 28 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "The forecast model is still getting ready: try again in a minute." });
    // Ready, but answering nonsense: refused, not drawn.
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input).endsWith("/ready")
        ? new Response(JSON.stringify({ model: "Timestral-28M" }))
        : new Response(JSON.stringify({ quantiles: { "0.1": [1], "0.5": [1], "0.9": [1] } })),
    );
    expect(await u.caller.forecast.available()).toEqual({ available: true, model: "Timestral-28M", reason: null });
    await expect(u.caller.forecast.capacity({ days: 28 })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });

  it("issues without history are named, not guessed", async () => {
    env.forecastSimulator = true;
    const u = await makeUser("f3");
    // Six closed issues of 2 h each (history for the estimates), worked on weekdays.
    const weekday = (n: number) => {
      while ([0, 6].includes(new Date(dayAt(n)).getDay())) n--;
      return n;
    };
    for (let i = 0; i < 6; i++) await u.issue(`DONE-${i}`, { closed: true, worklogs: [[dayAt(weekday(-3 - i * 3)), 2 * 3600]] });
    // Open: one untouched, one half done (1 h of 2), one already over (3 h): two named ways.
    await u.issue("OPEN-1");
    await u.issue("OPEN-2", { worklogs: [[dayAt(weekday(-1)), 3600]] });
    await u.issue("OPEN-3", { worklogs: [[dayAt(weekday(-2)), 3 * 3600]] });
    const f = await u.caller.forecast.finish({ issues: ["OPEN-1", "OPEN-2", "OPEN-3", "GONE-9"].map(issueKey => ({ issueKey, connectionId: u.connId })) });
    expect(f).toMatchObject({ counted: 3, unknown: 1, unknownKeys: ["GONE-9"], overKeys: ["OPEN-3"], workP50Hours: 3 });
    expect(f.p50).not.toBeNull();
    // Mine when no bucket is active: the open issues assigned to me, someone else's left out.
    await u.issue("THEIRS-1", { assignee: "someone" });
    const mine = await u.caller.forecast.finish({ scope: "active" });
    expect(mine).toMatchObject({ scope: { kind: "mine" }, counted: 3, unknown: 0 });
    // Another user's bucket: not found.
    const other = await makeUser("f3b");
    const [{ id: bucketId }] = await q<{ id: number }>("INSERT INTO buckets (user_id, name, position, created_at) VALUES (?, 'Theirs', 0, 1) RETURNING id", other.userId);
    await expect(u.caller.forecast.finish({ bucketId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the trend says where my times are going", async () => {
    env.forecastSimulator = true;
    const u = await makeUser("f4");
    // Sixteen weeks, two closed issues a week, each a bit faster than the week before; 1.5× the tracker's estimate.
    for (let w = 0; w < 16; w++)
      for (const k of [0, 1]) {
        const at = dayAt(-7 * (16 - w) + 1 + k);
        const seconds = Math.round((10 - w * 0.4) * 3600);
        await u.issue(`T-${w}-${k}`, { closed: true, worklogs: [[at, seconds]], estimate: Math.round(seconds / 1.5) });
      }
    const t = await u.caller.forecast.trend();
    if ("insufficient" in t.work || "insufficient" in t.ratio) throw new Error("expected both series");
    expect(t.work.weeks.length).toBeGreaterThanOrEqual(15);
    expect(t.work.forecast).toHaveLength(12);
    for (const p of t.work.forecast) expect(p.p10 <= p.p50 && p.p50 <= p.p90).toBe(true);
    expect(["better", "worse", "flat"]).toContain(t.work.direction);
    expect(t.ratio.weeks.every(w => Math.abs(w.value - 1.5) < 0.01)).toBe(true);
    // Too little history: said, not drawn.
    const fresh = await makeUser("f4b");
    await fresh.issue("ONE", { closed: true, worklogs: [[dayAt(-3), 3600]] });
    expect((await fresh.caller.forecast.trend()).work).toEqual({ insufficient: true, have: 1, need: 8 });
  });
});
