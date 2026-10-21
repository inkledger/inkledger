// An edit skips its own entry in the overlap check, and only it: two trackers
// may each have an entry with the same remote id (numeric ids, two servers).
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("overlap check on an edit", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let mine = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('o', 'O', 1) RETURNING id");
    const conn = async (account: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'github', 'https://api.github.com', ?, '{}', 'x', 1) RETURNING id", u.id, account))[0].id;
    const a = await conn("a");
    const b = await conn("b");
    for (const [c, key] of [[a, "acme/a#1"], [b, "acme/b#1"]] as const) {
      await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 'S', 'Open', 'acme', 'acme', 'u', 1)", u.id, c, key, key);
    }
    const at = (h: number) => Date.parse(`2026-10-14T${String(h).padStart(2, "0")}:00:00+02:00`);
    // Same remote id on both trackers: A's at 09:00, B's at 11:00 (an hour each).
    [{ id: mine }] = await q<{ id: number }>("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (?, ?, 'acme/a#1', 'local-7', ?, 3600, '', 1) RETURNING id", u.id, a, at(9));
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (?, ?, 'acme/b#1', 'local-7', ?, 3600, '', 1)", u.id, b, at(11));
    await q("INSERT INTO settings (user_id, overlap_policy) VALUES (?, 'block') ON CONFLICT (user_id) DO UPDATE SET overlap_policy = 'block'", u.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  it("moving A's entry over B's (same remote id) is an overlap", async () => {
    await expect(caller.worklogs.update({ id: mine, seconds: 3600, started: "2026-10-14T11:30:00+02:00", comment: "" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("its own old place doesn't count", async () => {
    await expect(caller.worklogs.update({ id: mine, seconds: 3600, started: "2026-10-14T09:30:00+02:00", comment: "moved" })).resolves.toBeTruthy();
  });
});
