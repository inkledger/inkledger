import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("./connection").q = async (text, ...params) => (await import("./connection")).q(text, ...params);

describe("Markdown note tree invariants, trash and version retention", () => {
  let userId = 0;
  let otherId = 0;

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('notes-tree', 'N', 1) RETURNING id");
    const [o] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('notes-tree-other', 'O', 1) RETURNING id");
    userId = u.id;
    otherId = o.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM markdown_notes");
  });

  const create = async (parentId: string | null = null, title = "n") => {
    const { createNote } = await import("./notes");
    return createNote(userId, { title, body: "body", parentId, issue: null });
  };

  it("serializes concurrent creates and move pairs without duplicate positions or cycles", async () => {
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => create(null, `n${i}`)));
    expect(new Set(made.map((n) => n.position)).size).toBe(8);
    const [a, b] = made;
    const { moveNote } = await import("./notes");
    const results = await Promise.allSettled([moveNote(userId, a.id, b.id, 0), moveNote(userId, b.id, a.id, 0)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await q("SELECT count(*)::int AS n FROM markdown_notes WHERE parent_id = id")).toEqual([{ n: 0 }]);
  });

  it("rejects self-parent, descendants and depth beyond 32; move does not change content revision", async () => {
    const root = await create();
    const child = await create(root.id);
    const { moveNote } = await import("./notes");
    await expect(moveNote(userId, root.id, root.id, 0)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(moveNote(userId, root.id, child.id, 0)).rejects.toMatchObject({ code: "CONFLICT" });
    const moved = await moveNote(userId, child.id, null, 0);
    expect(moved.contentRevision).toBe(child.contentRevision);
    expect((await q<{ position: number }>("SELECT position FROM markdown_notes WHERE id = ?", child.id))[0].position).toBe(0);
    let parent = await create(null, "deep");
    for (let depth = 1; depth <= 32; depth++) parent = await create(parent.id, "deep");
    await expect(create(parent.id, "too deep")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("keeps nested delete batches independent and restores to root only on request", async () => {
    const root = await create(null, "root");
    const child = await create(root.id, "child");
    const grand = await create(child.id, "grand");
    const { deleteNote, restoreNoteBatch } = await import("./notes");
    const inner = await deleteNote(userId, child.id);
    expect(inner.count).toBe(2);
    const outer = await deleteNote(userId, root.id);
    expect(outer.count).toBe(1);
    await expect(restoreNoteBatch(userId, inner.batch, false)).rejects.toMatchObject({ code: "CONFLICT" });
    const restoredInner = await restoreNoteBatch(userId, inner.batch, true);
    expect(restoredInner.ids).toHaveLength(2);
    expect((await q<{ parent_id: string | null; content_revision: number }>("SELECT parent_id, content_revision FROM markdown_notes WHERE id = ?", child.id))[0]).toEqual({ parent_id: null, content_revision: child.contentRevision + 1 });
    expect((await q<{ content_revision: number }>("SELECT content_revision FROM markdown_notes WHERE id = ?", grand.id))[0].content_revision).toBe(grand.contentRevision + 1);
  });

  it("purges expired trash without cutting a newer batch linked by a parent", async () => {
    const root = await create(null, "root");
    const child = await create(root.id, "child");
    const { deleteNote, purgeMarkdownNotes } = await import("./notes");
    const inner = await deleteNote(userId, child.id);
    const outer = await deleteNote(userId, root.id);
    const now = Date.now();
    await q("UPDATE markdown_notes SET deleted_at = ? WHERE delete_batch = ?", now - 31 * 86_400_000, outer.batch);
    await q("UPDATE markdown_notes SET deleted_at = ? WHERE delete_batch = ?", now - 2 * 86_400_000, inner.batch);
    expect(await purgeMarkdownNotes(now)).toBe(0);
    await q("UPDATE markdown_notes SET deleted_at = ? WHERE delete_batch = ?", now - 31 * 86_400_000, inner.batch);
    expect(await purgeMarkdownNotes(now)).toBe(2);
    expect(await q("SELECT count(*)::int AS n FROM markdown_notes")).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM markdown_note_versions")).toEqual([{ n: 0 }]);
  });

  it("enforces parent ownership in the database", async () => {
    const parent = await create();
    await expect(
      q("INSERT INTO markdown_notes (user_id, parent_id, title, body, created_at, updated_at) VALUES (?, ?, 'x', '', 1, 1)", otherId, parent.id),
    ).rejects.toThrow(/markdown_notes_parent_user_fk/);
  });

  it("retains 50 versions for 30 days, discarding automatic snapshots first", async () => {
    const note = await create();
    const { getDb } = await import("./connection");
    const { markdownNoteVersions } = await import("@db/schema");
    const { pruneNoteVersions, ownNote } = await import("./notes");
    const now = new Date();
    await getDb().transaction(async (tx) => {
      await tx.insert(markdownNoteVersions).values(
        Array.from({ length: 51 }, (_, i) => ({ noteId: note.id, userId, title: `v${i}`, body: "", contentRevision: i + 1, origin: "manual", createdAt: new Date(now.getTime() - (51 - i) * 1000) })),
      );
      await pruneNoteVersions(tx, userId, note.id, now);
    });
    expect(await q("SELECT count(*)::int AS n FROM markdown_note_versions")).toEqual([{ n: 50 }]);
    expect(await q("SELECT count(*)::int AS n FROM markdown_note_versions WHERE title = 'v0'")).toEqual([{ n: 0 }]);
    await getDb().transaction(async (tx) => {
      await tx.insert(markdownNoteVersions).values({ noteId: note.id, userId, title: "auto", body: "", contentRevision: 52, origin: "auto", createdAt: now });
      await pruneNoteVersions(tx, userId, note.id, now);
      expect((await ownNote(tx, userId, note.id)).id).toBe(note.id);
    });
    expect(await q("SELECT count(*)::int AS n FROM markdown_note_versions WHERE origin = 'auto'")).toEqual([{ n: 0 }]);
    await q("UPDATE markdown_note_versions SET created_at = ? WHERE title = 'v1'", now.getTime() - 31 * 86_400_000);
    await getDb().transaction(async (tx) => pruneNoteVersions(tx, userId, note.id, now));
    expect(await q("SELECT count(*)::int AS n FROM markdown_note_versions WHERE title = 'v1'")).toEqual([{ n: 0 }]);
  });
});
