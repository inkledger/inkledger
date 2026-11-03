import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { groupKey, splitOf, stretchesOf, timerId } from "@contracts/timerSplit";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let nextId = 1;

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (url.endsWith("/worklog") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { timeSpentSeconds: number; started: string };
      return json({ id: `wl-${nextId++}`, ...body, author: { accountId: "acc-1" } });
    }
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;

describe("timers side by side", () => {
  let on: (deviceId?: string) => Caller;
  let caller: Caller;
  let userId = 0;
  let conn = 0;

  beforeAll(async () => {
    const c = await import("../queries/connection");
    await c.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    userId = ctx.user!.id;
    on = (deviceId) => appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId, deviceId });
    caller = on();
    const [row] = await q("SELECT id FROM connections WHERE user_id = ?", userId);
    conn = Number(row.id);
  });

  const reset = async () => {
    await q("DELETE FROM timers");
    await q("DELETE FROM timer_runs");
    await q("DELETE FROM timer_shares");
    await q("DELETE FROM todo_sessions");
    await q("UPDATE settings SET overlap_policy = 'warn' WHERE user_id = ?", userId);
  };
  const running = async (c: Caller = caller) => (await c.timers.list()).filter((t) => t.state === "running").map((t) => t.issueKey).sort();

  it("concurrent switch starts leave a single running timer (the default mode)", async () => {
    await reset();
    await Promise.all([caller.timers.start({ issueKey: "PAR-7" }), caller.timers.start({ issueKey: "PAR-8" }), caller.timers.start({ issueKey: "PAR-9" })]);
    expect(await running()).toHaveLength(1);
  });

  it("alongside: the running ones run on; a switch then pauses them all and names every one", async () => {
    await reset();
    await caller.timers.start({ issueKey: "PAR-1" });
    const r = await caller.timers.start({ issueKey: "PAR-2", mode: "alongside" });
    expect(r.switchedFromAll).toEqual([]);
    await caller.timers.start({ issueKey: "PAR-3", mode: "alongside" });
    expect(await running()).toEqual(["PAR-1", "PAR-2", "PAR-3"]);
    const s = await caller.timers.start({ issueKey: "PAR-4" });
    expect(s.switchedFromAll.map((x) => x.issueKey).sort()).toEqual(["PAR-1", "PAR-2", "PAR-3"]);
    expect(s.switchedFrom?.issueKey).toBe(s.switchedFromAll.at(-1)?.issueKey);
    expect(await running()).toEqual(["PAR-4"]);
    // Every start and pause left its run: one open (PAR-4), the others closed.
    const open = await q("SELECT issue_key FROM timer_runs WHERE ended_at IS NULL");
    expect(open.map((x) => x.issue_key)).toEqual(["PAR-4"]);
  });

  it("refused while overlapping time is refused, and from a gap's start", async () => {
    await reset();
    await caller.timers.start({ issueKey: "PAR-1" });
    await q("UPDATE settings SET overlap_policy = 'block' WHERE user_id = ?", userId);
    await expect(caller.timers.start({ issueKey: "PAR-2", mode: "alongside" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Alone, alongside is only a start (a take-over keeps it): never refused.
    await expect(caller.timers.start({ issueKey: "PAR-1", mode: "alongside" })).resolves.toMatchObject({ ok: true });
    await q("UPDATE settings SET overlap_policy = 'warn' WHERE user_id = ?", userId);
    await expect(caller.timers.start({ issueKey: "PAR-2", mode: "alongside", from: new Date(Date.now() - 60_000).toISOString() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("another device's timer is left alone alongside (no take-over needed); the heartbeat renews all of this device's", async () => {
    await reset();
    const laptop = on("device-laptop-1");
    const phone = on("device-phone-1");
    await laptop.timers.start({ issueKey: "PAR-1" });
    await phone.timers.start({ issueKey: "PAR-2", mode: "alongside" });
    await phone.timers.start({ issueKey: "PAR-3", mode: "alongside" });
    expect(await running(phone)).toEqual(["PAR-1", "PAR-2", "PAR-3"]);
    await q("UPDATE timers SET lease_until = ? WHERE owner_device = 'device-phone-1'", Date.now() + 1000);
    expect(await phone.timers.heartbeat()).toMatchObject({ owned: true });
    const leases = await q("SELECT lease_until FROM timers WHERE owner_device = 'device-phone-1'");
    expect(leases.every((l) => Number(l.lease_until) > Date.now() + 60_000)).toBe(true);
  });

  it("pausing one timer leaves the TODO worked on with another running", async () => {
    await reset();
    await caller.timers.start({ issueKey: "PAR-1" });
    await caller.timers.start({ issueKey: "PAR-2", mode: "alongside" });
    const [todo] = await q("INSERT INTO todos (user_id, text, connection_id, issue_key, position, created_at, updated_at) VALUES (?, 'review', ?, 'PAR-1', 0, 1, 1) RETURNING id", userId, conn);
    await q("INSERT INTO todo_sessions (user_id, todo_id, label, linked, started_at) VALUES (?, ?, 'review', 1, ?)", userId, todo.id, Date.now());
    await caller.timers.pause({ issueKey: "PAR-2" });
    expect(await q("SELECT 1 FROM todo_sessions WHERE ended_at IS NULL")).toHaveLength(1);
    await caller.timers.pause({ issueKey: "PAR-1" });
    expect(await q("SELECT 1 FROM todo_sessions WHERE ended_at IS NULL")).toHaveLength(0);
  });

  it("A logs 60 % of the 40 min it ran with B; B is then offered the 40 % left, after A's part", async () => {
    await reset();
    await caller.timers.start({ issueKey: "PAR-1" });
    await caller.timers.start({ issueKey: "PAR-2", mode: "alongside" });
    await caller.timers.stop({ issueKey: "PAR-1" });
    await caller.timers.stop({ issueKey: "PAR-2" });
    // As they ran: A 9:00–11:00, B 10:20–11:30 (a day of last month).
    const d = new Date();
    d.setDate(d.getDate() - 20);
    const at = (h: number, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
    await q("DELETE FROM timer_runs");
    await q("INSERT INTO timer_runs (user_id, connection_id, issue_key, started_at, ended_at) VALUES (?, ?, 'PAR-1', ?, ?), (?, ?, 'PAR-2', ?, ?)", userId, conn, at(9), at(11), userId, conn, at(10, 20), at(11, 30));
    await q("UPDATE timers SET accumulated_seconds = 7200, paused_at = ? WHERE issue_key = 'PAR-1'", at(11));
    await q("UPDATE timers SET accumulated_seconds = 4200, paused_at = ? WHERE issue_key = 'PAR-2'", at(11, 30));
    const A = timerId(conn, "PAR-1");
    const B = timerId(conn, "PAR-2");
    expect((await caller.timers.list()).map((t) => [t.issueKey, t.overlapSeconds, t.defaultSeconds])).toEqual(
      expect.arrayContaining([
        ["PAR-1", 2400, 6000],
        ["PAR-2", 2400, 3000],
      ]),
    );

    const a = await caller.timers.split({ issueKey: "PAR-1" });
    expect(a.trackedSeconds).toBe(7200);
    const mine = splitOf(A, stretchesOf(A, a.runs, a.shares), { [groupKey([B])]: 6000 }, a.trackedSeconds);
    expect([mine.toLogSeconds, mine.pieces]).toEqual([104 * 60, [{ start: at(9), seconds: 104 * 60 }]]);
    await caller.worklogs.create({
      issueKey: "PAR-1",
      seconds: mine.toLogSeconds,
      started: new Date(at(9)).toISOString(),
      fromTimer: true,
      split: { until: a.until.toISOString(), shares: [{ with: [B], bp: 6000 }] },
    });
    expect((await caller.timers.list()).map((t) => t.issueKey)).toEqual(["PAR-2"]);
    expect(await q("SELECT issue_key, started_at, ended_at, share_bp FROM timer_shares")).toEqual([
      { issue_key: "PAR-1", started_at: at(10, 20), ended_at: at(11), share_bp: 6000 },
    ]);

    const b = await caller.timers.split({ issueKey: "PAR-2" });
    const theirs = splitOf(B, stretchesOf(B, b.runs, b.shares), {}, b.trackedSeconds);
    expect(theirs.groups[0].bp).toBe(4000);
    expect([theirs.toLogSeconds, theirs.pieces]).toEqual([46 * 60, [{ start: at(10, 44), seconds: 46 * 60 }]]);
    expect((await caller.timers.list())[0].defaultSeconds).toBe(46 * 60);
  });

  it("a split only goes with a timer's log", async () => {
    await expect(
      caller.worklogs.create({ issueKey: "PAR-1", seconds: 600, started: new Date().toISOString(), split: { until: new Date().toISOString(), shares: [] } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a discarded timer gives the time it ran with another back to it", async () => {
    await reset();
    await caller.timers.start({ issueKey: "PAR-1" });
    await caller.timers.start({ issueKey: "PAR-2", mode: "alongside" });
    await caller.timers.stop({ issueKey: "PAR-1" });
    await caller.timers.stop({ issueKey: "PAR-2" });
    await q("UPDATE timer_runs SET started_at = started_at - 3600000");
    await caller.timers.discard({ issueKey: "PAR-1" });
    const b = await caller.timers.split({ issueKey: "PAR-2" });
    expect(stretchesOf(timerId(conn, "PAR-2"), b.runs, b.shares).stretches).toEqual([]);
  });
});
