import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** Raw SQL on the test database (Postgres, "?" placeholders). */
const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Worklogs Jira knows by id (GET /issue/{key}/worklog/{id}). */
const remoteWorklogs = new Map<string, { id: string; started: string; timeSpentSeconds: number }>();
let nextId = 1;

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    const one = /\/issue\/[A-Z0-9_]+-\d+\/worklog\/([^/?]+)$/.exec(url);
    if (one && method === "GET") {
      const w = remoteWorklogs.get(decodeURIComponent(one[1]));
      return w ? json({ ...w, author: { accountId: "acc-1" } }) : json({ errorMessages: ["gone"] }, 404);
    }
    if (one && method === "DELETE")
      return decodeURIComponent(one[1]) === "wl-refused" ? json({ errorMessages: ["Jira refuses this delete"] }, 400) : new Response(null, { status: 204 });
    if (one && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { timeSpentSeconds: number; started: string };
      return json({ id: decodeURIComponent(one[1]), ...body, author: { accountId: "acc-1" } });
    }
    if (url.endsWith("/worklog") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { timeSpentSeconds: number; started: string };
      return json({ id: `wl-${nextId++}`, ...body, author: { accountId: "acc-1" } });
    }
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

describe("worklogs and stats", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let userId = 0;

  const insertLog = (issueKey: string, started: Date, seconds: number, id = `local-${nextId++}`) =>
    q(
      `INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, author_account_id, synced_at)
         VALUES (?, ?, ?, ?, ?, '', 'acc-1', 0)`,
      userId,
      issueKey,
      id,
      seconds,
      started.getTime(),
    );

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    userId = ctx.user!.id;
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
  });

  it("list treats `to` as exclusive", async () => {
    (await q("DELETE FROM worklogs"));
    const from = new Date(2026, 5, 1);
    const to = new Date(2026, 5, 8);
    await insertLog("RNG-1", from, 60);
    await insertLog("RNG-1", to, 60); // first instant of the next period
    const logs = await caller.worklogs.list({ from: from.toISOString(), to: to.toISOString() });
    expect(logs.map((l) => l.started.getTime())).toEqual([from.getTime()]);
  });

  it("dashboard sums stop at the end of the week / month; unknown issues count under their prefix", async () => {
    (await q("DELETE FROM worklogs"));
    (await q("DELETE FROM issues"));
    const { startOfWeek, addDays } = await import("@contracts/time");
    const now = new Date();
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // future entries (next week / next month) are not "this week" / "this month"
    const entries: [Date, number][] = [
      [now, 3600],
      [addDays(weekStart, 7), 7200],
      [new Date(now.getFullYear(), now.getMonth() + 1, 1), 10800],
    ];
    for (const [d, s] of entries) await insertLog("GHOST-1", d, s);
    const sumIn = (from: Date, to: Date) =>
      entries.filter(([d]) => d >= from && d < to).reduce((a, [, s]) => a + s, 0);
    const stats = await caller.stats.dashboard();
    expect(stats.todaySeconds).toBe(3600);
    expect(stats.weekSeconds).toBe(sumIn(weekStart, addDays(weekStart, 7)));
    expect(stats.weekSeconds).toBeLessThan(3600 + 7200);
    expect(stats.monthSeconds).toBe(
      sumIn(monthStart, new Date(now.getFullYear(), now.getMonth() + 1, 1)),
    );
    expect(stats.monthSeconds).toBeLessThan(3600 + 7200 + 10800);
    expect(stats.perProject[0]).toMatchObject({ projectKey: "GHOST", projectName: "" });

    const reports = await import("./reports");
    expect(reports.worklogProjectKey).toBeDefined();
    const { dayKey } = await import("@contracts/time");
    const report = await caller.reports.generate({ from: dayKey(now), to: dayKey(now), groupBy: "project" });
    expect(report.rows.map((r) => r.key)).toEqual(["GHOST"]);
  });

  it("hours worked: work in parallel counts once, today and in the last days; per project each its own", async () => {
    (await q("DELETE FROM worklogs"));
    const today = new Date();
    today.setHours(0, 5, 0, 0);
    // 00:05–01:05 and 00:35–01:35 in parallel: 2 h logged, 1.5 h worked.
    await insertLog("PAR-1", today, 3600);
    await insertLog("PAR-2", new Date(today.getTime() + 1800_000), 3600);
    const stats = await caller.stats.dashboard();
    expect(stats.todaySeconds).toBe(5400);
    expect(stats.perDay.at(-1)?.seconds).toBe(5400);
    expect(stats.perProject.reduce((a, p) => a + p.seconds, 0)).toBe(7200);
    // Reports: the total and each day worked once, each issue its own hours, the logged sum beside.
    const { dayKey } = await import("@contracts/time");
    const range = { from: dayKey(today), to: dayKey(today) };
    const byDay = await caller.reports.generate({ ...range, groupBy: "day" });
    expect([byDay.totalSeconds, byDay.loggedSeconds, byDay.rows[0].seconds, byDay.rows[0].entries]).toEqual([5400, 7200, 5400, 2]);
    const byIssue = await caller.reports.generate({ ...range, groupBy: "issue" });
    expect([byIssue.totalSeconds, byIssue.rows.map((r) => r.seconds)]).toEqual([5400, [3600, 3600]]);
    const daily = await caller.reports.daily(range);
    expect([daily.totalSeconds, daily.loggedSeconds, daily.days[0].seconds, daily.days[0].loggedSeconds]).toEqual([5400, 7200, 5400, 7200]);
    // Without parallel work, the plain sum as always.
    (await q("DELETE FROM worklogs WHERE issue_key = 'PAR-2'"));
    await insertLog("PAR-2", new Date(today.getTime() + 3600_000), 3600);
    expect((await caller.stats.dashboard()).todaySeconds).toBe(7200);
  });

  it("logging a restarted timer subtracts the logged time; a stopped one is cleared", async () => {
    (await q("DELETE FROM timers"));
    await caller.timers.start({ issueKey: "TMR-1" });
    (await q("UPDATE timers SET accumulated_seconds = 5400, started_at = ? WHERE issue_key = 'TMR-1'", Date.now()));
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    await caller.worklogs.create({
      issueKey: "TMR-1",
      timeSpent: "1h",
      started: hoursAgo(10),
      fromTimer: true,
    });
    const [t] = await caller.timers.list();
    expect(t.state).toBe("running");
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(1800);
    expect(t.elapsedSeconds).toBeLessThan(1810);
    // never below zero
    await caller.worklogs.create({ issueKey: "TMR-1", timeSpent: "2h", started: hoursAgo(8), fromTimer: true });
    expect((await caller.timers.list())[0].elapsedSeconds).toBeLessThan(10);
    // stopped → cleared
    await caller.timers.stop({ issueKey: "TMR-1" });
    await caller.worklogs.create({ issueKey: "TMR-1", timeSpent: "1m", started: hoursAgo(5), fromTimer: true });
    expect(await caller.timers.list()).toEqual([]);
  });

  it("delete without a local copy checks the worklog's week on Jira; gone on Jira is ok", async () => {
    (await q("DELETE FROM worklogs"));
    const lockedDay = new Date(2026, 0, 14, 10);
    await caller.weeks.close({ week: "2026-01-14" });
    const { toJiraStarted } = await import("@contracts/time");
    remoteWorklogs.set("wl-old", { id: "wl-old", started: toJiraStarted(lockedDay), timeSpentSeconds: 60 });
    await expect(caller.worklogs.delete({ issueKey: "DEL-1", remoteId: "wl-old" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    const fetchMock = fetch as unknown as { mock: { calls: [string, RequestInit | undefined][] } };
    const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").length;
    const before = deletes();
    expect(await caller.worklogs.delete({ issueKey: "DEL-1", remoteId: "wl-missing" })).toMatchObject({ ok: true });
    // Older apps still name it jiraWorklogId (T9: for one more release).
    expect(await caller.worklogs.delete({ issueKey: "DEL-1", jiraWorklogId: "wl-missing" })).toMatchObject({ ok: true });
    expect(deletes()).toBe(before);
    remoteWorklogs.set("wl-open", { id: "wl-open", started: toJiraStarted(new Date()), timeSpentSeconds: 60 });
    expect(await caller.worklogs.delete({ issueKey: "DEL-1", remoteId: "wl-open" })).toMatchObject({ ok: true });
    expect(deletes()).toBe(before + 1);
  });

  it("a delete the tracker refuses says so with its words and code, not as a server fault", async () => {
    const { toJiraStarted } = await import("@contracts/time");
    remoteWorklogs.set("wl-refused", { id: "wl-refused", started: toJiraStarted(new Date()), timeSpentSeconds: 60 });
    const e = await caller.worklogs.delete({ issueKey: "DEL-1", remoteId: "wl-refused" }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "BAD_REQUEST" });
    expect((e as Error).message).toMatch(/Jira refuses this delete/);
  });

  describe("overlapping worklogs", () => {
    const day = (h: number, m = 0) => new Date(2026, 8, 7, h, m); // Mon 7 Sep 2026
    const log = (issueKey: string, start: Date, timeSpent: string) =>
      caller.worklogs.create({ issueKey, timeSpent, started: start.toISOString() });
    // The "block" policy refuses them; the default lets parallel work be logged.
    beforeEach(() => caller.settings.update({ overlapPolicy: "block" }));
    afterEach(() => caller.settings.update({ overlapPolicy: "warn" }));

    it("by default, time logged in parallel is accepted (the app warns)", async () => {
      (await q("DELETE FROM worklogs"));
      await caller.settings.update({ overlapPolicy: "warn" });
      await log("OVL-1", day(9), "1h");
      await expect(log("OVL-2", day(9, 30), "1h")).resolves.toMatchObject({ issueKey: "OVL-2" });
    });

    it("refuses a create over another worklog, accepts the adjacent one", async () => {
      (await q("DELETE FROM worklogs"));
      await log("OVL-1", day(9), "1h");
      await expect(log("OVL-2", day(9, 30), "1h")).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("OVL-1 09:00–10:00"),
      });
      await expect(log("OVL-2", day(8, 30), "4h")).rejects.toMatchObject({ code: "CONFLICT" });
      await log("OVL-2", day(10), "30m"); // starts where the other ends
      await log("OVL-3", day(8, 30), "30m"); // ends where it starts
      expect((await caller.worklogs.list({ from: day(0).toISOString() })).length).toBe(3);
    });

    it("refuses an edit that runs into the next one, not a comment-only edit", async () => {
      const [first] = (await caller.worklogs.list({ issueKey: "OVL-1" }));
      const edit = { issueKey: "OVL-1", remoteId: first.remoteId, comment: "" };
      await expect(
        caller.worklogs.update({ ...edit, timeSpent: "1h 20m", started: day(9).toISOString() }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // moving within its own slot is fine (itself is not a conflict)
      await caller.worklogs.update({ ...edit, timeSpent: "50m", started: day(9, 10).toISOString() });
      // data from Jira may already overlap: a comment stays editable
      await insertLog("OVL-9", day(9, 15), 1800, "jira-overlap");
      await caller.worklogs.update({
        issueKey: "OVL-9",
        remoteId: "jira-overlap",
        timeSpent: "30m",
        started: day(9, 15).toISOString(),
        comment: "nota",
      });
    });

    it("two parallel creates on the same slot: only one passes", async () => {
      (await q("DELETE FROM worklogs"));
      const results = await Promise.allSettled([log("PAR-1", day(14), "1h"), log("PAR-2", day(14), "1h")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("timers: end at the stop, logged once", () => {
    it("stop returns when it stopped; stopping again keeps the first stop", async () => {
      (await q("DELETE FROM timers"));
      await caller.timers.start({ issueKey: "STP-1" });
      const first = await caller.timers.stop({ issueKey: "STP-1" });
      expect(first.stoppedAt).toBeInstanceOf(Date);
      (await q("UPDATE timers SET paused_at = ? WHERE issue_key = 'STP-1'", Date.now() - 5 * 3600_000));
      const again = await caller.timers.stop({ issueKey: "STP-1" });
      expect(Date.now() - again.stoppedAt!.getTime()).toBeGreaterThan(4 * 3600_000);
      const [t] = await caller.timers.list();
      expect(t.pausedAt?.getTime()).toBe(again.stoppedAt!.getTime());
    });

    it("a timer already logged elsewhere is refused, not logged twice", async () => {
      (await q("DELETE FROM worklogs"));
      const started = new Date(Date.now() - 6 * 3600_000).toISOString();
      await caller.worklogs.create({ issueKey: "STP-1", timeSpent: "1m", started, fromTimer: true });
      expect(await caller.timers.list()).toEqual([]);
      await expect(
        caller.worklogs.create({
          issueKey: "STP-1",
          timeSpent: "1m",
          started: new Date(Date.now() - 3 * 3600_000).toISOString(),
          fromTimer: true,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already been logged") });
    });
  });

  it("week lock follows the local week: Monday 00:30 is the new week", async () => {
    (await q("DELETE FROM worklogs"));
    await caller.weeks.close({ week: "2026-10-05" }); // Mon 5 – Sun 11 Oct
    try {
      // 00:30 Rome on Monday 12 is still Sunday 22:30 UTC: must count as the new week
      await caller.worklogs.create({
        issueKey: "WK-1",
        timeSpent: "20m",
        started: new Date(2026, 9, 12, 0, 30).toISOString(),
      });
      await expect(
        caller.worklogs.create({
          issueKey: "WK-1",
          timeSpent: "20m",
          started: new Date(2026, 9, 11, 23, 30).toISOString(),
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      await caller.weeks.reopen({ week: "2026-10-05" });
    }
  });
});
