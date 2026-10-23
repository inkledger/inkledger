import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** A timer started on the wrong issue: moved with its count, added to the target's when it has one. */
describe("moving the timer to another issue", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let me: Caller;
  let phone: Caller;
  let jira = 0;
  const rows = () => q<{ issue_key: string; state: string; acc: number; note: string; item: boolean }>("SELECT issue_key, state, accumulated_seconds AS acc, note, item_id IS NOT NULL AS item FROM timers ORDER BY issue_key");

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('mv', 'Mv', 1) RETURNING id");
    jira = (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://acme.atlassian.net', 'me', 'x', 1) RETURNING id", u.id))[0].id;
    for (const key of ["APP-1", "APP-2", "APP-3"])
      await q(
        "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 'S', 'To Do', 'todo', 'APP', 'App', 'u', 1)",
        u.id,
        jira,
        key,
        key,
      );
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    const caller = (deviceId: string) => appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null, deviceId });
    me = caller("desk");
    phone = caller("phone");
  });

  it("running, onto an issue with no timer: the same count runs on there, its note kept", async () => {
    await me.timers.start({ issueKey: "APP-1" });
    await me.timers.setNote({ issueKey: "APP-1", note: "login bug" });
    await q("UPDATE timers SET accumulated_seconds = 600");
    const r = await me.timers.move({ issueKey: "APP-1", toIssueKey: "APP-2" });
    expect(r.merged).toBe(false);
    expect(await rows()).toEqual([{ issue_key: "APP-2", state: "running", acc: 600, note: "login bug", item: true }]);
    await expect(me.timers.move({ issueKey: "APP-2", toIssueKey: "APP-2" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(me.timers.move({ issueKey: "APP-1", toIssueKey: "APP-3" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("onto an issue with a paused timer: the two counts add up, notes joined, running on; once per op id", async () => {
    await me.timers.pause({ issueKey: "APP-2" });
    await q("UPDATE timers SET accumulated_seconds = 900, note = 'review' WHERE issue_key = 'APP-2'");
    await me.timers.start({ issueKey: "APP-3" });
    await q("UPDATE timers SET accumulated_seconds = 300, note = 'oops' WHERE issue_key = 'APP-3'");
    const op = "move-op-0001";
    await me.timers.move({ issueKey: "APP-3", toIssueKey: "APP-2", opId: op });
    await me.timers.move({ issueKey: "APP-3", toIssueKey: "APP-2", opId: op });
    const [t] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(t).toMatchObject({ issue_key: "APP-2", state: "running", note: "review · oops" });
    expect(t.acc).toBeGreaterThanOrEqual(1200);
    expect(t.acc).toBeLessThan(1205);
  });

  it("held by another device: refused unless taken over", async () => {
    await expect(phone.timers.move({ issueKey: "APP-2", toIssueKey: "APP-1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await phone.timers.move({ issueKey: "APP-2", toIssueKey: "APP-1", force: true });
    expect((await rows()).map((r) => [r.issue_key, r.state])).toEqual([["APP-1", "running"]]);
  });

  it("paused stays paused; the TODO worked on with it follows to the new issue", async () => {
    await q("DELETE FROM timers");
    const todo = await me.todos.add({ text: "fix it", issueKey: "APP-1", connectionId: jira });
    await me.todos.startWork({ id: todo.id });
    await me.timers.move({ issueKey: "APP-1", toIssueKey: "APP-3" });
    expect(await me.todos.working()).toMatchObject({ todoId: todo.id, linked: true, issueKey: "APP-3" });
    await me.timers.pause({ issueKey: "APP-3" });
    await me.timers.move({ issueKey: "APP-3", toIssueKey: "APP-1" });
    expect((await rows()).map((r) => [r.issue_key, r.state])).toEqual([["APP-1", "paused"]]);
  });
});
