import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

/**
 * D9: Timesheet and Report count this device's bucket unless "All" is on,
 * and read the search; the day's gaps (worklogs.list by default) always see
 * all the time, so time on a tracker outside the bucket is never a gap.
 */
describe("which time a view counts", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let device: Caller;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  const day = new Date(2026, 9, 14, 9).getTime();

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('d', 'D', 1) RETURNING id");
    const conn = async (type: string, me: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, ?, 'https://x', ?, 'x', 1) RETURNING id", u.id, type, me))[0].id;
    const jira = await conn("jira", "me-j");
    const gh = await conn("github", "me-g");
    const issue = (c: number, key: string, summary: string) =>
      q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, labels, assignee_id, url, synced_at) VALUES (?, ?, ?, ?, ?, 'To Do', 'P', 'P', '[]', 'me-j', 'u', 1)", u.id, c, `id-${key}`, key, summary);
    await issue(jira, "APP-1", "Login fails");
    await issue(gh, "acme/web#1", "Billing export");
    const log = (c: number, key: string, seconds: number, at: number) =>
      q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (?, ?, ?, ?, ?, ?, '', 1)", u.id, c, key, `w-${key}-${at}`, at, seconds);
    await log(jira, "APP-1", 3600, day);
    await log(gh, "acme/web#1", 1800, day + 3_600_000);
    // Not in the catalogue: counted by its tracker, matched by its key.
    await log(jira, "OLD-9", 600, day + 7_200_000);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    device = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: "device-abcdef" });
    const { id } = await device.buckets.save({ name: "Jira only", sources: [{ connectionId: jira, containerId: null }] });
    await device.buckets.setActive({ id });
  });

  const range = { from: "2026-10-14", to: "2026-10-14" };

  it("Report: the bucket's time, or all of it with All", async () => {
    expect((await device.reports.generate({ ...range, groupBy: "issue", scope: "bucket" })).rows.map((r) => [r.key, r.seconds])).toEqual([
      ["APP-1", 3600],
      ["OLD-9", 600],
    ]);
    expect((await device.reports.generate({ ...range, groupBy: "day", scope: "all" })).totalSeconds).toBe(6000);
    expect((await device.reports.daily({ ...range, scope: "bucket" })).totalSeconds).toBe(4200);
  });

  it("Report and Timesheet read the search; what can't be applied is said", async () => {
    const r = await device.reports.generate({ ...range, groupBy: "issue", search: "billing" });
    expect(r.rows.map((x) => x.key)).toEqual(["acme/web#1"]);
    expect((await device.reports.generate({ ...range, groupBy: "issue", search: "old-9" })).rows.map((x) => x.key)).toEqual(["OLD-9"]);
    expect((await device.reports.generate({ ...range, groupBy: "day", search: "sprint:3" })).query).toEqual({ unsupported: ["sprint:3"] });
    const ts = await device.worklogs.list({ from: new Date(day - 3_600_000).toISOString(), to: new Date(day + 86_400_000).toISOString(), scope: "bucket", search: "login" });
    expect(ts.map((w) => w.issueKey)).toEqual(["APP-1"]);
  });

  it("the day's gaps see all the time, whatever the bucket", async () => {
    const all = await device.worklogs.list({ from: new Date(day - 3_600_000).toISOString(), to: new Date(day + 86_400_000).toISOString() });
    expect(all.map((w) => w.issueKey).sort()).toEqual(["APP-1", "OLD-9", "acme/web#1"]);
  });
});
