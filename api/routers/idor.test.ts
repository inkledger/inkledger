import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
// No tracker is ever reached: someone else's things are refused before any call.
vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errorMessages: ["unexpected call"] }), { status: 500 }));

/**
 * Every procedure that takes an id or a connection: one user can never read,
 * change or use another's (§4.11, IDOR). Bob owns everything here; Ann tries.
 */
describe("nobody reaches another user's things by id", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let ann: Caller;
  let bob: { conn: number; bucket: number; worklog: number; trash: number };
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [a] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('ann', 'Ann', 'member', 1) RETURNING id");
    const [b] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('bob', 'Bob', 'member', 1) RETURNING id");
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://bob.atlassian.net', 'bob', ?, 'x', 1) RETURNING id",
      b.id,
      JSON.stringify({ deployment: "cloud", authType: "basic", username: "bob@x.it" }),
    );
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", c.id), c.id);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, '100', 'BOB-1', 'Bob''s', 'To Do', 'BOB', 'Bob', 'u', 1)", b.id, c.id);
    const [w] = await q<{ id: number }>(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'BOB-1', 'local-x', 600, 1760000000000, 1) RETURNING id",
      b.id,
      c.id,
    );
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'BOB-1', 'local-y', 300, 1760000000000, 1)", b.id, c.id);
    await q("DELETE FROM worklogs WHERE jira_worklog_id = 'local-y'");
    const [tr] = await q<{ id: number }>("SELECT id FROM worklog_trash WHERE user_id = ?", b.id);
    const [bk] = await q<{ id: number }>("INSERT INTO buckets (user_id, name, position, created_at) VALUES (?, 'Bob', 0, 1) RETURNING id", b.id);
    bob = { conn: c.id, bucket: bk.id, worklog: w.id, trash: tr.id };
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, a.id));
    ann = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: "dev-ann" });
  });

  it("connections: test, containers, exclusions, rename, archive, reconnect", async () => {
    const id = bob.conn;
    const login = { siteUrl: "https://bob.atlassian.net", deployment: "cloud" as const, authType: "basic" as const, username: "bob@x.it", secret: "t" };
    for (const call of [
      () => ann.connections.test({ id }),
      () => ann.connections.containers({ id }),
      () => ann.connections.setExcluded({ id, keys: ["x/y"] }),
      () => ann.connections.rename({ id, label: "mine now" }),
      () => ann.connections.archive({ id }),
      () => ann.connections.reconnectJira({ id, ...login }),
      () => ann.issues.syncConnection({ id }),
      () => ann.issues.syncConnection({ id, reconcile: true }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await ann.connections.list()).toEqual([]);
    expect(await q("SELECT label, archived_at FROM connections WHERE id = ?", id)).toEqual([{ label: "", archived_at: null }]);
  });

  it("issues on someone else's connection: read, create, organize, comment, move", async () => {
    const on = { key: "BOB-1", connectionId: bob.conn };
    for (const call of [
      () => ann.issues.get(on),
      () => ann.issues.description(on),
      () => ann.issues.comments(on),
      () => ann.issues.transitions(on),
      () => ann.issues.toggleFavorite(on),
      () => ann.issues.setHidden({ ...on, hidden: true }),
      () => ann.issues.watch({ ...on, watch: true }),
      () => ann.issues.import(on),
      () => ann.issues.createTypes({ connectionId: bob.conn, container: "BOB" }),
      () => ann.issues.createIn({ connectionId: bob.conn, container: "BOB", title: "x" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await q("SELECT favorite, hidden, watching FROM issues WHERE key = 'BOB-1'")).toEqual([{ favorite: 0, hidden: 0, watching: 0 }]);
  });

  it("time: worklogs by id or on someone else's connection, the trash, timers and notes", async () => {
    const started = "2026-10-14T09:00:00+02:00";
    for (const call of [
      () => ann.worklogs.update({ id: bob.worklog, seconds: 60, started, comment: "" }),
      () => ann.worklogs.delete({ id: bob.worklog }),
      () => ann.worklogs.restore({ id: bob.trash }),
      () => ann.worklogs.create({ issueKey: "BOB-1", connectionId: bob.conn, seconds: 600, started, comment: "" }),
      () => ann.timers.start({ issueKey: "BOB-1", connectionId: bob.conn }),
      () => ann.issueNotes.list({ issueKey: "BOB-1", connectionId: bob.conn }),
      () => ann.issueNotes.add({ issueKey: "BOB-1", connectionId: bob.conn, body: "hi" }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await q("SELECT count(*)::int AS n FROM worklogs")).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM worklog_trash")).toEqual([{ n: 1 }]);
    expect(await q("SELECT count(*)::int AS n FROM timers")).toEqual([{ n: 0 }]);
    expect(await ann.worklogs.list()).toEqual([]);
    expect(await ann.worklogs.trash()).toEqual([]);
  });

  it("TODOs: someone else's by id, on someone else's issue, comment or private note", async () => {
    const [todo] = await q<{ id: number }>("INSERT INTO todos (user_id, text, position, created_at, updated_at) SELECT id, 'Bob''s', 0, 1, 1 FROM users WHERE username = 'bob' RETURNING id");
    const [note] = await q<{ id: number }>("INSERT INTO issue_notes (user_id, connection_id, issue_key, body, created_at, updated_at) SELECT id, ?, 'BOB-1', 'n', 1, 1 FROM users WHERE username = 'bob' RETURNING id", bob.conn);
    const today = "2026-10-23";
    for (const call of [
      () => ann.todos.update({ id: todo.id, text: "mine now" }),
      () => ann.todos.update({ id: todo.id, done: true }),
      () => ann.todos.remove({ id: todo.id }),
      () => ann.todos.reorder({ ids: [todo.id] }),
      () => ann.todos.dismissReminder({ id: todo.id, today }),
      () => ann.todos.add({ text: "x", issueKey: "BOB-1", connectionId: bob.conn }),
      () => ann.todos.add({ text: "x", issueKey: "BOB-1", connectionId: bob.conn, commentId: "10001", commentExcerpt: "hi" }),
      () => ann.todos.add({ text: "x", issueNoteId: note.id }),
      () => ann.todos.forIssue({ issueKey: "BOB-1", connectionId: bob.conn }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    for (const view of ["today", "upcoming", "someday", "done"] as const) expect(await ann.todos.list({ view, today })).toEqual([]);
    expect(await q("SELECT text, done_at FROM todos")).toEqual([{ text: "Bob's", done_at: null }]);
  });

  it("buckets: save over, delete, make active; a source on someone else's connection", async () => {
    // With a source of her own, saving over Bob's bucket still finds nothing.
    const [own] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) SELECT id, 'jira', 'https://ann.example', 'ann', '{}', 'x', 1 FROM users WHERE username = 'ann' RETURNING id");
    await expect(ann.buckets.save({ id: bob.bucket, name: "x", sources: [{ connectionId: own.id, containerId: null }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ann.buckets.delete({ id: bob.bucket })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ann.buckets.setActive({ id: bob.bucket })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ann.buckets.save({ name: "sneaky", sources: [{ connectionId: bob.conn, containerId: null }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT name FROM buckets")).toEqual([{ name: "Bob" }]);
  });
});
