import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

/**
 * Time on a TODO beside the real time: with its issue the timer runs too (the
 * real time) and the TODO's stretch ends with it; without one only the TODO's
 * time runs, never a worklog, and one focus at a time.
 */
describe("working on a TODO", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let me: Caller;
  let jira = 0;
  let userId = 0;
  const sessions = () => q<{ todo_id: number | null; label: string; linked: number; open: boolean }>("SELECT todo_id, label, linked, ended_at IS NULL AS open FROM todo_sessions ORDER BY id");

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('w', 'W', 1) RETURNING id");
    userId = u.id;
    jira = (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://acme.atlassian.net', 'me', 'x', 1) RETURNING id", u.id))[0].id;
    for (const key of ["APP-1", "APP-2"])
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
    me = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null, deviceId: "dev-1" });
  });

  it("with its issue: the timer starts and the TODO's time runs with it; stopping the timer ends both", async () => {
    const todo = await me.todos.add({ text: "fix login", issueKey: "APP-1", connectionId: jira });
    const r = await me.todos.startWork({ id: todo.id });
    expect(r.linked).toBe(true);
    expect((await me.timers.list()).map((x) => [x.issueKey, x.state])).toEqual([["APP-1", "running"]]);
    expect(await me.todos.working()).toMatchObject({ todoId: todo.id, linked: true, issueKey: "APP-1" });
    await me.timers.stop({ issueKey: "APP-1" });
    expect(await me.todos.working()).toBeNull();
    expect(await sessions()).toEqual([{ todo_id: todo.id, label: "fix login", linked: 1, open: false }]);
  });

  it("without an issue: only the TODO's time, the issue timer pauses (its time to log), and an issue timer takes the focus back", async () => {
    await q("DELETE FROM todo_sessions");
    await me.timers.start({ issueKey: "APP-2" });
    const todo = await me.todos.add({ text: "read the RFC" });
    const r = await me.todos.startWork({ id: todo.id });
    expect(r).toMatchObject({ linked: false, switchedFrom: { issueKey: "APP-2" } });
    expect((await me.timers.list()).find((x) => x.issueKey === "APP-2")?.state).toBe("paused");
    expect(await me.todos.working()).toMatchObject({ todoId: todo.id, linked: false });
    // No worklog, no timer for it.
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 0 }]);
    expect((await me.timers.list()).some((x) => x.state === "running")).toBe(false);
    // An issue timer starts: the TODO's time stops there.
    await me.timers.start({ issueKey: "APP-1" });
    expect(await me.todos.working()).toBeNull();
    await me.timers.discard({ issueKey: "APP-1" });
    await me.timers.discard({ issueKey: "APP-2" });
  });

  it("one stretch at a time; a discarded timer ends its TODO's; a trim leaves the same hole; ticking ends it", async () => {
    await q("DELETE FROM todo_sessions");
    const a = await me.todos.add({ text: "a", issueKey: "APP-1", connectionId: jira });
    const b = await me.todos.add({ text: "b", issueKey: "APP-1", connectionId: jira });
    await me.todos.startWork({ id: a.id });
    // Same issue, another TODO: the timer runs on, the first stretch ends.
    await me.todos.startWork({ id: b.id });
    expect((await sessions()).map((s) => [s.todo_id, s.open])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
    // Idle trim: the open stretch splits.
    await q("UPDATE todo_sessions SET started_at = started_at - 3600000 WHERE ended_at IS NULL");
    await me.timers.trim({ issueKey: "APP-1", seconds: 600 });
    const [, cut, again] = await q<{ ended_at: string | null; started_at: string }>("SELECT started_at, ended_at FROM todo_sessions ORDER BY id");
    expect(cut.ended_at).not.toBeNull();
    expect(again.ended_at).toBeNull();
    expect(Number(again.started_at) - Number(cut.ended_at)).toBeGreaterThanOrEqual(599_000);
    // Ticked: no more time on it.
    await me.todos.update({ id: b.id, done: true });
    expect(await me.todos.working()).toBeNull();
    await expect(me.todos.startWork({ id: b.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // A discard ends a linked stretch too.
    await me.todos.startWork({ id: a.id });
    await me.timers.discard({ issueKey: "APP-1" });
    expect(await me.todos.working()).toBeNull();
  });

  it("time spent shows on the TODO; a forgotten stretch without timer ends at its day's end; a deleted TODO keeps its time", async () => {
    await q("DELETE FROM todo_sessions");
    const x = await me.todos.add({ text: "spent" });
    await q("INSERT INTO todo_sessions (user_id, todo_id, label, linked, started_at, ended_at) VALUES (?, ?, 'spent', 0, 0, 1800000)", userId, x.id);
    expect((await me.todos.list({ view: "someday", today: "2026-10-23" })).find((r) => r.id === x.id)?.spentSeconds).toBe(1800);
    // Left running from yesterday.
    const yesterday = Date.now() - 36 * 3600_000;
    await q("INSERT INTO todo_sessions (user_id, todo_id, label, linked, started_at) VALUES (?, ?, 'spent', 0, ?)", userId, x.id, yesterday);
    expect(await me.todos.working()).toBeNull();
    const [late] = await q<{ ended_at: string }>("SELECT ended_at FROM todo_sessions WHERE started_at = ?", yesterday);
    expect(new Date(Number(late.ended_at)).getDate()).toBe(new Date(yesterday).getDate());
    await me.todos.remove({ id: x.id });
    expect((await sessions()).every((s) => s.todo_id === null && s.label === "spent")).toBe(true);
  });
});
