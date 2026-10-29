import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) =>
  (await import("../queries/connection")).q(text, ...params);

describe("notes in folders", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let me: Caller;
  let other: Caller;
  let connectionId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('folders', 'F', 1) RETURNING id");
    const [o] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('folders-other', 'O', 1) RETURNING id");
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://folders.example', 'me', 'x', 1) RETURNING id",
      u.id,
    );
    connectionId = c.id;
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'i1', 'APP-1', 'One', 'To Do', 'APP', 'App', 'u', 1)",
      u.id,
      c.id,
    );
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

  const titles = async (parentId: string | null) =>
    (await me.notes.tree()).filter(n => n.parentId === parentId).map(n => `${n.kind}:${n.title}`);

  it("makes folders at the root and in folders, listed before the notes beside them", async () => {
    await me.notes.create({ title: "Loose note", body: "" });
    const work = await me.notes.createFolder({ title: "Work", parentId: null });
    const meetings = await me.notes.createFolder({ title: "Meetings", parentId: work.id });
    await me.notes.create({ title: "Plan", body: "x", parentId: work.id });
    expect(work.kind).toBe("folder");
    expect(await titles(null)).toEqual(["folder:Work", "note:Loose note"]);
    expect(await titles(work.id)).toEqual(["folder:Meetings", "note:Plan"]);
    expect(meetings.parentId).toBe(work.id);
  });

  it("never puts a folder in a note, while notes still hold notes", async () => {
    const page = await me.notes.create({ title: "Project X", body: "text" });
    await expect(me.notes.createFolder({ title: "Inside", parentId: page.id })).rejects.toThrow(/A folder can't go inside a note/);
    const child = await me.notes.create({ title: "Sub-page", body: "", parentId: page.id });
    expect(child.parentId).toBe(page.id);
    const folder = await me.notes.createFolder({ title: "Box", parentId: null });
    await expect(me.notes.move({ id: folder.id, parentId: page.id, index: 0 })).rejects.toThrow(/A folder can't go inside a note/);
    await me.notes.move({ id: page.id, parentId: folder.id, index: 0 });
    expect(await titles(folder.id)).toEqual(["note:Project X"]);
  });

  it("refuses a folder without a name", async () => {
    await expect(me.notes.createFolder({ title: "   ", parentId: null })).rejects.toThrow();
  });

  it("renames a note or a folder over the revision it was shown with", async () => {
    const folder = await me.notes.createFolder({ title: "Old", parentId: null });
    const renamed = await me.notes.rename({ id: folder.id, title: "New", expectedRevision: folder.contentRevision });
    expect(renamed.status).toBe("updated");
    const note = await me.notes.create({ title: "Draft", body: "keep me" });
    const first = await me.notes.rename({ id: note.id, title: "Final", expectedRevision: note.contentRevision });
    expect(first.status === "updated" && first.note.body).toBe("keep me");
    const stale = await me.notes.rename({ id: note.id, title: "Again", expectedRevision: note.contentRevision });
    expect(stale.status).toBe("conflict");
    await expect(me.notes.rename({ id: note.id, title: " ", expectedRevision: note.contentRevision + 1 })).rejects.toThrow();
    expect((await titles(null)).sort()).toEqual(["folder:New", "note:Final"]);
  });

  it("keeps a folder a folder: no text, no issue", async () => {
    const folder = await me.notes.createFolder({ title: "Box", parentId: null });
    await expect(me.notes.updateContent({ id: folder.id, title: "Box", body: "text", expectedRevision: folder.contentRevision })).rejects.toThrow(/A folder has no text/);
    await expect(me.notes.setIssue({ id: folder.id, issue: { connectionId, issueKey: "APP-1" } })).rejects.toThrow(/A folder can't be linked to an issue/);
  });

  it("turns an empty note into a folder, never one with text, an issue, or inside a note", async () => {
    const empty = await me.notes.create({ title: "Area", body: "" });
    await me.notes.create({ title: "Child", body: "", parentId: empty.id });
    expect((await me.notes.convertToFolder({ id: empty.id })).kind).toBe("folder");
    const written = await me.notes.create({ title: "Written", body: "words" });
    await expect(me.notes.convertToFolder({ id: written.id })).rejects.toThrow(/Only a note without text/);
    const linked = await me.notes.create({ title: "Linked", body: "", issue: { connectionId, issueKey: "APP-1" } });
    await expect(me.notes.convertToFolder({ id: linked.id })).rejects.toThrow(/linked to an issue/);
    const page = await me.notes.create({ title: "Page", body: "x" });
    const inner = await me.notes.create({ title: "Inner", body: "", parentId: page.id });
    await expect(me.notes.convertToFolder({ id: inner.id })).rejects.toThrow(/A folder can't go inside a note/);
  });

  it("keeps folders first when moving: a note never lands among them, a folder never among the notes", async () => {
    const root = await me.notes.createFolder({ title: "Root", parentId: null });
    const a = await me.notes.createFolder({ title: "A", parentId: root.id });
    await me.notes.createFolder({ title: "B", parentId: root.id });
    const n1 = await me.notes.create({ title: "n1", body: "", parentId: root.id });
    await me.notes.create({ title: "n2", body: "", parentId: root.id });
    await me.notes.move({ id: n1.id, parentId: root.id, index: 0 });
    expect(await titles(root.id)).toEqual(["folder:A", "folder:B", "note:n1", "note:n2"]);
    await me.notes.move({ id: a.id, parentId: root.id, index: 4 });
    expect(await titles(root.id)).toEqual(["folder:B", "folder:A", "note:n1", "note:n2"]);
    await me.notes.move({ id: n1.id, parentId: root.id, index: 4 });
    expect(await titles(root.id)).toEqual(["folder:B", "folder:A", "note:n2", "note:n1"]);
  });

  it("finds folders by name in search, with their kind", async () => {
    const work = await me.notes.createFolder({ title: "Quarterly meetings", parentId: null });
    await me.notes.create({ title: "Agenda", body: "quarterly numbers", parentId: work.id });
    const found = await me.notes.search({ query: "quarterly", filter: "all", limit: 30 });
    expect(found.results.map(r => `${r.kind}:${r.title}`).sort()).toEqual(["folder:Quarterly meetings", "note:Agenda"]);
  });

  it("sends a folder to the trash with what it holds, and brings it all back", async () => {
    const folder = await me.notes.createFolder({ title: "Box", parentId: null });
    await me.notes.create({ title: "Inside", body: "x", parentId: folder.id });
    const { batch, count } = await me.notes.remove({ id: folder.id });
    expect(count).toBe(2);
    expect(await me.notes.tree()).toEqual([]);
    await me.notes.restore({ batch });
    expect((await me.notes.tree()).map(n => `${n.kind}:${n.title}`).sort()).toEqual(["folder:Box", "note:Inside"]);
  });

  it("another user's folders are not found", async () => {
    const folder = await me.notes.createFolder({ title: "Mine", parentId: null });
    await expect(other.notes.createFolder({ title: "Theirs", parentId: folder.id })).rejects.toThrow(/Note not found/);
    await expect(other.notes.rename({ id: folder.id, title: "Taken", expectedRevision: folder.contentRevision })).rejects.toThrow(/Note not found/);
    await expect(other.notes.convertToFolder({ id: folder.id })).rejects.toThrow(/Note not found/);
  });
});
