import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("the TODO list", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let me: Caller;
  let jira = 0;
  let gh = 0;
  const today = "2026-10-23";

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('m', 'M', 1) RETURNING id");
    const conn = async (type: string, host: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, ?, ?, 'me', 'x', 1) RETURNING id", u.id, type, `https://${host}`))[0].id;
    // Two trackers: a TODO of its own still needs no connection.
    jira = await conn("jira", "acme.atlassian.net");
    gh = await conn("github", "api.github.com");
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, url, synced_at) VALUES (?, ?, 'i1', 'APP-1', 'Login fails', 'To Do', 'todo', 'APP', 'App', 'u', 1)",
      u.id,
      jira,
    );
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
    me = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null });
  });

  const texts = async (view: "today" | "upcoming" | "someday" | "done") => (await me.todos.list({ view, today })).map((x) => x.text);

  it("by day: today with the late ones first, upcoming by day, someday, done; counts", async () => {
    await me.todos.add({ text: "someday thing" });
    await me.todos.add({ text: "late", dueOn: "2026-10-20" });
    await me.todos.add({ text: "today", dueOn: today });
    await me.todos.add({ text: "monday", dueOn: "2026-10-26" });
    await me.todos.add({ text: "tomorrow", dueOn: "2026-10-24" });
    expect(await texts("today")).toEqual(["late", "today"]);
    expect(await texts("upcoming")).toEqual(["tomorrow", "monday"]);
    expect(await texts("someday")).toEqual(["someday thing"]);
    expect(await me.todos.counts({ today })).toEqual({ today: 2, late: 1, upcoming: 2, someday: 1 });
    // Done: out of its view, into "done"; undone, back.
    const [late] = await me.todos.list({ view: "today", today });
    await me.todos.update({ id: late.id, done: true });
    expect(await texts("today")).toEqual(["today"]);
    expect(await texts("done")).toEqual(["late"]);
    await me.todos.update({ id: late.id, done: false });
    expect(await texts("today")).toEqual(["late", "today"]);
  });

  it("details: priority, estimate, steps; a repeating one comes back once ticked, and goes again unticked", async () => {
    await q("DELETE FROM todos");
    const t = await me.todos.add({ text: "standup", dueOn: today, priority: 1, estimateSeconds: 900, repeat: "weekdays", steps: [{ id: "s1", text: "notes", done: true }] });
    expect(t).toMatchObject({ priority: 1, estimateSeconds: 900, repeat: "weekdays" });
    // Two ticks at once (two devices): one comes back, not two.
    await Promise.all([me.todos.update({ id: t.id, done: true, today }), me.todos.update({ id: t.id, done: true, today })]);
    const next = await me.todos.list({ view: "upcoming", today });
    expect(next).toHaveLength(1);
    // Friday → Monday, its checklist unticked, its details kept.
    expect(next[0]).toMatchObject({ text: "standup", dueOn: "2026-10-26", priority: 1, estimateSeconds: 900, repeat: "weekdays", repeatOf: t.id });
    expect(JSON.parse(next[0].steps)).toEqual([{ id: "s1", text: "notes", done: false }]);
    // Unticked (Undo): the one it brought goes away.
    await me.todos.update({ id: t.id, done: false, today });
    expect(await texts("upcoming")).toEqual([]);
    expect(await texts("today")).toEqual(["standup"]);
    // Bad details are refused.
    await expect(me.todos.update({ id: t.id, steps: Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: "x", done: false })) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(me.todos.add({ text: "x", estimateSeconds: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Once more for "Delete, then Undo": the details come back too.
    const gone = await me.todos.remove({ id: t.id });
    const back = await me.todos.restore({ ...gone, done: false });
    expect(back).toMatchObject({ priority: 1, estimateSeconds: 900, repeat: "weekdays" });
  });

  it("a day is a real day", async () => {
    await expect(me.todos.add({ text: "x", dueOn: "2026-02-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(me.todos.list({ view: "today", today: "23/10/2026" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(me.todos.add({ text: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("tied to an issue, a comment on it or a private note: shown with the issue, listed on its page", async () => {
    const onIssue = await me.todos.add({ text: "reply", issueKey: "APP-1" });
    expect(onIssue).toMatchObject({ issueKey: "APP-1", connectionId: jira, commentId: null });
    const onComment = await me.todos.add({ text: "answer Anna", issueKey: "APP-1", connectionId: jira, commentId: "10042", commentExcerpt: "Can you check the logs?" });
    expect(onComment).toMatchObject({ commentId: "10042", commentExcerpt: "Can you check the logs?" });
    await expect(me.todos.add({ text: "x", commentId: "1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { id: noteId } = await me.issueNotes.add({ issueKey: "APP-1", connectionId: jira, body: "Try the staging DB" });
    const onNote = await me.todos.add({ text: "try it", issueNoteId: noteId });
    expect(onNote).toMatchObject({ issueKey: "APP-1", connectionId: jira, issueNoteId: noteId });
    await expect(me.todos.add({ text: "x", issueNoteId: noteId, issueKey: "APP-2" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const listed = await me.todos.forIssue({ issueKey: "APP-1", connectionId: jira });
    expect(listed.map((x) => x.text).sort()).toEqual(["answer Anna", "reply", "try it"]);
    expect(listed.find((x) => x.text === "reply")).toMatchObject({ summary: "Login fails", status: "To Do" });
    expect(listed.find((x) => x.text === "try it")).toMatchObject({ noteBody: "Try the staging DB" });
    // Tied to none again: the comment lets go too.
    const freed = await me.todos.update({ id: onComment.id, issueKey: null });
    expect(freed).toMatchObject({ issueKey: null, connectionId: null, commentId: null, commentExcerpt: null });
  });

  it("follows its issue when the key changes; a deleted note leaves the TODO", async () => {
    const t = await me.todos.add({ text: "follow me", issueKey: "APP-1" });
    await q("UPDATE issues SET key = 'NEW-1' WHERE key = 'APP-1'");
    expect((await q<{ issue_key: string }>("SELECT issue_key FROM todos WHERE id = ?", t.id))[0].issue_key).toBe("NEW-1");
    await q("UPDATE issues SET key = 'APP-1' WHERE key = 'NEW-1'");
    const { id: noteId } = await me.issueNotes.add({ issueKey: "APP-1", connectionId: jira, body: "gone soon" });
    const onNote = await me.todos.add({ text: "on a note", issueNoteId: noteId });
    await me.issueNotes.remove({ id: noteId });
    expect((await q<{ issue_note_id: number | null; issue_key: string }>("SELECT issue_note_id, issue_key FROM todos WHERE id = ?", onNote.id))[0]).toEqual({ issue_note_id: null, issue_key: "APP-1" });
  });

  it("an issue key never without its connection", async () => {
    await expect(q("INSERT INTO todos (user_id, text, issue_key, position, created_at, updated_at) SELECT id, 'x', 'APP-1', 0, 1, 1 FROM users LIMIT 1")).rejects.toThrow(/todos_issue_has_connection/);
    expect(gh).toBeGreaterThan(0);
  });

  it("new ones first; the order by hand", async () => {
    await q("DELETE FROM todos");
    const a = await me.todos.add({ text: "a" });
    const b = await me.todos.add({ text: "b" });
    const c = await me.todos.add({ text: "c" });
    expect(await texts("someday")).toEqual(["c", "b", "a"]);
    await me.todos.reorder({ ids: [a.id, c.id, b.id] });
    expect(await texts("someday")).toEqual(["a", "c", "b"]);
  });

  it("deleted, then put back as it was", async () => {
    await q("DELETE FROM todos");
    const t = await me.todos.add({ text: "keep me", dueOn: today, issueKey: "APP-1", commentId: "7", commentExcerpt: "hey" });
    const gone = await me.todos.remove({ id: t.id });
    expect(await texts("today")).toEqual([]);
    await me.todos.restore({ ...gone, done: false });
    expect(await me.todos.list({ view: "today", today })).toMatchObject([{ text: "keep me", issueKey: "APP-1", commentId: "7", commentExcerpt: "hey" }]);
  });

  it("Undo puts it back even when its note went away (on its issue then); reorder fixes shared places", async () => {
    await q("DELETE FROM todos");
    const { id: noteId } = await me.issueNotes.add({ issueKey: "APP-1", connectionId: jira, body: "soon gone" });
    const t = await me.todos.add({ text: "from a note", issueNoteId: noteId });
    const gone = await me.todos.remove({ id: t.id });
    await me.issueNotes.remove({ id: noteId });
    const back = await me.todos.restore({ ...gone, done: false });
    expect(back).toMatchObject({ text: "from a note", issueKey: "APP-1", connectionId: jira, issueNoteId: null });
    // Two at the same place (an Undo and a new one): moved, they no longer tie.
    await q("DELETE FROM todos");
    const a = await me.todos.add({ text: "a" });
    const c = await me.todos.add({ text: "c" });
    await q("UPDATE todos SET position = 5");
    await me.todos.reorder({ ids: [c.id, a.id] });
    expect(await texts("someday")).toEqual(["c", "a"]);
    await me.todos.reorder({ ids: [a.id, c.id] });
    expect(await texts("someday")).toEqual(["a", "c"]);
  });

  it("reminders: due today or late, until put away for the day; planned again, it comes back", async () => {
    await q("DELETE FROM todos");
    const late = await me.todos.add({ text: "late", dueOn: "2026-10-21" });
    await me.todos.add({ text: "today", dueOn: today });
    await me.todos.add({ text: "later", dueOn: "2026-10-30" });
    await me.todos.add({ text: "someday" });
    expect((await me.todos.reminders({ today })).map((x) => x.text)).toEqual(["late", "today"]);
    await me.todos.dismissReminder({ id: late.id, today });
    expect((await me.todos.reminders({ today })).map((x) => x.text)).toEqual(["today"]);
    // The next day, still late: back.
    expect((await me.todos.reminders({ today: "2026-10-24" })).map((x) => x.text)).toEqual(["late", "today"]);
    // Planned again today: its reminder shows again (the same day now: by their order, the newer first).
    await me.todos.update({ id: late.id, dueOn: today });
    expect((await me.todos.reminders({ today })).map((x) => x.text)).toEqual(["today", "late"]);
  });
});
