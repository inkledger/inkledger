import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("./connection").q = async (text, ...params) => (await import("./connection")).q(text, ...params);

describe("containers", () => {
  let userId = 0;
  let one = 0;
  let two = 0;

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('c', 'C', ?) RETURNING id", Date.now());
    userId = u.id;
    const conn = async (host: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', ?, 'me', 'x', ?) RETURNING id", userId, `https://${host}`, Date.now()))[0].id;
    one = await conn("one.example");
    two = await conn("two.example");
  });

  const issue = (connectionId: number, key: string, project: string) =>
    q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 'S', 'To Do', ?, ?, 'u', ?)",
      userId,
      connectionId,
      `id-${key}`,
      key,
      project,
      `${project} on ${connectionId}`,
      Date.now(),
    );
  const containerOf = async (key: string) => (await q<{ container_id: number }>("SELECT container_id FROM issues WHERE key = ?", key))[0].container_id;

  it("an issue written by its project key gets that project's container, made once per connection", async () => {
    await issue(one, "APP-1", "APP");
    await issue(one, "APP-2", "APP");
    await issue(two, "APP-3", "APP");
    expect(await containerOf("APP-1")).toBe(await containerOf("APP-2"));
    expect(await containerOf("APP-3")).not.toBe(await containerOf("APP-1"));
    expect(await q("SELECT remote_id, key FROM containers WHERE connection_id = ?", one)).toEqual([{ remote_id: "key:APP", key: "APP" }]);
  });

  it("once its real id is known, the same container takes it (no second one)", async () => {
    const { ensureContainer } = await import("./containers");
    const before = await containerOf("APP-1");
    const id = await ensureContainer(one, { remoteId: "10200", key: "APP", name: "Application", kind: "project" });
    expect(id).toBe(before);
    expect(await q("SELECT remote_id, name FROM containers WHERE connection_id = ?", one)).toEqual([{ remote_id: "10200", name: "Application" }]);
    expect(await ensureContainer(one, { remoteId: "10200", key: "APP", name: "Application", kind: "project" })).toBe(before);
  });

  it("reports keep two connections' projects of the same key apart", async () => {
    const now = new Date(2026, 9, 14, 10).getTime();
    for (const [key, conn] of [["APP-1", one], ["APP-3", two]] as const) {
      await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, ?, 3600, ?, ?)", userId, conn, key, `w-${key}`, now, now);
    }
    const { appRouter } = await import("../router");
    const [user] = await q<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", userId);
    const { getDb } = await import("./connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb().select().from(users).where(eq(users.id, user.id as number));
    const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null });
    const report = await caller.reports.generate({ from: "2026-10-01", to: "2026-10-31", groupBy: "project" });
    expect(report.rows.map((r) => [r.key, r.seconds])).toEqual([
      ["APP", 3600],
      ["APP", 3600],
    ]);
    expect(report.rows.map((r) => r.label).sort()).toEqual(["APP — APP on " + two, "APP — Application"]);
  });
});
