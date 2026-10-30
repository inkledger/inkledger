import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) =>
  (await import("../queries/connection")).q(text, ...params);

describe("notes: a day of their own, searched by date", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let me: Caller;
  let other: Caller;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('notes-dates', 'N', 1) RETURNING id");
    const [o] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('notes-dates-other', 'O', 1) RETURNING id");
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const make = async (id: number) => {
      const [user] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    };
    me = await make(u.id);
    other = await make(o.id);
  });

  beforeEach(async () => {
    await q("DELETE FROM markdown_notes");
  });

  it("a note is dated (the browser's day when given), a folder never", async () => {
    const note = await me.notes.create({ title: "Kickoff", body: "agenda", notedOn: "2026-10-29" });
    expect(note.notedOn).toBe("2026-10-29");
    const today = await me.notes.create({ title: "Today", body: "x" });
    expect(today.notedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const folder = await me.notes.createFolder({ title: "Clients" });
    expect(folder.notedOn).toBeNull();
    const tree = await me.notes.tree();
    expect(tree.find(n => n.id === note.id)?.notedOn).toBe("2026-10-29");
  });

  it("changing the day keeps the revision: the open editor's next save doesn't conflict", async () => {
    const note = await me.notes.create({ title: "Retro", body: "x", notedOn: "2026-10-01" });
    await me.notes.setDate({ id: note.id, notedOn: "2026-10-02" });
    const saved = await me.notes.updateContent({ id: note.id, title: "Retro", body: "y", expectedRevision: note.contentRevision });
    expect(saved.status).toBe("updated");
    expect((await me.notes.get({ id: note.id })).notedOn).toBe("2026-10-02");
    await expect(other.notes.setDate({ id: note.id, notedOn: "2026-10-03" })).rejects.toThrow();
  });

  it("dates alone find the notes of those days, latest day first; with words, both apply", async () => {
    await me.notes.create({ title: "Call MrCall", body: "riassunto chiamata", notedOn: "2026-10-28" });
    await me.notes.create({ title: "Standup", body: "riassunto standup", notedOn: "2026-10-29" });
    await me.notes.create({ title: "Old", body: "riassunto vecchio", notedOn: "2026-09-01" });
    const days = await me.notes.search({ query: "", dates: [{ field: "noted", from: "2026-10-28", to: "2026-10-30" }] });
    expect(days.results.map(r => r.title)).toEqual(["Standup", "Call MrCall"]);
    expect(days.results[0].notedOn).toBe("2026-10-29");
    const both = await me.notes.search({ query: "chiamata", dates: [{ field: "noted", from: "2026-10-28", to: "2026-10-30" }] });
    expect(both.results.map(r => r.title)).toEqual(["Call MrCall"]);
    const created = await me.notes.search({ query: "riassunto", dates: [{ field: "created", from: new Date(Date.now() - 60_000).toISOString() }] });
    expect(created.results).toHaveLength(3);
    // Neither words nor dates: refused, as before.
    await expect(me.notes.search({ query: "a" })).rejects.toThrow();
    // Other users' notes never show.
    expect((await other.notes.search({ query: "", dates: [{ field: "noted", from: "2026-01-01" }] })).results).toEqual([]);
  });

  it("a page cursor belongs to its dates", async () => {
    for (let i = 0; i < 3; i++) await me.notes.create({ title: `N${i}`, body: "x", notedOn: "2026-10-2" + i });
    const first = await me.notes.search({ query: "", dates: [{ field: "noted", from: "2026-10-20" }], limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    await expect(me.notes.search({ query: "", dates: [{ field: "noted", from: "2026-10-21" }], cursor: first.nextCursor!, limit: 1 })).rejects.toThrow();
  });
});
