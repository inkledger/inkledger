import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

/**
 * The team report (viewTeamTime): everyone's logged hours over a range,
 * against each one's own target, and how fresh each one's time is. Ann may
 * see it, Bob may not; Cy and Dee only have time; Eve is turned off.
 */
describe("team report", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let ann: Caller;
  let bob: Caller;
  let admin: Caller;
  const id: Record<string, number> = {};
  const HOUR = 3600;
  /** Local midnight of a day in the week of Monday 5 October 2026. */
  const at = (day: number, hour = 0) => new Date(2026, 9, day, hour).getTime();
  const week = { from: "2026-10-05", to: "2026-10-11" };

  const callerOf = async (userId: number): Promise<Caller> => {
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, userId));
    return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: `dev-${userId}` });
  };
  const account = async (name: string, role = "member", permissions = "[]", disabled = false) => {
    const [u] = await q<{ id: number }>(
      "INSERT INTO users (username, display_name, role, permissions, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, 1) RETURNING id",
      name,
      name[0].toUpperCase() + name.slice(1),
      role,
      permissions,
      disabled ? 1 : null,
    );
    id[name] = u.id;
    return u.id;
  };
  const connection = async (userId: number, type: string, opts: { status?: string; legacy?: boolean } = {}) => {
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, status, legacy, created_at) VALUES (?, ?, ?, ?, ?, 'x', ?, ?, 1) RETURNING id",
      userId,
      type,
      type === "jira" ? "https://x.atlassian.net" : "https://github.com",
      `r${userId}`,
      type === "jira" ? JSON.stringify({ deployment: "cloud", authType: "basic", username: "x@x.it" }) : "{}",
      opts.status ?? "ok",
      opts.legacy ? 1 : 0,
    );
    return c.id;
  };
  const worklog = async (userId: number, conn: number, started: number, seconds: number, remoteId = `w${Math.random()}`) =>
    q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'APP-1', ?, ?, ?, 1)", userId, conn, remoteId, seconds, started);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    await account("ann", "member", '["viewTeamTime"]');
    await account("bob", "member", '["manageUsers"]');
    await account("root", "admin");
    await account("cy");
    await account("dee");
    await account("eve", "member", "[]", true);
    const now = Date.now();
    // Ann: Jira read just now; 6h on Monday, 2h on Tuesday, one still queued.
    const annJira = await connection(id.ann, "jira");
    await q("INSERT INTO connection_sync (connection_id, stream, last_ok_at) VALUES (?, 'worklogs', ?)", annJira, now - 60_000);
    await worklog(id.ann, annJira, at(5, 9), 6 * HOUR);
    await worklog(id.ann, annJira, at(6, 9), 1 * HOUR);
    await worklog(id.ann, annJira, at(6, 14), 1 * HOUR, "pending-1");
    // Outside the range: never counted.
    await worklog(id.ann, annJira, at(12, 9), 5 * HOUR);
    // Cy: Jira read two days ago; 10h on Monday; on vacation all Wednesday.
    const cyJira = await connection(id.cy, "jira");
    await q("INSERT INTO connection_sync (connection_id, stream, last_ok_at) VALUES (?, 'worklogs', ?)", cyJira, now - 2 * 24 * 3600_000);
    await worklog(id.cy, cyJira, at(5, 8), 10 * HOUR);
    await q("INSERT INTO planned_entries (user_id, kind, starts_at, ends_at, note, created_at, updated_at) VALUES (?, 'vacation', ?, ?, 'beach', 1, 1)", id.cy, at(7), at(8));
    await q("INSERT INTO planned_entries (user_id, kind, starts_at, ends_at, note, created_at, updated_at) VALUES (?, 'travel', ?, ?, 'client', 1, 1)", id.cy, at(5, 14), at(5, 16));
    // Dee: GitHub only (time kept here); a Jira that refuses its credentials makes it "reconnect" below.
    const deeGithub = await connection(id.dee, "github");
    await worklog(id.dee, deeGithub, at(9, 10), 3 * HOUR);
    // Bob: a legacy Jira connection never read.
    await connection(id.bob, "jira", { legacy: true });
    // Eve is off: her time is not on the report.
    const eveJira = await connection(id.eve, "jira");
    await worklog(id.eve, eveJira, at(5, 9), 8 * HOUR);
    ann = await callerOf(id.ann);
    bob = await callerOf(id.bob);
    admin = await callerOf(id.root);
  });

  it("only whoever holds viewTeamTime (or an admin) may read it", async () => {
    await expect(bob.team.overview(week)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(bob.team.day({ userId: id.cy, day: "2026-10-05" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ann.team.overview(week)).resolves.toBeTruthy();
    await expect(admin.team.overview(week)).resolves.toBeTruthy();
  });

  it("every active account, most hours first, with its days and target", async () => {
    const r = await ann.team.overview(week);
    // Ties (no time) by name.
    expect(r.people.map((p) => p.displayName)).toEqual(["Cy", "Ann", "Dee", "Bob", "Root"]);
    const byName = new Map(r.people.map((p) => [p.displayName, p]));
    expect(byName.has("Eve")).toBe(false);
    const annRow = byName.get("Ann");
    // A queued worklog was logged all the same.
    expect(annRow?.loggedSeconds).toBe(8 * HOUR);
    expect(annRow?.days).toHaveLength(7);
    expect(annRow?.days.slice(0, 2).map((d) => d.loggedSeconds)).toEqual([6 * HOUR, 2 * HOUR]);
    // Default schedule: Mon–Fri, 8h; the weekend expects nothing.
    expect(annRow?.targetSeconds).toBe(40 * HOUR);
    expect(annRow?.days[5].targetSeconds).toBe(0);
    expect(annRow?.coverage).toBeCloseTo(0.2);
    // Vacation lowers the target; travel doesn't.
    const cyRow = byName.get("Cy");
    expect(cyRow?.targetSeconds).toBe(32 * HOUR);
    expect(cyRow?.days[2].targetSeconds).toBe(0);
    expect(r.loggedSeconds).toBe(8 * HOUR + 10 * HOUR + 3 * HOUR);
  });

  it("says how fresh each account's time is", async () => {
    const r = await ann.team.overview(week);
    const state = (name: string) => r.people.find((p) => p.displayName === name)?.freshness.state;
    expect(state("Ann")).toBe("ok");
    expect(state("Cy")).toBe("stale");
    expect(state("Dee")).toBe("local");
    expect(state("Bob")).toBe("never");
    expect(state("Root")).toBe("local");
    await connection(id.dee, "jira", { status: "auth_failed" });
    const after = await ann.team.overview(week);
    expect(after.people.find((p) => p.displayName === "Dee")?.freshness.state).toBe("reconnect");
    await q("INSERT INTO sync_state (user_id, last_worklog_sync_at) VALUES (?, ?)", id.bob, Date.now());
    const legacy = await ann.team.overview(week);
    expect(legacy.people.find((p) => p.displayName === "Bob")?.freshness.state).toBe("ok");
  });

  it("refuses a range longer than a report's", async () => {
    await expect(ann.team.overview({ from: "2024-01-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(ann.team.overview({ from: "2026-10-11", to: "2026-10-05" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("one account's day: its worklogs, its vacation bare, its schedule", async () => {
    const mon = await ann.team.day({ userId: id.cy, day: "2026-10-05" });
    expect(mon.entries).toHaveLength(1);
    expect(mon.entries[0]).toMatchObject({ issueKey: "APP-1", seconds: 10 * HOUR });
    // Travel is nobody else's business.
    expect(mon.away).toEqual([]);
    expect(mon.schedule).toHaveLength(7);
    const wed = await ann.team.day({ userId: id.cy, day: "2026-10-07" });
    expect(wed.away).toHaveLength(1);
    expect(Object.keys(wed.away[0]).sort()).toEqual(["endsAt", "startsAt"]);
  });

  it("no day for an account turned off or missing", async () => {
    await expect(ann.team.day({ userId: id.eve, day: "2026-10-05" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ann.team.day({ userId: 99_999, day: "2026-10-05" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
