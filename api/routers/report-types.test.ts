import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** Reports by issue type: the trend's stacked bars and the rows' colours (docs/design-system.md §3.5). */
describe("a range's time by issue type", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  const monday = new Date(2026, 9, 12, 9).getTime();
  const tuesday = new Date(2026, 9, 13, 9).getTime();

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('t', 'T', 1) RETURNING id");
    const [{ id: jira }] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://x', 'me', 'x', 1) RETURNING id", u.id);
    const issue = (key: string, type: string) =>
      q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, issue_type, labels, assignee_id, url, synced_at) VALUES (?, ?, ?, ?, 's', 'To Do', 'APP', 'App', ?, '[]', 'me', 'u', 1)", u.id, jira, `id-${key}`, key, type);
    await issue("APP-1", "Bug");
    await issue("APP-2", "Attività");
    await issue("APP-3", "Bug");
    const log = (key: string, seconds: number, at: number) =>
      q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (?, ?, ?, ?, ?, ?, '', 1)", u.id, jira, key, `w-${key}-${at}`, at, seconds);
    await log("APP-1", 3600, monday);
    await log("APP-2", 1800, monday + 3_600_000);
    await log("APP-3", 1200, tuesday);
    // Not in the catalogue: its type isn't known.
    await log("OLD-9", 600, tuesday + 3_600_000);
    // Parallel to APP-3: the day's hours count it once.
    await log("APP-2", 1200, tuesday);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const range = { from: "2026-10-12", to: "2026-10-18" };

  it("totals per type, the busiest first, and per day the hours worked with each type's logged time", async () => {
    const r = await caller.reports.types(range);
    expect(r.types).toEqual([
      { type: "Bug", seconds: 4800, entries: 2 },
      { type: "Attività", seconds: 3000, entries: 2 },
      { type: "", seconds: 600, entries: 1 },
    ]);
    expect(r.days.map((d) => d.day)).toEqual(["2026-10-12", "2026-10-13"]);
    const tue = r.days[1];
    expect(tue.seconds).toBe(1800);
    expect(Object.fromEntries(tue.parts.map((p) => [p.type, p.seconds]))).toEqual({ Bug: 1200, Attività: 1200, "": 600 });
  });

  it("issue rows carry their type, by issue and by day", async () => {
    const byIssue = await caller.reports.generate({ ...range, groupBy: "issue" });
    expect(Object.fromEntries(byIssue.rows.map((r) => [r.key, "issueType" in r ? r.issueType : undefined]))).toEqual({ "APP-1": "Bug", "APP-2": "Attività", "APP-3": "Bug", "OLD-9": "" });
    const daily = await caller.reports.daily(range);
    expect(daily.issues.find((r) => r.key === "APP-2")?.issueType).toBe("Attività");
  });
});
