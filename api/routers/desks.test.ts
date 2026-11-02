import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
// Nothing here asks a tracker.
vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errorMessages: ["unexpected call"] }), { status: 500 }));

/** A slot as its issue key, "_" when empty. */
const slotKey = (slot: { key: string } | { empty: true }) => ("empty" in slot ? "_" : slot.key);

describe("the current desk", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let ann: Caller;
  let bob: Caller;
  let conn = 0;
  let bobConn = 0;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [a] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('ann', 'Ann', 1) RETURNING id");
    const [b] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('bob', 'Bob', 1) RETURNING id");
    const connection = (user: number) =>
      q<{ id: number }>(
        "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://x.atlassian.net', 'me', ?, 'x', 1) RETURNING id",
        user,
        JSON.stringify({ deployment: "cloud", authType: "basic", username: "me@x.it" }),
      );
    conn = (await connection(a.id))[0].id;
    bobConn = (await connection(b.id))[0].id;
    for (let n = 1; n <= 7; n++)
      await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 'S', 'To Do', 'APP', 'App', 'u', 1)", a.id, conn, `${100 + n}`, `APP-${n}`);
    await q("INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, '900', 'BOB-1', 'S', 'To Do', 'BOB', 'Bob', 'u', 1)", b.id, bobConn);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const as = async (id: number) => {
      const [user] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    };
    ann = await as(a.id);
    bob = await as(b.id);
  });

  it("starts empty and stores what it is sent made safe, one row per user", async () => {
    expect((await ann.desks.current()).panes).toEqual([]);
    const pane = (n: number) => ({ connectionId: conn, key: `APP-${n}`, remoteId: `${100 + n}` });
    const saved = await ann.desks.setCurrent({
      layout: { v: 1, preset: "quad", tracks: { "cols-2": { cols: [0.99, 0.01], rows: [1] } }, panes: [pane(1), pane(1), pane(2)], parked: [], maximized: "nope", compare: false, onlyDifferences: false, noteId: null },
    });
    expect(saved.panes.map(slotKey)).toEqual(["APP-1", "APP-2"]);
    expect(saved.preset).toBe("cols-2");
    expect(saved.tracks["cols-2"]?.cols[1]).toBeCloseTo(0.15);
    expect(saved.maximized).toBeNull();
    await ann.desks.setCurrent({ layout: { ...saved, preset: "rows-2" } });
    expect((await ann.desks.current()).preset).toBe("rows-2");
    expect(await q("SELECT count(*)::int AS n FROM desks WHERE name IS NULL")).toEqual([{ n: 1 }]);
    // Six panes in an arrangement of six are kept; an arrangement this version doesn't know is read as the default.
    const six = await ann.desks.setCurrent({ layout: { ...saved, preset: "grid-2x3", panes: [1, 2, 3, 4, 5, 6].map(pane) } });
    expect(six.preset).toBe("grid-2x3");
    expect(six.panes).toHaveLength(6);
    expect((await ann.desks.setCurrent({ layout: { ...six, preset: "from-the-future" } })).preset).toBe("grid-3x2");
    // Garbage is an empty desk, not an error.
    expect((await ann.desks.setCurrent({ layout: "junk" })).panes).toEqual([]);
  });

  it("adds an issue once; a full desk parks its last pane", async () => {
    await ann.desks.setCurrent({ layout: null });
    const first = await ann.desks.add({ connectionId: conn, key: "app-1" });
    expect(first.layout.panes).toEqual([{ connectionId: conn, key: "APP-1", remoteId: "101" }]);
    expect(await ann.desks.add({ connectionId: conn, key: "APP-1" })).toMatchObject({ already: true, full: false, layout: { panes: [{ key: "APP-1" }] } });
    for (const n of [2, 3, 4, 5, 6]) expect((await ann.desks.add({ key: `APP-${n}` })).full).toBe(false);
    const seventh = await ann.desks.add({ connectionId: conn, key: "APP-7" });
    expect(seventh).toMatchObject({ full: true, parked: "APP-6", count: 6 });
    expect(seventh.layout.panes.map(slotKey)).toEqual(["APP-1", "APP-2", "APP-3", "APP-4", "APP-5", "APP-7"]);
    expect(seventh.layout.parked.map(p => p.key)).toEqual(["APP-6"]);
    expect(seventh.layout.preset).toBe("grid-3x2");
  });

  it("follows an issue renamed since (by its identity), stored and old keys alike", async () => {
    await ann.desks.setCurrent({ layout: null });
    await ann.desks.add({ connectionId: conn, key: "APP-6" });
    await q("UPDATE issues SET key = 'NEW-6' WHERE jira_id = '106'");
    // (A trigger keeps the old key as an alias.)
    expect(await q("SELECT a.key FROM item_aliases a JOIN issues i ON i.id = a.item_id WHERE i.jira_id = '106'")).toEqual([{ key: "APP-6" }]);
    expect((await ann.desks.current()).panes.map(slotKey)).toEqual(["NEW-6"]);
    expect((await ann.desks.add({ connectionId: conn, key: "APP-6" })).layout.panes.map(slotKey)).toEqual(["NEW-6"]);
  });

  it("fills the first empty slot, finds an issue by its identity, and keeps empty slots when keys are refreshed", async () => {
    const empty = (id: string) => ({ empty: true, id });
    const base = { v: 1, tracks: {}, parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null };
    await ann.desks.setCurrent({ layout: { ...base, preset: "quad", panes: [{ connectionId: conn, key: "APP-1", remoteId: "101" }, empty("1"), { connectionId: conn, key: "APP-6", remoteId: "106" }, empty("2")] } });
    // Read back: the renamed one under its key today, the empty slots where they were.
    expect((await ann.desks.current()).panes).toEqual([{ connectionId: conn, key: "APP-1", remoteId: "101" }, empty("1"), { connectionId: conn, key: "NEW-6", remoteId: "106" }, empty("2")]);
    const added = await ann.desks.add({ connectionId: conn, remoteId: "102" });
    expect(added).toMatchObject({ key: "APP-2", already: false, full: false });
    expect(added.layout.panes.map(slotKey)).toEqual(["APP-1", "APP-2", "NEW-6", "_"]);
    expect(added.layout.preset).toBe("quad");
    expect((await ann.desks.add({ connectionId: conn, key: "APP-3" })).full).toBe(false);
    for (const key of ["APP-4", "APP-5"]) expect((await ann.desks.add({ connectionId: conn, key })).full).toBe(false);
    expect((await ann.desks.add({ connectionId: conn, key: "APP-7" })).full).toBe(true);
    await expect(ann.desks.add({ connectionId: conn, remoteId: "999" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ann.desks.add({ connectionId: bobConn, remoteId: "900" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ann.desks.setCurrent({ layout: null });
    await ann.desks.add({ connectionId: conn, key: "NEW-6" });
  });

  it("is private: nobody else reads it, or puts their issue on someone's connection", async () => {
    expect((await bob.desks.current()).panes).toEqual([]);
    await bob.desks.setCurrent({ layout: { v: 1, preset: "single", tracks: {}, panes: [{ connectionId: bobConn, key: "BOB-1", remoteId: "900" }], parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null } });
    expect((await ann.desks.current()).panes.map(slotKey)).toEqual(["NEW-6"]);
    await expect(ann.desks.add({ connectionId: bobConn, key: "BOB-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(bob.desks.add({ connectionId: conn, key: "APP-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await q("SELECT count(*)::int AS n FROM desks WHERE name IS NULL")).toEqual([{ n: 2 }]);
  });
});
