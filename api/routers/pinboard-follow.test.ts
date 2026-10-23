import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("a pinboard that follows a tag", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let me: Caller;
  let other: Caller;
  let jira = 0;
  let gh = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const user = async (name: string) => (await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name))[0].id;
    const u = await user("m");
    const o = await user("o");
    const conn = async (userId: number, type: string, host: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, ?, ?, 'me', 'x', 1) RETURNING id", userId, type, `https://${host}`))[0].id;
    jira = await conn(u, "jira", "acme.atlassian.net");
    gh = await conn(u, "github", "api.github.com");
    const issue = (c: number, key: string, o: { labels?: string[]; components?: string[]; category?: string; assignee?: string; updated?: number; hidden?: number }) =>
      q(
        `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, labels, components, assignee_id, jira_updated_at, hidden, url, synced_at)
         VALUES (?, ?, ?, ?, ?, 'To Do', ?, 'P', 'P', ?, ?, ?, ?, ?, 'u', 1)`,
        u, c, `id-${key}`, key, `Summary ${key}`, o.category ?? "todo", JSON.stringify(o.labels ?? []), JSON.stringify(o.components ?? []), o.assignee ?? "me", o.updated ?? 1, o.hidden ?? 0,
      );
    await issue(jira, "APP-1", { components: ["Backend"], labels: ["urgent"], updated: 3 });
    await issue(jira, "APP-2", { components: ["Backend", "API"], updated: 5 });
    await issue(jira, "APP-3", { components: ["Backend"], category: "done" });
    await issue(jira, "APP-4", { components: ["Backend"], assignee: "someone-else" });
    await issue(jira, "APP-5", { components: ["Backend"], hidden: 1 });
    await issue(jira, "APP-6", { components: ["Frontend"] });
    await issue(gh, "acme/web#1", { labels: ["urgent", "ui"], updated: 4 });
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const caller = async (id: number) => {
      const [row] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null });
    };
    me = await caller(u);
    other = await caller(o);
  });

  it("offers the tags of my open issues, most used first", async () => {
    expect(await me.pinboard.tags()).toEqual([
      { field: "component", value: "Backend", count: 2 },
      { field: "label", value: "urgent", count: 2 },
      { field: "component", value: "API", count: 1 },
      { field: "component", value: "Frontend", count: 1 },
      { field: "label", value: "ui", count: 1 },
    ]);
  });

  it("shows my open issues with the tag, newest first, and counts them; done, others' and hidden ones never", async () => {
    const { id } = await me.pinboard.createBoard({ name: "Backend", follow: { field: "component", value: "Backend" } });
    const notes = await me.pinboard.list({ boardId: id });
    expect(notes.map((n) => n.issueKey)).toEqual(["APP-2", "APP-1"]);
    // Laid out, never stored: negative ids, each on its own spot.
    expect(notes.every((n) => n.id < 0)).toBe(true);
    expect(new Set(notes.map((n) => `${n.x},${n.y}`)).size).toBe(2);
    expect((await me.pinboard.boards()).find((b) => b.id === id)).toMatchObject({ count: 2, hidden: 0, follow: { field: "component", value: "Backend", connectionId: null } });
    // Done on the tracker: it leaves at the next read.
    await q("UPDATE issues SET category = 'done' WHERE key = 'APP-2'");
    expect((await me.pinboard.list({ boardId: id })).map((n) => n.issueKey)).toEqual(["APP-1"]);
    await q("UPDATE issues SET category = 'todo' WHERE key = 'APP-2'");
  });

  it("a label on every tracker, or on one", async () => {
    const all = await me.pinboard.createBoard({ name: "Urgent", follow: { field: "label", value: "urgent" } });
    expect((await me.pinboard.list({ boardId: all.id })).map((n) => n.issueKey)).toEqual(["acme/web#1", "APP-1"]);
    const one = await me.pinboard.createBoard({ name: "Urgent on GitHub", follow: { field: "label", value: "urgent", connectionId: gh } });
    expect((await me.pinboard.list({ boardId: one.id })).map((n) => n.issueKey)).toEqual(["acme/web#1"]);
    await expect(other.pinboard.createBoard({ name: "x", follow: { field: "label", value: "urgent", connectionId: gh } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is read-only: a pin lands on a board pinned by hand, Undo and the pin menu skip it", async () => {
    const followed = (await me.pinboard.boards()).find((b) => b.follow?.value === "Backend")!;
    const pinned = await me.pinboard.add({ boardId: followed.id, issueKey: "APP-6", connectionId: jira });
    expect(pinned.boardId).not.toBe(followed.id);
    expect((await me.pinboard.list({ boardId: followed.id })).some((n) => n.issueKey === "APP-6")).toBe(false);
    await expect(
      me.pinboard.restore({ boardId: followed.id, issueKey: "APP-6", connectionId: jira, note: "", color: "yellow", x: 0, y: 0, rotation: 0 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const where = await me.pinboard.where({ issueKey: "APP-6", connectionId: jira });
    expect(where.boards.some((b) => b.id === followed.id)).toBe(false);
    // A shown post-it is nothing to remove, write on, or move without its board.
    const [shown] = await me.pinboard.list({ boardId: followed.id });
    await expect(me.pinboard.update({ id: shown.id, x: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(me.pinboard.update({ id: shown.id, boardId: followed.id, note: "x" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(me.pinboard.remove({ id: shown.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("on a followed board the user still moves and recolours: kept per issue, the rest laid out around", async () => {
    const followed = (await me.pinboard.boards()).find((b) => b.follow?.value === "Backend")!;
    const before = await me.pinboard.list({ boardId: followed.id });
    const [first, second] = before;
    await me.pinboard.update({ id: second.id, boardId: followed.id, x: 900, y: 500, toFront: true });
    await me.pinboard.update({ id: first.id, boardId: followed.id, color: "blue" });
    const after = await me.pinboard.list({ boardId: followed.id });
    // Same ids (the issues'), the moved one where it was left and on top, the recoloured one in place.
    expect(after.map((n) => n.id).sort()).toEqual(before.map((n) => n.id).sort());
    const moved = after.find((n) => n.id === second.id)!;
    expect(moved).toMatchObject({ x: 900, y: 500 });
    expect(after.find((n) => n.id === first.id)).toMatchObject({ x: first.x, y: first.y, color: "blue" });
    expect(Math.max(...after.map((n) => n.z))).toBe(moved.z);
    // Nothing became pinned: the pin menu and the count know only the tag.
    expect((await me.pinboard.where({ issueKey: second.issueKey!, connectionId: jira })).boards.some((b) => b.id === followed.id)).toBe(false);
    expect((await me.pinboard.boards()).find((b) => b.id === followed.id)?.count).toBe(2);
    // Someone else's board, or a board pinned by hand: not this way.
    const free = (await me.pinboard.boards()).find((b) => !b.follow)!;
    await expect(me.pinboard.update({ id: second.id, boardId: free.id, x: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.pinboard.update({ id: second.id, boardId: followed.id, x: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("one board pinned by hand always stays", async () => {
    const boards = await me.pinboard.boards();
    const free = boards.filter((b) => !b.follow);
    expect(free).toHaveLength(1);
    await expect(me.pinboard.deleteBoard({ id: free[0].id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const followed = boards.find((b) => b.follow)!;
    await me.pinboard.deleteBoard({ id: followed.id });
    // Two deletes at once never leave none: one is refused.
    const { id: second } = await me.pinboard.createBoard({ name: "Second" });
    const both = await Promise.allSettled([me.pinboard.deleteBoard({ id: free[0].id }), me.pinboard.deleteBoard({ id: second })]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await me.pinboard.boards()).filter((b) => !b.follow)).toHaveLength(1);
  });

  it("a post-it moves or is copied to another board, never doubled there, never onto a followed board", async () => {
    const a = await me.pinboard.createBoard({ name: "A" });
    const b = await me.pinboard.createBoard({ name: "B" });
    const on = async (boardId: number) => (await me.pinboard.list({ boardId })).map((n) => n.issueKey ?? n.note).sort();
    const issue = await me.pinboard.add({ boardId: a.id, issueKey: "APP-1", connectionId: jira, note: "check logs", color: "pink" });
    const free = await me.pinboard.add({ boardId: a.id, note: "call Anna" });
    // Copied: on both, with its note and colour.
    const copied = await me.pinboard.copy({ id: issue.id, boardId: b.id, move: false });
    expect(copied).toMatchObject({ existed: false, boardId: b.id, removed: null });
    expect(await on(a.id)).toEqual(["APP-1", "call Anna"]);
    expect((await me.pinboard.list({ boardId: b.id }))[0]).toMatchObject({ issueKey: "APP-1", note: "check logs", color: "pink" });
    // Again: the one there comes forward, no double.
    expect(await me.pinboard.copy({ id: issue.id, boardId: b.id, move: false })).toMatchObject({ id: copied.id, existed: true });
    expect(await on(b.id)).toEqual(["APP-1"]);
    // Moved: off A, onto B; Undo has what was taken away.
    const moved = await me.pinboard.copy({ id: free.id, boardId: b.id, move: true });
    expect(moved.removed).toMatchObject({ id: free.id, note: "call Anna", boardId: a.id });
    expect(await on(a.id)).toEqual(["APP-1"]);
    expect(await on(b.id)).toEqual(["APP-1", "call Anna"]);
    // Moving the issue where it already is: one there, none left here.
    await me.pinboard.copy({ id: issue.id, boardId: b.id, move: true });
    expect(await on(a.id)).toEqual([]);
    expect(await on(b.id)).toEqual(["APP-1", "call Anna"]);
    // Not onto the same board, a followed one, someone else's; not someone else's post-it.
    await expect(me.pinboard.copy({ id: copied.id, boardId: b.id, move: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const followed = await me.pinboard.createBoard({ name: "API", follow: { field: "component", value: "API" } });
    await expect(me.pinboard.copy({ id: copied.id, boardId: followed.id, move: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const theirs = await other.pinboard.createBoard({ name: "Theirs" });
    await expect(me.pinboard.copy({ id: copied.id, boardId: theirs.id, move: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.pinboard.copy({ id: copied.id, boardId: theirs.id, move: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
