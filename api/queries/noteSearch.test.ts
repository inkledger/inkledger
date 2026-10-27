import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("./connection").q = async (text, ...params) => (await import("./connection")).q(text, ...params);

describe("Markdown note derived text and search", () => {
  let userId = 0;
  let otherId = 0;

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('notes-search', 'N', 1) RETURNING id");
    const [o] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('notes-other', 'O', 1) RETURNING id");
    userId = u.id;
    otherId = o.id;
  });

  beforeEach(async () => {
    await q("DELETE FROM markdown_notes");
  });

  const create = async (title: string, body: string, uid = userId) => {
    const { createNote } = await import("./notes");
    return createNote(uid, { title, body, parentId: null, issue: null });
  };
  const search = async (query: string, options: { limit?: number; cursor?: string; filter?: "all" | "free" | "linked" } = {}) => {
    const { searchNotes } = await import("./noteSearch");
    return searchNotes(userId, { query, filter: options.filter ?? "all", limit: options.limit ?? 30, cursor: options.cursor });
  };

  it("derives visible text, preserves paragraphs and folds accents, case and whitespace", async () => {
    const { noteDerived, normalizeNoteSearch, noteSnippet } = await import("./noteSearch");
    const source = "# Caffè\n\n[Appunti](https://secret.example/path) e `Codice`";
    const derived = noteDerived("  CAFFE\u0301  ", source);
    expect(derived.bodyText).toBe("Caffè\n\nAppunti e Codice");
    expect(derived.searchTitle).toBe("caffe");
    expect(derived.searchText).toBe("caffe appunti e codice");
    expect(derived.searchText).not.toContain("secret.example");
    expect(normalizeNoteSearch("CAFFE\u0301")).toBe("caffe");
    expect(noteSnippet("Primo paragrafo\n\nSecondo", "secondo")).toBe("Primo paragrafo Secondo");
  });

  it("searches prefixes with AND, not URLs or another user's notes", async () => {
    await create("Caffè", "Appunti di **lavoro**");
    await create("Altro", "caffe senza note");
    await create("Caffè", "appunti", otherId);
    expect((await search("caffe app")).results.map((r) => r.title)).toEqual(["Caffè"]);
    expect((await search("CAFFE\u0301")).results).toHaveLength(2);
    expect((await search("lavoro")).results).toHaveLength(1);
    expect((await search("https://secret.example")).results).toEqual([]);
    expect((await search("!!")).results).toEqual([]);
  });

  it("ranks titles first and keeps cursor membership stable across edits and deletes", async () => {
    const bodyMatch = await create("Z", "appunti");
    const first = await create("Appunti", "x");
    const second = await create("Appunti due", "x");
    await q("UPDATE markdown_notes SET updated_at = 1 WHERE id = ?", bodyMatch.id);
    await q("UPDATE markdown_notes SET updated_at = 2 WHERE id = ?", second.id);
    await q("UPDATE markdown_notes SET updated_at = 3 WHERE id = ?", first.id);
    const page = await search("app", { limit: 2 });
    expect(page.results.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(page.nextCursor).not.toBeNull();
    await q("UPDATE markdown_notes SET title = 'Appunti zero', search_title = 'appunti zero', updated_at = 100 WHERE id = ?", bodyMatch.id);
    await q("UPDATE markdown_notes SET deleted_at = 10, delete_batch = gen_random_uuid(), delete_root_id = id WHERE id = ?", second.id);
    const next = await search("app", { limit: 2, cursor: page.nextCursor! });
    expect(next.results.map((r) => r.id)).toEqual([bodyMatch.id]);
    expect(next.nextCursor).toBeNull();
  });

  it("rejects a cursor reused with another query", async () => {
    await create("Appunti", "x");
    const page = await search("app", { limit: 1 });
    const cursor = page.nextCursor;
    if (cursor) await expect(search("caffe", { cursor })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { encodeNoteCursor, decodeNoteCursor } = await import("./noteSearch");
    const encoded = encodeNoteCursor({ v: 1, fingerprint: "0".repeat(64), ids: [], offset: 0 });
    expect(() => decodeNoteCursor(encoded, { query: "app", filter: "all" })).toThrow();
  });
});
