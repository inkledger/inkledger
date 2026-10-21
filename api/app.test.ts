import { jiraSignIn } from "./testing/signIn";
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";

// Must be set BEFORE importing env/db modules.
process.env.DATABASE_URL = ":memory:";

// Jira hosts resolve to a public address (no real DNS in tests).
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import type { appRouter } from "./router";
import type { TrpcContext } from "./context";
import type { User } from "@db/schema";

type Router = typeof appRouter;

const JIRA_ISSUES = [
  {
    id: "1",
    key: "PRJ-1",
    fields: {
      summary: "Implementare login",
      status: { name: "In Progress", statusCategory: { name: "In Progress" } },
      project: { key: "PRJ", name: "Progetto Demo" },
      issuetype: { name: "Story" },
      priority: { name: "High" },
      labels: ["backend", "urgent"],
      assignee: { accountId: "acc-123", displayName: "Mario Rossi" },
      timeestimate: 28800,
      timespent: 3600,
      duedate: null,
      updated: "2026-07-19T10:00:00.000+0000",
    },
  },
  {
    id: "2",
    key: "OPS-7",
    fields: {
      summary: "Fix pipeline CI",
      status: { name: "To Do", statusCategory: { name: "To Do" } },
      project: { key: "OPS", name: "Operations" },
      issuetype: { name: "Bug" },
      priority: { name: "Medium" },
      timeestimate: null,
      timespent: null,
      duedate: null,
      updated: "2026-07-18T09:00:00.000+0000",
    },
  },
];

const EXT_9 = {
  id: "99",
  key: "EXT-9",
  fields: {
    summary: "A colleague's issue",
    status: { name: "To Do", statusCategory: { name: "To Do" } },
    project: { key: "EXT", name: "External" },
    issuetype: { name: "Task" },
    priority: { name: "Low" },
    labels: ["imported"],
    assignee: { accountId: "someone-else", displayName: "Luigi Verdi" },
    timeestimate: null,
    timespent: null,
    duedate: null,
    updated: "2026-07-20T08:00:00.000+0000",
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockJiraFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/rest/api/3/myself")) {
      return jsonResponse({
        accountId: "acc-123",
        displayName: "Mario Rossi",
        emailAddress: "mario@example.com",
        avatarUrls: { "48x48": "https://example.com/avatar.png" },
      });
    }
    if (url.endsWith("/rest/api/2/myself")) {
      // Jira Server/DC 8.x: no accountId, identified by username
      return jsonResponse({
        name: "mario.rossi",
        key: "mario.rossi",
        displayName: "Mario Rossi",
        emailAddress: "mario@example.com",
      });
    }
    if (url.includes("/rest/api/2/search")) {
      return jsonResponse({ issues: JIRA_ISSUES, total: JIRA_ISSUES.length });
    }
    // single issue (import / refresh after a transition)
    const single = /\/rest\/api\/3\/issue\/([A-Z0-9_]+-\d+)\?fields=summary/.exec(url);
    if (single && method === "GET") {
      if (single[1] === "EXT-9") return jsonResponse(EXT_9);
      if (single[1] === "PRJ-1") {
        const done = JSON.parse(JSON.stringify(JIRA_ISSUES[0]));
        done.fields.status = { name: "Done", statusCategory: { name: "Done" } };
        return jsonResponse(done);
      }
      return jsonResponse({ errorMessages: ["Issue does not exist"] }, 404);
    }
    if (url.includes("/rest/api/3/search/jql")) {
      const jql = new URL(url).searchParams.get("jql") ?? "";
      if (/key = EXT-9/i.test(jql)) {
        return jsonResponse({ issues: [EXT_9], isLast: true });
      }
      return jsonResponse({ issues: JIRA_ISSUES, isLast: true });
    }
    if (url.includes("/transitions") && method === "GET") {
      return jsonResponse({
        transitions: [{ id: "31", name: "Done", to: { name: "Done" } }],
      });
    }
    if (url.includes("/transitions") && method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/worklog") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        id: "wl-1",
        timeSpentSeconds: body.timeSpentSeconds,
        started: body.started,
        comment: body.comment,
        author: { accountId: "acc-123" },
        created: "2026-07-20T10:00:00.000+0000",
        updated: "2026-07-20T10:00:00.000+0000",
      });
    }
    if (url.includes("/worklog") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/worklog") && method === "GET") {
      return jsonResponse({ worklogs: [] });
    }
    return jsonResponse({ errorMessages: [`unmocked: ${method} ${url}`] }, 500);
  });
}

/** Whole local catalog (the default view hides done / unassigned issues). */
const ALL = { includeDone: true, includeUnassigned: true, sort: "updated" } as const;

describe("app router (integration, in-memory SQLite)", () => {
  let router: Router;
  let db: ReturnType<typeof import("./queries/connection").getDb>;
  let authedCtx: TrpcContext;
  let user: User;

  const anonCtx = (): TrpcContext => ({
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: null,
    sessionId: null,
  });

  beforeAll(async () => {
    vi.stubGlobal("fetch", mockJiraFetch());
    ({ appRouter: router } = await import("./router"));
    const conn = await import("./queries/connection");
    await conn.resetDbForTests();
    db = conn.getDb();
    const { sessions } = await import("@db/schema");

    // Login
    const res = await jiraSignIn(anonCtx(), {
        siteUrl: "https://example.atlassian.net",
        deployment: "cloud",
        authType: "basic",
        username: "mario@example.com",
        secret: "secret-token",
      });
    expect(res.displayName).toBe("Mario Rossi");

    const allSessions = await db.select().from(sessions);
    expect(allSessions).toHaveLength(1);

    const { users } = await import("@db/schema");
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
    user = allUsers[0];
    // The secret is sealed on the connection, never on the user.
    const { connections } = await import("@db/schema");
    const [jira] = await db.select().from(connections);
    expect(jira.encryptedSecret.startsWith("v1.")).toBe(true);
    expect(jira.encryptedSecret).not.toContain("secret-token");

    authedCtx = {
      req: new Request("http://localhost/api/trpc"),
      resHeaders: new Headers(),
      user,
      sessionId: allSessions[0].id,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects anonymous access to protected procedures", async () => {
    await expect(router.createCaller(anonCtx()).issues.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects invalid Jira credentials", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      jsonResponse({ errorMessages: ["Unauthorized"] }, 401),
    );
    await expect(
      jiraSignIn(anonCtx(), {
        siteUrl: "https://example.atlassian.net",
        deployment: "cloud",
        authType: "basic",
        username: "mario@example.com",
        secret: "wrong",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("syncs assigned issues from Jira and lists them with facets", async () => {
    const caller = router.createCaller(authedCtx);
    const sync = await caller.issues.sync();
    expect(sync.synced).toBe(2);

    const list = await caller.issues.list(ALL);
    expect(list.issues.map((i) => i.key)).toEqual(["PRJ-1", "OPS-7"]);
    expect(list.statuses).toEqual(["In Progress", "To Do"]);
    expect(list.projects.map((p) => p.key)).toEqual(["OPS", "PRJ"]);

    const filtered = await caller.issues.list({ ...ALL, search: "pipeline" });
    expect(filtered.issues.map((i) => i.key)).toEqual(["OPS-7"]);

    const byStatus = await caller.issues.list({ ...ALL, status: "In Progress" });
    expect(byStatus.issues.map((i) => i.key)).toEqual(["PRJ-1"]);

    // Re-sync updates instead of duplicating
    await caller.issues.sync();
    expect((await caller.issues.list(ALL)).issues).toHaveLength(2);
  });

  it("creates a worklog on Jira and stores it locally", async () => {
    const caller = router.createCaller(authedCtx);
    const created = await caller.worklogs.create({
      issueKey: "PRJ-1",
      timeSpent: "2h 30m",
      started: new Date().toISOString(),
      comment: "Sviluppo feature",
    });
    expect(created.timeSpentSeconds).toBe(9000);
    expect(created.remoteId).toBe("wl-1");
    expect(created.comment).toBe("Sviluppo feature");

    const logs = await caller.worklogs.list({ issueKey: "PRJ-1" });
    expect(logs).toHaveLength(1);
  });

  it("rejects invalid durations", async () => {
    const caller = router.createCaller(authedCtx);
    await expect(
      caller.worklogs.create({
        issueKey: "PRJ-1",
        timeSpent: "a bit",
        started: new Date().toISOString(),
        comment: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores labels and assignee on sync; filters by label", async () => {
    const caller = router.createCaller(authedCtx);
    const list = await caller.issues.list(ALL);
    const prj1 = list.issues.find((i) => i.key === "PRJ-1");
    expect(prj1?.labels).toEqual(["backend", "urgent"]);
    expect(prj1?.isMine).toBe(true);
    expect(list.labels).toEqual(["backend", "urgent"]);

    const filtered = await caller.issues.list({ ...ALL, label: "urgent" });
    expect(filtered.issues.map((i) => i.key)).toEqual(["PRJ-1"]);
  });

  it("imports an arbitrary issue by key (not assigned to me)", async () => {
    const caller = router.createCaller(authedCtx);
    const res = await caller.issues.import({ key: "EXT-9" });
    expect(res.imported).toBe("EXT-9");
    const list = await caller.issues.list(ALL);
    const ext = list.issues.find((i) => i.key === "EXT-9");
    expect(ext?.isMine).toBe(false);
    expect(ext?.labels).toEqual(["imported"]);
  });

  it("paginates the local catalog server-side", async () => {
    const caller = router.createCaller(authedCtx);
    // catalog: PRJ-1, OPS-7, EXT-9 (updated desc: EXT-9, PRJ-1, OPS-7)
    const p1 = await caller.issues.list({ ...ALL, pageSize: 2, page: 1 });
    expect(p1.total).toBe(3);
    expect(p1.totalPages).toBe(2);
    expect(p1.issues.map((i) => i.key)).toEqual(["EXT-9", "PRJ-1"]);

    const p2 = await caller.issues.list({ ...ALL, pageSize: 2, page: 2 });
    expect(p2.issues.map((i) => i.key)).toEqual(["OPS-7"]);

    // defaults: everything in one page
    const all = await caller.issues.list(ALL);
    expect(all.issues).toHaveLength(3);
    expect(all.page).toBe(1);
  });

  it("global search flags imported and ownership", async () => {
    const caller = router.createCaller(authedCtx);
    const { results, failed } = await caller.issues.search({ query: "EXT-9" });
    expect(failed).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].imported).toBe(true);
    expect(results[0].isMine).toBe(false);
  });

  it("favorites: toggle, ordering, filter and sync preservation", async () => {
    const caller = router.createCaller(authedCtx);

    // star OPS-7
    const toggled = await caller.issues.toggleFavorite({ key: "OPS-7" });
    expect(toggled.favorite).toBe(true);

    // favorites come first in the list
    const list = await caller.issues.list(ALL);
    expect(list.issues[0].key).toBe("OPS-7");
    expect(list.issues[0].favorite).toBe(1);

    // favoriteOnly filter
    const only = await caller.issues.list({ ...ALL, favoriteOnly: true });
    expect(only.issues.map((i) => i.key)).toEqual(["OPS-7"]);

    // re-sync must preserve the local favorite flag
    await caller.issues.sync();
    const after = await caller.issues.list({ ...ALL, favoriteOnly: true });
    expect(after.issues.map((i) => i.key)).toEqual(["OPS-7"]);

    // toggle off
    const off = await caller.issues.toggleFavorite({ key: "OPS-7" });
    expect(off.favorite).toBe(false);
    await caller.issues.toggleFavorite({ key: "OPS-7" }); // back on for cleanup test
  });

  it("cleanup deletes only issues without tracked worklogs", async () => {
    const caller = router.createCaller(authedCtx);
    // PRJ-1 has a worklog; OPS-7 is a favorite (kept); EXT-9 has neither → deleted
    const res = await caller.issues.cleanup();
    expect(res.deleted).toBe(1);
    expect(res.kept).toBe(2);
    const list = await caller.issues.list(ALL);
    expect(list.issues.map((i) => i.key)).toEqual(["OPS-7", "PRJ-1"]);
  });

  it("transitions an issue to a new status and refreshes it locally", async () => {
    const caller = router.createCaller(authedCtx);
    const res = await caller.issues.transition({ key: "PRJ-1", toStatus: "Done" });
    expect(res.to).toBe("Done");
    const issue = await caller.issues.get({ key: "PRJ-1" });
    expect(issue.status).toBe("Done");
  });

  it("computes dashboard stats from local worklogs", async () => {
    const caller = router.createCaller(authedCtx);
    const stats = await caller.stats.dashboard();
    expect(stats.weekSeconds).toBe(9000);
    expect(stats.monthSeconds).toBe(9000);
    // after cleanup: PRJ-1 (Done) and OPS-7 (favorite, To Do) remain
    expect(stats.issueCount).toBe(2);
    expect(stats.openIssueCount).toBe(1);
    expect(stats.perDay).toHaveLength(14);
    expect(stats.perDay.reduce((a, d) => a + d.seconds, 0)).toBe(9000);
    expect(stats.perProject[0].projectKey).toBe("PRJ");
  });

  it("settings: returns defaults and persists updates", async () => {
    const caller = router.createCaller(authedCtx);
    const defaults = await caller.settings.get();
    expect(defaults.dailyTargetSeconds).toBe(8 * 3600);
    expect(defaults.weeklyTargetSeconds).toBe(40 * 3600);
    expect(defaults.timerAlertMinutes).toBe(120);

    const updated = await caller.settings.update({
      dailyTargetSeconds: 6 * 3600,
      timerAlertMinutes: 90,
      notifyEnabled: 0,
    });
    expect(updated.dailyTargetSeconds).toBe(6 * 3600);
    expect(updated.timerAlertMinutes).toBe(90);
    expect(updated.notifyEnabled).toBe(0);

    const again = await caller.settings.get();
    expect(again.dailyTargetSeconds).toBe(6 * 3600);
  });

  it("settings: persists a custom dashboard layout", async () => {
    const caller = router.createCaller(authedCtx);
    // default layout: all known widgets, all visible
    const defaults = await caller.settings.get();
    expect(defaults.dashboard.length).toBe(7);
    expect(defaults.dashboard.every((w) => w.visible)).toBe(true);

    const custom = [
      { id: "activity", visible: true },
      { id: "stats", visible: false },
      { id: "tasks", visible: true },
      { id: "unknown-widget", visible: true },
    ];
    const updated = await caller.settings.update({ dashboardLayout: custom });
    // unknown ids dropped, missing widgets appended at the end, order kept
    expect(updated.dashboard.map((w) => w.id)).toEqual([
      "activity",
      "stats",
      "tasks",
      "inbox",
      "timeline",
      "summary",
      "recap",
    ]);
    expect(updated.dashboard.find((w) => w.id === "stats")?.visible).toBe(false);

    // board columns kept collapsed are stored per user, deduplicated
    const col = await caller.settings.update({ collapsedColumns: ["Backlog", "Backlog", "Fatto"] });
    expect(col.collapsedColumns).toEqual(["Backlog", "Fatto"]);

    // an unrelated update must not touch the saved layout
    await caller.settings.update({ timerAlertMinutes: 60 });
    const again = await caller.settings.get();
    expect(again.dashboard.map((w) => w.id).slice(0, 3)).toEqual([
      "activity",
      "stats",
      "tasks",
    ]);
    // layouts from older widget sets (no "tasks") fall back to the defaults
    const legacy = await caller.settings.update({
      dashboardLayout: [{ id: "favorites", visible: true }],
    });
    expect(legacy.dashboard[0].id).toBe("inbox");
    // restore defaults for other tests
    await caller.settings.update({ timerAlertMinutes: 120 });
  });

  it("stores the base theme colour (validated, normalized)", async () => {
    const caller = router.createCaller(authedCtx);
    expect((await caller.settings.get()).themeColor).toBe("#B5562F");
    const saved = await caller.settings.update({ themeColor: "#1f6f6b" });
    expect(saved.themeColor).toBe("#1F6F6B");
    await expect(caller.settings.update({ themeColor: "teal" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller.settings.update({ themeColor: "#B5562F" });
  });

  it("reports: groups worklogs by day, issue and project", async () => {
    const caller = router.createCaller(authedCtx);
    // add a second worklog on OPS-7 (PRJ-1 already has 9000s today, ending
    // now): early today, where it overlaps nothing
    await caller.worklogs.create({
      issueKey: "OPS-7",
      timeSpent: "1h 30m",
      started: new Date(new Date().setHours(0, 1, 0, 0)).toISOString(),
      comment: "CI fix",
    });
    const { dayKey } = await import("@contracts/time");
    const today = dayKey(new Date());

    const byDay = await caller.reports.generate({
      from: today,
      to: today,
      groupBy: "day",
    });
    expect(byDay.rows).toHaveLength(1);
    expect(byDay.totalSeconds).toBe(9000 + 5400);
    expect(byDay.totalEntries).toBe(2);

    const byIssue = await caller.reports.generate({
      from: today,
      to: today,
      groupBy: "issue",
    });
    expect(byIssue.rows).toHaveLength(2);
    expect(byIssue.rows[0].key).toBe("PRJ-1"); // most seconds first
    expect(byIssue.rows[0].label).toContain("Implementare login");

    const byProject = await caller.reports.generate({
      from: today,
      to: today,
      groupBy: "project",
    });
    expect(byProject.rows.map((r) => r.key).sort()).toEqual(["OPS", "PRJ"]);

    // day by day, issues merged per day, plus range totals by issue
    // (the Jira mock reuses one worklog id, so the second entry goes in directly)
    const { worklogs } = await import("@db/schema");
    const { and, eq } = await import("drizzle-orm");
    await db.insert(worklogs).values({
      userId: authedCtx.user!.id,
      issueKey: "OPS-7",
      remoteId: "wl-daily",
      timeSpentSeconds: 1800,
      started: new Date(new Date().setHours(0, 5, 0, 0) + 90 * 60_000),
    });
    const daily = await caller.reports.daily({ from: today, to: today });
    expect(daily.days).toHaveLength(1);
    expect(daily.days[0].day).toBe(today);
    const ops = daily.days[0].issues.find((r) => r.key === "OPS-7");
    expect(ops).toMatchObject({ seconds: 5400 + 1800, entries: 2 });
    expect(daily.days[0].seconds).toBe(9000 + 5400 + 1800);
    expect(daily.issues.map((r) => r.key)).toEqual(["PRJ-1", "OPS-7"]);
    expect(daily.issues[0].label).toContain("Implementare login");
    expect(daily.totalSeconds).toBe(daily.days[0].seconds);
    expect((await caller.reports.daily({ from: "2020-01-01", to: "2020-01-02" })).days).toHaveLength(0);
    await expect(caller.reports.daily({ from: "2024-01-01", to: "2025-01-01" })).rejects.toThrow(/too long/);
    await db.delete(worklogs).where(and(eq(worklogs.issueKey, "OPS-7"), eq(worklogs.remoteId, "wl-daily")));

    // empty range
    const empty = await caller.reports.generate({
      from: "2020-01-01",
      to: "2020-01-01",
      groupBy: "day",
    });
    expect(empty.rows).toHaveLength(0);

    // a leap year fits, longer spans are refused
    await expect(
      caller.reports.generate({ from: "2024-01-01", to: "2024-12-31", groupBy: "day" }),
    ).resolves.toBeTruthy();
    await expect(
      caller.reports.generate({ from: "2024-01-01", to: "2025-01-01", groupBy: "day" }),
    ).rejects.toThrow(/too long/);
  });

  it("deletes a worklog from Jira and locally", async () => {
    const caller = router.createCaller(authedCtx);
    await caller.worklogs.delete({ issueKey: "PRJ-1", remoteId: "wl-1" });
    expect(await caller.worklogs.list({ issueKey: "PRJ-1" })).toHaveLength(0);
  });

  it("supports login against Jira Server/DC 8.x (username + password)", async () => {
    const res = await jiraSignIn(anonCtx(), {
      siteUrl: "https://jira.example.it",
      deployment: "server",
      authType: "basic",
      username: "mario.rossi",
      secret: "password123",
    });
    expect(res.displayName).toBe("Mario Rossi");
    // identified by username (name), not accountId: the connection's own id there
    const { q } = await import("./queries/connection");
    expect(await q("SELECT remote_account_id FROM connections WHERE base_url = 'https://jira.example.it'")).toEqual([{ remote_account_id: "mario.rossi" }]);
    expect(res.id).toBeGreaterThan(0);
  });

  describe("timers (fine tracking)", () => {
    it("starts a timer and tracks elapsed time", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00Z"));
        const caller = router.createCaller(authedCtx);
        await caller.timers.start({ issueKey: "PRJ-1" });

        vi.setSystemTime(new Date("2026-07-20T10:01:30Z")); // +90s
        const list = await caller.timers.list();
        const t = list.find((x) => x.issueKey === "PRJ-1");
        expect(t?.state).toBe("running");
        expect(t?.elapsedSeconds).toBe(90);
      } finally {
        vi.useRealTimers();
      }
    });

    it("pause accumulates elapsed time; resume continues from it", async () => {
      vi.useFakeTimers();
      try {
        const caller = router.createCaller(authedCtx);
        vi.setSystemTime(new Date("2026-07-20T11:00:00Z"));
        await caller.timers.discard({ issueKey: "PRJ-1" });
        await caller.timers.start({ issueKey: "PRJ-1" });
        vi.setSystemTime(new Date("2026-07-20T11:01:30Z")); // +90s
        await caller.timers.pause({ issueKey: "PRJ-1" });

        vi.setSystemTime(new Date("2026-07-20T11:05:00Z")); // +5m while paused
        let list = await caller.timers.list();
        let t = list.find((x) => x.issueKey === "PRJ-1");
        expect(t?.state).toBe("paused");
        expect(t?.elapsedSeconds).toBe(90); // unchanged while paused

        await caller.timers.start({ issueKey: "PRJ-1" }); // resume
        vi.setSystemTime(new Date("2026-07-20T11:05:30Z")); // +30s
        list = await caller.timers.list();
        t = list.find((x) => x.issueKey === "PRJ-1");
        expect(t?.state).toBe("running");
        expect(t?.elapsedSeconds).toBe(120);
      } finally {
        vi.useRealTimers();
      }
    });

    it("starting another issue auto-pauses the running timer", async () => {
      vi.useFakeTimers();
      try {
        const caller = router.createCaller(authedCtx);
        vi.setSystemTime(new Date("2026-07-20T12:00:00Z"));
        const res = await caller.timers.start({ issueKey: "OPS-7" });
        // the previous timer is handed back so the client asks to log it
        expect(res.switchedFrom?.issueKey).toBe("PRJ-1");
        expect(res.switchedFrom?.seconds).toBeGreaterThanOrEqual(60);
        const list = await caller.timers.list();
        expect(list.find((x) => x.issueKey === "PRJ-1")?.state).toBe("paused");
        expect(list.find((x) => x.issueKey === "OPS-7")?.state).toBe("running");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop pauses the timer and returns time rounded to the nearest minute", async () => {
      vi.useFakeTimers();
      try {
        const caller = router.createCaller(authedCtx);
        vi.setSystemTime(new Date("2026-07-20T12:01:25Z")); // OPS-7 running 85s
        const res = await caller.timers.stop({ issueKey: "OPS-7" });
        expect(res.found).toBe(true);
        expect(res.seconds).toBe(60); // 85s → 1m (nearest), never below 1m
        // Not logged yet: the timer survives, paused, so no time is lost.
        const list = await caller.timers.list();
        expect(list.find((x) => x.issueKey === "OPS-7")?.state).toBe("paused");
      } finally {
        vi.useRealTimers();
      }
    });

    it("logging with fromTimer clears the stopped timer", async () => {
      const caller = router.createCaller(authedCtx);
      await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "1m",
        started: "2026-07-20T12:00:00.000Z",
        fromTimer: true,
      });
      const list = await caller.timers.list();
      expect(list.find((x) => x.issueKey === "OPS-7")).toBeUndefined();
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-1" });
    });

    it("logging with fromTimer keeps a timer restarted meanwhile", async () => {
      const caller = router.createCaller(authedCtx);
      await caller.timers.start({ issueKey: "OPS-7" });
      await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "1m",
        started: "2026-07-20T12:00:00.000Z",
        fromTimer: true,
      });
      const list = await caller.timers.list();
      expect(list.find((x) => x.issueKey === "OPS-7")?.state).toBe("running");
      await caller.timers.discard({ issueKey: "OPS-7" });
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-1" });
    });

    it("discard removes a timer without logging", async () => {
      const caller = router.createCaller(authedCtx);
      await caller.timers.discard({ issueKey: "PRJ-1" });
      const list = await caller.timers.list();
      expect(list).toHaveLength(0);
    });
  });

  describe("outbox (offline queue)", () => {
    const offline = async () => {
      throw new TypeError("fetch failed");
    };

    it("queues create when Jira is unreachable and replays it later", async () => {
      const caller = router.createCaller(authedCtx);
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "1h 30m",
        started: new Date("2026-07-20T09:00:00Z").toISOString(),
        comment: "offline work",
      });
      expect(row.remoteId.startsWith("pending-")).toBe(true);
      expect(row.timeSpentSeconds).toBe(5400);

      let pending = await caller.outbox.list();
      expect(pending).toHaveLength(1);
      expect(pending[0].kind).toBe("create");
      expect(pending[0].issueKey).toBe("OPS-7");

      // visible in the local worklog list while pending
      const local = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(local.some((w) => w.remoteId === row.remoteId)).toBe(true);

      // Jira back: manual replay flushes the queue
      const res = await caller.outbox.retry();
      expect(res.synced).toBe(1);
      expect(res.remaining).toBe(0);
      pending = await caller.outbox.list();
      expect(pending).toHaveLength(0);

      // the local row now carries the real Jira id
      const after = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(after.some((w) => w.remoteId.startsWith("pending-"))).toBe(false);
      expect(
        after.some((w) => w.remoteId === "wl-1" && w.comment === "offline work"),
      ).toBe(true);
    });

    it("updates and deletes a pending worklog without touching Jira", async () => {
      const caller = router.createCaller(authedCtx);
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "30m",
        started: new Date("2026-07-20T14:00:00Z").toISOString(),
        comment: "bozza",
      });
      const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

      const updated = await caller.worklogs.update({
        issueKey: "OPS-7",
        remoteId: row.remoteId,
        timeSpent: "45m",
        started: new Date("2026-07-20T14:30:00Z").toISOString(),
        comment: "bozza corretta",
      });
      expect(updated.timeSpentSeconds).toBe(2700);
      // no Jira call happened for the pending update
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
      const ops = await caller.outbox.list();
      expect(ops).toHaveLength(1);
      expect(ops[0].timeSpentSeconds).toBe(2700);
      expect(ops[0].comment).toBe("bozza corretta");

      await caller.worklogs.delete({
        issueKey: "OPS-7",
        remoteId: row.remoteId,
      });
      expect(await caller.outbox.list()).toHaveLength(0);
      const local = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(local.some((w) => w.remoteId === row.remoteId)).toBe(false);
    });

    it("queues delete when offline and tolerates 404 on replay", async () => {
      const caller = router.createCaller(authedCtx);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "20m",
        started: new Date("2026-07-20T16:00:00Z").toISOString(),
        comment: "da eliminare",
      });
      expect(row.remoteId).toBe("wl-1");

      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-1" });
      const ops = await caller.outbox.list();
      expect(ops).toHaveLength(1);
      expect(ops[0].kind).toBe("delete");
      const local = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(local.some((w) => w.remoteId === "wl-1")).toBe(false);

      // Jira still has it until the delete is replayed: a sync must not resurrect it
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
        jsonResponse({
          worklogs: [
            { id: "wl-1", timeSpentSeconds: 1200, started: "2026-07-20T16:00:00.000+0000", author: { accountId: "acc-123" } },
          ],
          total: 1,
        }),
      );
      await caller.worklogs.syncIssue({ issueKey: "OPS-7" });
      const synced = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(synced.some((w) => w.remoteId === "wl-1")).toBe(false);

      // Replay: Jira answers 404 (already deleted there) → entry cleared
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
        jsonResponse({ errorMessages: ["not found"] }, 404),
      );
      const res = await caller.outbox.retry();
      expect(res.remaining).toBe(0);
      expect(await caller.outbox.list()).toHaveLength(0);
    });

    it("adopts a worklog that reached Jira despite a timeout instead of re-posting", async () => {
      const caller = router.createCaller(authedCtx);
      const started = "2026-07-21T09:00:00.000Z";
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      });
      await caller.worklogs.create({ issueKey: "OPS-7", timeSpent: "1h", started });
      expect(await caller.outbox.list()).toHaveLength(1);

      // Jira already stored it: the GET used for dedupe returns it.
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
        jsonResponse({
          worklogs: [
            { id: "wl-remote", timeSpentSeconds: 3600, started, author: { accountId: "acc-123" } },
          ],
          total: 1,
        }),
      );
      const res = await caller.outbox.retry();
      expect(res.synced).toBe(1);
      const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posts).toHaveLength(1); // only the original (timed-out) attempt
      const local = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(local.some((w) => w.remoteId === "wl-remote")).toBe(true);
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-remote" });
    });

    it("never adopts a known worklog; an identical create is refused, not queued", async () => {
      const caller = router.createCaller(authedCtx);
      // An identical worklog is refused under the "block" overlap policy.
      await caller.settings.update({ overlapPolicy: "block" });
      const mocked = fetch as ReturnType<typeof vi.fn>;
      type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
      const original = mocked.getMockImplementation() as FetchImpl;
      const started = "2026-07-22T09:00:00.000Z";
      // A stateful Jira: POST stores, GET lists what is stored.
      const remote: Record<string, unknown>[] = [];
      let down = true;
      mocked.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/issue/OPS-8/worklog")) {
          if (down) throw new TypeError("fetch failed");
          if (method === "POST") {
            const body = JSON.parse(String(init?.body));
            const wl = {
              id: `wl-r${remote.length + 1}`,
              timeSpentSeconds: body.timeSpentSeconds,
              started: body.started,
              author: { accountId: "acc-123" },
              created: new Date().toISOString(),
            };
            remote.push(wl);
            return jsonResponse(wl);
          }
          return jsonResponse({ worklogs: remote, total: remote.length });
        }
        return original(input, init);
      });
      try {
        // Logged on purpose, online: already known locally.
        down = false;
        await caller.worklogs.create({ issueKey: "OPS-8", timeSpent: "1h", started });
        down = true;
        // Same time again would log it twice: refused before anything is queued.
        await expect(
          caller.worklogs.create({ issueKey: "OPS-8", timeSpent: "1h", started }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        // The next hour, offline: queued, and its replay must not adopt wl-r1.
        await caller.worklogs.create({ issueKey: "OPS-8", timeSpent: "1h", started: "2026-07-22T10:00:00.000Z" });
        down = false;
        const res = await caller.outbox.retry();
        expect(res).toMatchObject({ synced: 1, remaining: 0 });
        expect(remote).toHaveLength(2);
        const local = await caller.worklogs.list({ issueKey: "OPS-8" });
        expect(local.map((w) => w.remoteId).sort()).toEqual(["wl-r1", "wl-r2"]);
      } finally {
        mocked.mockImplementation(original);
        const { worklogs } = await import("@db/schema");
        const { eq } = await import("drizzle-orm");
        await db.delete(worklogs).where(eq(worklogs.issueKey, "OPS-8"));
      }
    });

    it("editing a pending worklog after its replay is a conflict, not a silent no-op", async () => {
      const caller = router.createCaller(authedCtx);
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "20m",
        started: "2026-07-23T09:00:00.000Z",
      });
      await caller.outbox.retry();
      const edit = {
        issueKey: "OPS-7",
        remoteId: row.remoteId,
        timeSpent: "25m",
        started: "2026-07-23T09:00:00.000Z",
      };
      await expect(caller.worklogs.update(edit)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        caller.worklogs.delete({ issueKey: "OPS-7", remoteId: row.remoteId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-1" });
    });

    it("runs concurrent replays only once", async () => {
      const caller = router.createCaller(authedCtx);
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "10m",
        started: "2026-07-21T11:00:00.000Z",
      });
      const [a, b] = await Promise.all([caller.outbox.retry(), caller.outbox.retry()]);
      expect(a).toBe(b);
      const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posts).toHaveLength(2); // the offline attempt + a single replay
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-1" });
    });

    it("adopts a timed-out create that a sync already imported", async () => {
      const caller = router.createCaller(authedCtx);
      const mocked = fetch as ReturnType<typeof vi.fn>;
      const started = "2026-07-24T09:00:00.000Z";
      mocked.mockImplementationOnce(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      });
      await caller.worklogs.create({ issueKey: "OPS-7", timeSpent: "1h", started });
      const stored = {
        worklogs: [{ id: "wl-late", timeSpentSeconds: 3600, started, author: { accountId: "acc-123" } }],
        total: 1,
      };
      // Jira did store it, and a sync brings it in before the replay.
      mocked.mockImplementationOnce(async () => jsonResponse(stored));
      await caller.worklogs.syncIssue({ issueKey: "OPS-7" });
      mocked.mockImplementationOnce(async () => jsonResponse(stored));
      const res = await caller.outbox.retry();
      expect(res).toMatchObject({ synced: 1, remaining: 0 });
      const posts = mocked.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posts).toHaveLength(1); // only the timed-out attempt
      const local = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(local.filter((w) => w.started.toISOString() === started)).toHaveLength(1);
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: "wl-late" });
    });

    it("an online edit drops an older queued edit of the same worklog", async () => {
      const caller = router.createCaller(authedCtx);
      const started = "2026-07-24T11:00:00.000Z";
      const row = await caller.worklogs.create({ issueKey: "OPS-7", timeSpent: "20m", started });
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      const edit = { issueKey: "OPS-7", remoteId: row.remoteId, started };
      await caller.worklogs.update({ ...edit, timeSpent: "25m" });
      expect(await caller.outbox.list()).toHaveLength(1);
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
        jsonResponse({ id: row.remoteId, timeSpentSeconds: 1800, started, author: { accountId: "acc-123" } }),
      );
      await caller.worklogs.update({ ...edit, timeSpent: "30m" });
      expect(await caller.outbox.list()).toHaveLength(0);
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: row.remoteId });
    });

    it("being offline does not count toward the attempts limit", async () => {
      const caller = router.createCaller(authedCtx);
      const mocked = fetch as ReturnType<typeof vi.fn>;
      mocked.mockImplementationOnce(offline);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "10m",
        started: "2026-07-24T13:00:00.000Z",
      });
      mocked.mockImplementationOnce(offline);
      await caller.outbox.retry();
      const [entry] = await caller.outbox.list();
      expect(entry.attempts).toBe(0);
      expect(entry.lastError).toMatch(/fetch failed/);
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: row.remoteId });
    });

    it("leaves an entry claimed by another server process alone", async () => {
      const caller = router.createCaller(authedCtx);
      const { outbox } = await import("@db/schema");
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "10m",
        started: "2026-07-24T14:00:00.000Z",
      });
      await db.update(outbox).set({ claimedAt: Date.now() });
      const res = await caller.outbox.retry();
      expect(res).toMatchObject({ synced: 0, remaining: 1 });
      const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(posts).toHaveLength(1); // only the offline attempt
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: row.remoteId });
    });

    it("deleting a worklog already gone on Jira removes the local copy", async () => {
      const caller = router.createCaller(authedCtx);
      const row = await caller.worklogs.create({
        issueKey: "OPS-7",
        timeSpent: "10m",
        started: "2026-07-24T15:00:00.000Z",
      });
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
        jsonResponse({ errorMessages: ["not found"] }, 404),
      );
      await caller.worklogs.delete({ issueKey: "OPS-7", remoteId: row.remoteId });
      const local = await caller.worklogs.list({ issueKey: "OPS-7" });
      expect(local.some((w) => w.remoteId === row.remoteId)).toBe(false);
    });

    it("flushes the queue automatically on issue sync", async () => {
      const caller = router.createCaller(authedCtx);
      (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(offline);
      await caller.worklogs.create({
        issueKey: "PRJ-1",
        timeSpent: "15m",
        started: new Date("2026-07-20T18:00:00Z").toISOString(),
        comment: "auto replay",
      });
      expect(await caller.outbox.list()).toHaveLength(1);

      const res = await caller.issues.sync();
      expect(res.outbox.remaining).toBe(0);
      expect(await caller.outbox.list()).toHaveLength(0);
    });
  });

  describe("closed weeks", () => {
    it("close locks edits, reopen unlocks; moving out of a closed week is blocked", async () => {
      const caller = router.createCaller(authedCtx);
      const inWeek = new Date("2026-06-03T10:00:00Z"); // Wed, week of 2026-06-01
      const wl = await caller.worklogs.create({
        issueKey: "PRJ-1",
        timeSpent: "1h",
        started: inWeek.toISOString(),
        comment: "pre-lock",
      });

      expect(await caller.weeks.status({ week: "2026-06-03" })).toBeNull();
      const closed = await caller.weeks.close({ week: "2026-06-03", note: "inviato" });
      expect(closed.weekStart).toBe("2026-06-01");
      // idempotent
      await caller.weeks.close({ week: "2026-06-05" });
      expect(await caller.weeks.list()).toHaveLength(1);

      const locked = { code: "PRECONDITION_FAILED" };
      await expect(
        caller.worklogs.create({ issueKey: "PRJ-1", timeSpent: "30m", started: inWeek.toISOString() }),
      ).rejects.toMatchObject(locked);
      await expect(
        caller.worklogs.delete({ issueKey: "PRJ-1", remoteId: wl.remoteId }),
      ).rejects.toMatchObject(locked);
      // moving the worklog into an open week still edits the closed one
      await expect(
        caller.worklogs.update({
          issueKey: "PRJ-1",
          remoteId: wl.remoteId,
          timeSpent: "1h",
          started: new Date("2026-05-20T10:00:00Z").toISOString(),
          comment: "spostato",
        }),
      ).rejects.toMatchObject(locked);

      // a different week stays editable
      const other = await caller.worklogs.create({
        issueKey: "PRJ-1",
        timeSpent: "15m",
        started: new Date("2026-05-20T10:00:00Z").toISOString(),
      });
      expect(other.remoteId).toBe("wl-1");

      await caller.weeks.reopen({ week: "2026-06-01" });
      expect(await caller.weeks.status({ week: "2026-06-03" })).toBeNull();
      await caller.worklogs.delete({ issueKey: "PRJ-1", remoteId: wl.remoteId });

      await expect(caller.weeks.close({ week: "2026-06-03T10:00:00Z" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  it("logs out and invalidates the session row", async () => {
    const caller = router.createCaller(authedCtx);
    await caller.auth.logout();
    const { sessions } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, authedCtx.sessionId!));
    expect(remaining).toHaveLength(0);
  });
});
