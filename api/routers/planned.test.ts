import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dayKey } from "@contracts/time";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let remoteMode: "online" | "offline" | "refuse" = "online";
let remotePosts = 0;
let remoteId = 0;

vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  if (url.includes("/issue/") && url.endsWith("/worklog") && method === "POST") {
    if (remoteMode === "offline") throw new TypeError("fetch failed");
    if (remoteMode === "refuse") return json({ errorMessages: ["Provider refused"] }, 400);
    remotePosts += 1;
    const body = JSON.parse(String(init?.body)) as { started: string; timeSpentSeconds: number };
    return json({ id: `remote-${++remoteId}`, ...body, author: { accountId: "main" } });
  }
  return json({ errorMessages: [`unexpected ${method} ${url}`] }, 500);
}));

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
type PlannedCreate = Parameters<Caller["planned"]["create"]>[0];

describe("planned entries", () => {
  let caller: Caller;
  let other: Caller;
  let userId = 0;
  let otherId = 0;
  let jiraId = 0;
  let gitlabId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [main] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('planned-main', 'Main', 'admin', 1) RETURNING id");
    const [bob] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('planned-other', 'Other', 'member', 1) RETURNING id");
    userId = main.id;
    otherId = bob.id;
    const addConnection = async (type: "jira" | "gitlab", baseUrl: string, account: string) => {
      const [conn] = await q<{ id: number }>(
        "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, writes_allowed, created_at) VALUES (?, ?, ?, ?, ?, 'x', 1, 1) RETURNING id",
        userId,
        type,
        baseUrl,
        account,
        type === "jira" ? JSON.stringify({ deployment: "cloud", authType: "basic", username: "main@example.com" }) : "{}", 
      );
      await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("token", conn.id), conn.id);
      return conn.id;
    };
    jiraId = await addConnection("jira", "https://planned.atlassian.net", "main");
    gitlabId = await addConnection("gitlab", "https://gitlab.com", "main");
    const addIssue = (connectionId: number, remoteIdValue: string, key: string) =>
      q(
        "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, ?, 'To Do', 'APP', 'App', 'https://example', 1)",
        userId,
        connectionId,
        remoteIdValue,
        key,
        key,
      );
    await addIssue(jiraId, "100", "APP-1");
    await addIssue(jiraId, "101", "APP-2");
    await addIssue(jiraId, "102", "TRV-1");
    await addIssue(gitlabId, "200", "acme/web#1");

    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const makeCaller = async (id: number) => {
      const [user] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: `device-${id}` });
    };
    caller = await makeCaller(userId);
    other = await makeCaller(otherId);
  });

  beforeEach(async () => {
    remoteMode = "online";
    remotePosts = 0;
    await q("DELETE FROM planned_entries");
    await q("DELETE FROM outbox");
    await q("DELETE FROM worklogs");
    await q("DELETE FROM worklog_trash");
    await q("DELETE FROM timers");
    await q("DELETE FROM week_locks");
    await caller.settings.update({ overlapPolicy: "warn" });
  });

  const addPlan = (overrides: Partial<PlannedCreate> = {}) => caller.planned.create({
    kind: "work",
    issueKey: "APP-1",
    connectionId: jiraId,
    startsAt: "2026-10-14T09:00:00+02:00",
    endsAt: "2026-10-14T10:00:00+02:00",
    note: "planned",
    ...overrides,
  });

  it("validates intervals, issue requirements and user-level vacations", async () => {
    await expect(addPlan({ startsAt: "2026-10-14T10:00:00+02:00", endsAt: "2026-10-14T09:00:00+02:00" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(addPlan({ issueKey: null, connectionId: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(addPlan({ issueKey: "MISSING-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addPlan({ kind: "vacation" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const travel = await addPlan({ kind: "travel", issueKey: null, connectionId: null });
    expect(travel).toMatchObject({ kind: "travel", issueKey: null, connectionId: null });
    await expect(caller.planned.convert({ id: travel.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 0 }]);
  });

  it("lists by interval overlap with exclusive boundaries and per-user ownership", async () => {
    const before = await addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: "2026-10-14T08:00:00+02:00", endsAt: "2026-10-14T10:00:00+02:00" });
    const inside = await addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: "2026-10-14T10:00:00+02:00", endsAt: "2026-10-14T11:00:00+02:00" });
    const after = await addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: "2026-10-14T11:00:00+02:00", endsAt: "2026-10-14T12:00:00+02:00" });
    const spanning = await addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: "2026-10-14T09:30:00+02:00", endsAt: "2026-10-14T10:30:00+02:00" });
    await other.planned.create({ kind: "vacation", startsAt: "2026-10-14T10:00:00+02:00", endsAt: "2026-10-14T11:00:00+02:00" });
    const rows = await caller.planned.list({ from: "2026-10-14T10:00:00+02:00", to: "2026-10-14T11:00:00+02:00" });
    expect(rows.map((p) => p.id).sort()).toEqual([inside.id, spanning.id].sort());
    expect(rows.map((p) => p.id)).not.toContain(before.id);
    expect(rows.map((p) => p.id)).not.toContain(after.id);
    expect(rows.every((p) => p.userId === userId)).toBe(true);
  });

  it("never reads, updates, removes or converts another user's plan or connection", async () => {
    const bobPlan = await other.planned.create({ kind: "vacation", startsAt: "2026-10-14T09:00:00+02:00", endsAt: "2026-10-14T10:00:00+02:00", note: "private" });
    expect(await caller.planned.list()).toEqual([]);
    for (const call of [
      () => caller.planned.update({ id: bobPlan.id, note: "stolen" }),
      () => caller.planned.remove({ id: bobPlan.id }),
      () => caller.planned.convert({ id: bobPlan.id }),
      () => other.planned.create({ kind: "work", issueKey: "APP-1", connectionId: jiraId, startsAt: "2026-10-14T09:00:00+02:00", endsAt: "2026-10-14T10:00:00+02:00" }),
    ]) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await other.planned.list())[0]).toMatchObject({ id: bobPlan.id, note: "private" });
    expect(await q("SELECT user_id FROM planned_entries")).toEqual([{ user_id: otherId }]);
  });

  it("checks every touched week, including a locked week in the middle", async () => {
    await caller.weeks.close({ week: "2026-10-21" });
    await expect(addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: "2026-10-12T00:00:00+02:00", endsAt: "2026-11-02T00:00:00+01:00" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await caller.planned.list()).toEqual([]);
  });

  it("uses an exclusive end at week boundaries", async () => {
    await caller.weeks.close({ week: "2026-10-19" });
    const saved = await addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: "2026-10-16T00:00:00+02:00", endsAt: "2026-10-19T00:00:00+02:00" });
    expect(saved.id).toBeTruthy();
  });

  it("checks old and new weeks on update and the old week on remove", async () => {
    const old = await addPlan();
    await caller.weeks.close({ week: "2026-10-12" });
    await expect(caller.planned.update({ id: old.id, note: "changed" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.planned.remove({ id: old.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller.weeks.reopen({ week: "2026-10-12" });
    await caller.weeks.close({ week: "2026-10-19" });
    await expect(caller.planned.update({ id: old.id, startsAt: "2026-10-20T09:00:00+02:00", endsAt: "2026-10-20T10:00:00+02:00" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("conversion reuses worklog overlap checks and leaves the plan unchanged on conflict", async () => {
    const planned = await addPlan();
    await caller.settings.update({ overlapPolicy: "block" });
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'APP-2', 'local-overlap', 1800, ?, '', 1)",
      userId,
      jiraId,
      new Date("2026-10-14T09:30:00+02:00").getTime(),
    );
    await expect(caller.planned.convert({ id: planned.id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller.planned.list())[0].convertedWorklogId).toBeNull();
    expect(remotePosts).toBe(0);
  });

  it("conversion is idempotent even for parallel double clicks", async () => {
    const planned = await addPlan();
    const [first, second] = await Promise.all([caller.planned.convert({ id: planned.id }), caller.planned.convert({ id: planned.id })]);
    expect(first.worklog.id).toBe(second.worklog.id);
    expect(first.planned.convertedWorklogId).toBe(first.worklog.id);
    expect(second.planned.convertedWorklogId).toBe(first.worklog.id);
    expect(first.worklog).toMatchObject({ timeSpentSeconds: 3600, comment: "planned" });
    expect(remotePosts).toBe(1);
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 1 }]);
    const retry = await caller.planned.convert({ id: planned.id });
    expect(retry.worklog.id).toBe(first.worklog.id);
    expect(remotePosts).toBe(1);
  });

  it("stores pending worklog ids on offline conversion without duplicating them on retry", async () => {
    const planned = await addPlan({ kind: "travel", issueKey: "TRV-1" });
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM worklog_sinks")).toEqual([{ n: 0 }]);
    remoteMode = "offline";
    const converted = await caller.planned.convert({ id: planned.id });
    expect(converted.worklog.remoteId).toMatch(/^pending-/);
    expect(converted.planned.convertedWorklogId).toBe(converted.worklog.id);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 1 }]);
    const retry = await caller.planned.convert({ id: planned.id });
    expect(retry.worklog.id).toBe(converted.worklog.id);
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 1 }]);
  });

  it("a provider refusal leaves the plan unconverted and creates no worklog", async () => {
    const planned = await addPlan();
    remoteMode = "refuse";
    await expect(caller.planned.convert({ id: planned.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await caller.planned.list())[0].convertedWorklogId).toBeNull();
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
  });

  it("vacation is never convertible", async () => {
    const planned = await addPlan({ kind: "vacation", issueKey: null, connectionId: null });
    await expect(caller.planned.convert({ id: planned.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await caller.planned.list())[0].convertedWorklogId).toBeNull();
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 0 }]);
  });

  it("refuses future starts on noFuture providers before any provider write", async () => {
    const start = new Date(Date.now() + 86_400_000);
    const planned = await addPlan({
      issueKey: "acme/web#1",
      connectionId: gitlabId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600_000).toISOString(),
    });
    await expect(caller.planned.convert({ id: planned.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("future") });
    expect((await caller.planned.list())[0].convertedWorklogId).toBeNull();
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 0 }]);
  });

  it("plans stay out of actual-time stats, reports, timers and sync queues", async () => {
    const now = new Date();
    await addPlan({ startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 3600_000).toISOString() });
    await addPlan({ kind: "vacation", issueKey: null, connectionId: null, startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 7200_000).toISOString() });
    const stats = await caller.stats.dashboard();
    expect([stats.todaySeconds, stats.weekSeconds, stats.monthSeconds]).toEqual([0, 0, 0]);
    expect(stats.perProject).toEqual([]);
    const range = { from: dayKey(now), to: dayKey(now) };
    expect((await caller.reports.generate({ ...range, groupBy: "issue" })).rows).toEqual([]);
    expect((await caller.reports.daily(range)).days).toEqual([]);
    expect(await caller.timers.list()).toEqual([]);
    expect(await q("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM worklog_sinks")).toEqual([{ n: 0 }]);
  });
});
