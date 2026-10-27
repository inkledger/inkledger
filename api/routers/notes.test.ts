import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) =>
  (await import("../queries/connection")).q(text, ...params);

describe("notes tRPC router", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let me: Caller;
  let other: Caller;
  let userId = 0;
  let connectionId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>(
      "INSERT INTO users (username, display_name, created_at) VALUES ('notes-router', 'N', 1) RETURNING id"
    );
    const [o] = await q<{ id: number }>(
      "INSERT INTO users (username, display_name, created_at) VALUES ('notes-router-other', 'O', 1) RETURNING id"
    );
    userId = u.id;
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://notes.example', 'me', 'x', 1) RETURNING id",
      u.id
    );
    connectionId = c.id;
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'i1', 'APP-1', 'One', 'To Do', 'APP', 'App', 'u', 1)",
      u.id,
      c.id
    );
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const make = async (id: number) => {
      const [user] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({
        req: new Request("http://localhost/"),
        resHeaders: new Headers(),
        user,
        sessionId: null,
      });
    };
    me = await make(u.id);
    other = await make(o.id);
  });

  beforeEach(async () => {
    await q("DELETE FROM markdown_notes");
    await q("UPDATE issues SET key = 'APP-1' WHERE jira_id = 'i1'");
  });

  it("creates and reads one document without bodies in the tree, preserving Markdown byte-for-byte", async () => {
    const body = "# Titolo\n\n- [ ] uno  \n\nfine\n";
    const note = await me.notes.create({
      title: "",
      body,
      parentId: null,
      issue: null,
    });
    expect(note.contentRevision).toBe(1);
    expect(note.body).toBe(body);
    expect(note.doc.blocks.length).toBeGreaterThan(0);
    expect((await me.notes.get({ id: note.id })).body).toBe(body);
    const tree = await me.notes.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]).not.toHaveProperty("body");
    expect(tree[0]).not.toHaveProperty("bodyText");
    expect(tree[0]).not.toHaveProperty("searchText");
    await expect(
      me.notes.create({ title: " ", body: "\n", parentId: null, issue: null })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      me.notes.create({
        title: "",
        body: "x".repeat(65_001),
        parentId: null,
        issue: null,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(other.notes.get({ id: note.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("compare-and-swap lets only one save on a revision and returns the current conflict", async () => {
    const note = await me.notes.create({
      title: "before",
      body: "zero",
      parentId: null,
      issue: null,
    });
    const save = (title: string) =>
      me.notes.updateContent({
        id: note.id,
        title,
        body: "  body\n",
        expectedRevision: 1,
      });
    const results = await Promise.all([save("one"), save("two")]);
    expect(results.filter(r => r.status === "updated")).toHaveLength(1);
    const conflict = results.find(r => r.status === "conflict");
    expect(
      conflict?.status === "conflict" && conflict.current.contentRevision
    ).toBe(2);
    const current = await me.notes.get({ id: note.id });
    expect(current.body).toBe("  body\n");
    const stale = await me.notes.updateContent({
      id: note.id,
      title: "stale",
      body: "bad",
      expectedRevision: 1,
    });
    expect(stale.status).toBe("conflict");
    expect((await me.notes.get({ id: note.id })).title).toBe(current.title);
    expect(await me.notes.versions({ id: note.id })).toHaveLength(0);
  });

  it("links, filters and unlinks notes without changing content revision; issue rename and backfill follow", async () => {
    const free = await me.notes.create({
      title: "free",
      body: "appunti",
      parentId: null,
      issue: null,
    });
    const linked = await me.notes.create({
      title: "linked",
      body: "appunti",
      parentId: null,
      issue: { connectionId, issueKey: "APP-1" },
    });
    expect(
      (await me.notes.forIssue({ connectionId, issueKey: "APP-1" })).map(
        n => n.id
      )
    ).toEqual([linked.id]);
    expect(
      (
        await me.notes.search({ query: "appunti", filter: "free", limit: 30 })
      ).results.map(n => n.id)
    ).toEqual([free.id]);
    expect(
      (
        await me.notes.search({
          query: "appunti",
          filter: "linked",
          limit: 30,
          issue: { connectionId, issueKey: "APP-1" },
        })
      ).results.map(n => n.id)
    ).toEqual([linked.id]);
    expect(
      (
        await q<{ item_id: number }>(
          "SELECT item_id FROM markdown_notes WHERE id = ?",
          linked.id
        )
      )[0].item_id
    ).toBeGreaterThan(0);
    await q("UPDATE issues SET key = 'NEW-1' WHERE jira_id = 'i1'");
    expect(
      (
        await q<{ issue_key: string }>(
          "SELECT issue_key FROM markdown_notes WHERE id = ?",
          linked.id
        )
      )[0].issue_key
    ).toBe("NEW-1");
    await q("DELETE FROM issues WHERE jira_id = 'i1'");
    expect(
      (
        await q<{ item_id: number | null }>(
          "SELECT item_id FROM markdown_notes WHERE id = ?",
          linked.id
        )
      )[0].item_id
    ).toBeNull();
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, 'i1', 'NEW-1', 'One', 'To Do', 'APP', 'App', 'u', 1)",
      userId,
      connectionId
    );
    expect(
      (
        await q<{ item_id: number }>(
          "SELECT item_id FROM markdown_notes WHERE id = ?",
          linked.id
        )
      )[0].item_id
    ).toBeGreaterThan(0);
    const unlinked = await me.notes.setIssue({ id: linked.id, issue: null });
    expect(unlinked.contentRevision).toBe(linked.contentRevision);
    expect(unlinked.issueKey).toBeNull();
    await expect(
      other.notes.setIssue({
        id: linked.id,
        issue: { connectionId, issueKey: "APP-1" },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("soft-deletes a subtree, refuses autosave, and restores with a new revision", async () => {
    const root = await me.notes.create({
      title: "root",
      body: "appunti",
      parentId: null,
      issue: null,
    });
    const child = await me.notes.create({
      title: "child",
      body: "appunti",
      parentId: root.id,
      issue: null,
    });
    const removed = await me.notes.remove({ id: root.id });
    expect(removed.count).toBe(2);
    expect(await me.notes.tree()).toEqual([]);
    expect(
      (await me.notes.search({ query: "appunti", limit: 30 })).results
    ).toEqual([]);
    await expect(me.notes.get({ id: root.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      me.notes.updateContent({
        id: child.id,
        title: "x",
        body: "x",
        expectedRevision: 1,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      (await me.notes.trash()).find(b => b.batch === removed.batch)
    ).toMatchObject({ rootId: root.id, count: 2 });
    const restored = await me.notes.restore({
      batch: removed.batch,
      toRoot: false,
    });
    expect(restored.ids).toHaveLength(2);
    expect((await me.notes.get({ id: root.id })).contentRevision).toBe(2);
    expect((await me.notes.get({ id: child.id })).parentId).toBe(root.id);
    expect(await me.notes.versions({ id: root.id })).toHaveLength(0);
    expect(await me.notes.versions({ id: child.id })).toHaveLength(0);
    await expect(
      other.notes.restore({ batch: removed.batch, toRoot: false })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates versions only on request and restores them over the expected revision", async () => {
    const note = await me.notes.create({
      title: "v0",
      body: "zero",
      parentId: null,
      issue: null,
    });
    const one = await me.notes.updateContent({
      id: note.id,
      title: "v1",
      body: "one",
      expectedRevision: 1,
    });
    expect(one.status).toBe("updated");
    const two = await me.notes.updateContent({
      id: note.id,
      title: "v2",
      body: "two",
      expectedRevision: 2,
    });
    expect(two.status).toBe("updated");
    expect(await me.notes.versions({ id: note.id })).toHaveLength(0);
    const manual = await me.notes.saveVersion({ id: note.id });
    expect(manual.id).not.toBeNull();
    const manualVersion = (await me.notes.versions({ id: note.id })).find(
      v => v.id === manual.id
    )!;
    expect(manualVersion.title).toBe("v2");
    const stale = await me.notes.restoreVersion({
      id: note.id,
      versionId: manualVersion.id,
      expectedRevision: 2,
    });
    expect(stale.status).toBe("conflict");
    const restored = await me.notes.restoreVersion({
      id: note.id,
      versionId: manualVersion.id,
      expectedRevision: 3,
    });
    expect(restored.status).toBe("updated");
    expect(restored.status === "updated" && restored.note.contentRevision).toBe(
      4
    );
    expect(await me.notes.versions({ id: note.id })).toHaveLength(1);
    await expect(other.notes.versions({ id: note.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      other.notes.restoreVersion({
        id: note.id,
        versionId: manualVersion.id,
        expectedRevision: 4,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      other.notes.deleteVersion({ id: note.id, versionId: manualVersion.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await me.notes.deleteVersion({ id: note.id, versionId: manualVersion.id });
    expect(
      (await me.notes.versions({ id: note.id })).some(
        v => v.id === manualVersion.id
      )
    ).toBe(false);
    expect((await me.notes.get({ id: note.id })).title).toBe("v2");
  });

  it("compacts history to the newest snapshot without changing the current note", async () => {
    const note = await me.notes.create({
      title: "current",
      body: "body",
      parentId: null,
      issue: null,
    });
    expect((await me.notes.compactVersions({ id: note.id })).deleted).toBe(0);
    const first = await me.notes.saveVersion({ id: note.id });
    expect((await me.notes.compactVersions({ id: note.id })).deleted).toBe(0);
    await me.notes.saveVersion({ id: note.id });
    const latest = await me.notes.saveVersion({ id: note.id });
    await expect(
      other.notes.compactVersions({ id: note.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await me.notes.compactVersions({ id: note.id })).toEqual({
      deleted: 2,
      remaining: 1,
    });
    const versions = await me.notes.versions({ id: note.id });
    expect(versions.map(version => version.id)).toEqual([latest.id]);
    expect(versions[0].id).not.toBe(first.id);
    expect((await me.notes.get({ id: note.id })).body).toBe("body");
    expect((await me.notes.get({ id: note.id })).contentRevision).toBe(1);
    expect(await me.notes.compactVersions({ id: note.id })).toEqual({
      deleted: 0,
      remaining: 1,
    });
  });

  it("publishes metadata-only notes events after committed mutations", async () => {
    const { subscribe } = await import("../lib/userEvents");
    const events: unknown[] = [];
    const close = () => {};
    const unsubscribe = subscribe(userId, event => events.push(event), close);
    try {
      const note = await me.notes.create({
        title: "event",
        body: "secret body",
        parentId: null,
        issue: null,
      });
      await me.notes.setIssue({ id: note.id, issue: null });
      expect(events).toEqual([
        { type: "notes", id: note.id, change: "create" },
        { type: "notes", id: note.id, change: "issue" },
      ]);
      expect(JSON.stringify(events)).not.toContain("secret body");
    } finally {
      unsubscribe();
    }
  });
});
