import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("pinned mails", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let me: Caller;
  let other: Caller;
  let jira = 0;
  const ID = "AAQkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgAQAGxqR1k8Q3FAqK-hm_o3Zr8=";
  const LINK = `https://outlook.office.com/mail/inbox/id/${encodeURIComponent(ID)}`;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const user = async (name: string) => (await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name))[0].id;
    const u = await user("m");
    const o = await user("o");
    jira = (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://acme.atlassian.net', 'me', 'x', 1) RETURNING id", u))[0].id;
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, project_key, project_name, url, synced_at) VALUES (?, ?, 'i1', 'APP-1', 'Login fails', 'To Do', 'todo', 'APP', 'App', 'u', 1)",
      u,
      jira,
    );
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

  it("keeps a pasted Outlook link in its stable form, with the subject typed by hand", async () => {
    const m = await me.mails.save({ subject: "Release 2.3", webLink: LINK, source: "link" });
    expect(m).toMatchObject({ subject: "Release 2.3", webLink: `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(ID)}`, source: "link" });
    await expect(me.mails.save({ subject: "x", webLink: "javascript:alert(1)", source: "link" })).rejects.toThrow();
    await expect(me.mails.save({ subject: "x", webLink: "http://outlook.office.com/a", source: "link" })).rejects.toThrow();
    await expect(me.mails.save({ subject: "", source: "eml" })).rejects.toThrow();
  });

  it("stores the same message once: a later copy completes it, a typed subject stays", async () => {
    await q("DELETE FROM mails");
    const eml = await me.mails.save({ subject: "Re: budget", fromName: "Giulia", fromAddress: "G@X.it", receivedAt: Date.parse("2026-10-27T09:00:00Z"), internetMessageId: "abc@x", source: "eml" });
    expect(eml.webLink).toBeNull();
    const again = await me.mails.save({ subject: "", internetMessageId: "abc@x", webLink: LINK, source: "addin" });
    expect(again).toMatchObject({ id: eml.id, subject: "Re: budget", fromAddress: "g@x.it", webLink: expect.stringContaining("/deeplink/read/") });
    expect(await q("SELECT count(*)::int AS n FROM mails")).toEqual([{ n: 1 }]);
    // Another user's copy is theirs.
    const theirs = await other.mails.save({ subject: "Re: budget", internetMessageId: "abc@x", source: "eml" });
    expect(theirs.id).not.toBe(eml.id);
  });

  it("pins to an issue once, follows its key, unpins; never someone else's mail", async () => {
    const [m] = await me.mails.recent({ query: "budget" });
    await me.mails.pin({ mailId: m.id, to: { issueKey: "APP-1" } });
    await me.mails.pin({ mailId: m.id, to: { issueKey: "APP-1", connectionId: jira } });
    expect((await me.mails.forIssue({ issueKey: "APP-1" })).map(x => x.id)).toEqual([m.id]);
    // The issue moves to another key: its mails go with it.
    await q("UPDATE issues SET key = 'NEW-1' WHERE key = 'APP-1'");
    expect((await me.mails.forIssue({ issueKey: "NEW-1", connectionId: jira })).map(x => x.id)).toEqual([m.id]);
    await me.mails.unpin({ mailId: m.id, to: { issueKey: "NEW-1", connectionId: jira } });
    expect(await me.mails.forIssue({ issueKey: "NEW-1", connectionId: jira })).toEqual([]);
    await expect(other.mails.pin({ mailId: m.id, to: { issueKey: "NEW-1", connectionId: jira } })).rejects.toThrow();
    await expect(other.mails.update({ id: m.id, subject: "mine" })).rejects.toThrow();
  });

  it("pins to a Markdown note; a trashed note takes none, a deleted one lets go", async () => {
    const [m] = await me.mails.recent({});
    const note = await me.notes.create({ title: "Budget", body: "", parentId: null, issue: null });
    await me.mails.pin({ mailId: m.id, to: { noteId: note.id } });
    expect((await me.mails.forNote({ noteId: note.id })).map(x => x.subject)).toEqual(["Re: budget"]);
    await expect(other.mails.forNote({ noteId: note.id })).resolves.toEqual([]);
    await me.notes.remove({ id: note.id });
    const fresh = await me.notes.create({ title: "Other", body: "", parentId: null, issue: null });
    await q("UPDATE markdown_notes SET deleted_at = 1 WHERE id = ?", fresh.id);
    await expect(me.mails.pin({ mailId: m.id, to: { noteId: fresh.id } })).rejects.toThrow();
    await q("DELETE FROM markdown_notes WHERE id = ?", note.id);
    expect(await me.mails.forNote({ noteId: note.id })).toEqual([]);
  });

  it("a TODO and a post-it about a mail show it; forgetting the mail unpins it and frees the TODO", async () => {
    const [m] = await me.mails.recent({});
    const todo = await me.todos.add({ text: "Answer Giulia", mailId: m.id });
    const [listed] = await me.todos.list({ view: "someday", today: "2026-10-27" });
    expect(listed.mail).toMatchObject({ id: m.id, subject: "Re: budget" });
    await expect(other.todos.add({ text: "steal", mailId: m.id })).rejects.toThrow();
    const pinned = await me.pinboard.pinMail({ mailId: m.id });
    expect((await me.pinboard.pinMail({ mailId: m.id })).id).toBe(pinned.id);
    const board = await me.pinboard.list({ boardId: pinned.boardId });
    expect(board.find(n => n.id === pinned.id)?.mail).toMatchObject({ id: m.id, subject: "Re: budget" });
    await me.mails.remove({ id: m.id });
    expect((await me.pinboard.list({ boardId: pinned.boardId })).find(n => n.id === pinned.id)).toBeUndefined();
    const [after] = await me.todos.list({ view: "someday", today: "2026-10-27" });
    expect(after).toMatchObject({ id: todo.id, mailId: null, mail: null });
  });
});
