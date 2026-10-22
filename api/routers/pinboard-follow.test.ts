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
    // A virtual post-it is nothing to move or remove.
    const [shown] = await me.pinboard.list({ boardId: followed.id });
    await expect(me.pinboard.update({ id: shown.id, x: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(me.pinboard.remove({ id: shown.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("one board pinned by hand always stays", async () => {
    const boards = await me.pinboard.boards();
    const free = boards.filter((b) => !b.follow);
    expect(free).toHaveLength(1);
    await expect(me.pinboard.deleteBoard({ id: free[0].id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const followed = boards.find((b) => b.follow)!;
    await me.pinboard.deleteBoard({ id: followed.id });
  });
});
