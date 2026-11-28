import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/**
 * Chats about an issue (api/chat/store.ts): who may be asked in (a teammate the tracker shows the
 * issue to), one thread per group and issue, messages written once whatever the retries, reads that
 * never move back, unread counts, and every change told live to the members only.
 */

// What the tracker says when asked with someone's connection: set per connection by each test.
const reach = new Map<number, "ok" | "noAccess" | "reconnect" | "unreachable" | "unsupported">();
const remote = new Map<string, { remoteId: string; key: string; title: string; status: string; category: string }>();
vi.mock("./access", async (original) => {
  const real = await original<typeof import("./access")>();
  return {
    ...real,
    lookIssue: vi.fn(async (conn: { id: number }, ref: { remoteId: string; key: string }) => {
      const r = reach.get(conn.id) ?? "ok";
      const found = remote.get(ref.key) ?? [...remote.values()].find((x) => x.remoteId === ref.remoteId);
      if (r !== "ok" || !found) return { reach: r === "ok" ? "noAccess" : r, issue: null };
      return {
        reach: "ok",
        issue: { remoteId: found.remoteId, key: found.key, title: found.title, status: { id: "s", name: found.status, category: found.category } },
      };
    }),
  };
});

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);
const one = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T> => (await q<T>(text, ...params))[0];

let n = 0;
async function person(name: string): Promise<number> {
  n++;
  return (await one<{ id: number }>("INSERT INTO users (username, display_name, role, email, created_at) VALUES (?, ?, 'member', ?, 1) RETURNING id", name.toLowerCase() + n, name, name.toLowerCase() + n + "@example.com")).id;
}
async function team(name: string, ...members: number[]): Promise<number> {
  const id = (await one<{ id: number }>("INSERT INTO teams (name, created_at) VALUES (?, 1) RETURNING id", name)).id;
  for (const m of members) await q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member')", id, m);
  return id;
}
async function connection(userId: number, base = "https://jira.example"): Promise<number> {
  return (await one<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', ?, ?, '{}', 'x', 1) RETURNING id", userId, base, "acct-" + userId + "-" + ++n)).id;
}
async function issue(userId: number, conn: number, remoteId: string, key: string, summary = "Fix the export") {
  await q(
    "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, ?, 'In corso', ?, 'P', 'u', 1)",
    userId,
    conn,
    remoteId,
    key,
    summary,
    key.split("-")[0],
  );
}
async function as(id: number, clientId = "page-" + id): Promise<Caller> {
  const { userById } = await import("../queries/accounts");
  const { appRouter } = await import("../router");
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: (await userById(id)) ?? null, sessionId: null, clientId });
}
const nonce = () => "n-" + Math.random().toString(36).slice(2, 12);
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return String((e as { code?: string }).code);
  }
}
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return String((e as Error).message);
  }
}

/** Events each user's pages got (api/lib/userEvents.ts). */
const heard = new Map<number, { e: { type: string; change?: string; threadId?: number }; ephemeral: boolean; origin?: string }[]>();
async function listen(userId: number) {
  const { subscribe } = await import("../lib/userEvents");
  heard.set(userId, []);
  subscribe(userId, (s) => heard.get(userId)!.push({ e: s.e, ephemeral: !!s.ephemeral, origin: s.origin }), () => undefined);
}
const changes = (userId: number) => (heard.get(userId) ?? []).filter((h) => h.e.type === "chat").map((h) => h.e.change);

let ann: number, bob: number, cy: number, dee: number, eve: number;
let annConn: number, bobConn: number, cyConn: number;

beforeAll(async () => {
  await (await import("../queries/connection")).resetDbForTests();
  ann = await person("Ann");
  bob = await person("Bob");
  cy = await person("Cy"); // a teammate who can't see the issue
  dee = await person("Dee"); // a teammate on another Jira
  eve = await person("Eve"); // not a teammate
  await team("Analysis", ann, bob, cy, dee);
  await team("Other", eve);
  annConn = await connection(ann);
  bobConn = await connection(bob);
  cyConn = await connection(cy);
  await connection(dee, "https://other-jira.example");
  await connection(eve);
  await issue(ann, annConn, "10001", "APP-1");
  await issue(bob, bobConn, "10001", "APP-1");
  remote.set("APP-1", { remoteId: "10001", key: "APP-1", title: "Fix the export", status: "In corso", category: "doing" });
  remote.set("APP-2", { remoteId: "10002", key: "APP-2", title: "Never imported", status: "Da fare", category: "todo" });
  reach.set(cyConn, "noAccess");
  for (const u of [ann, bob, cy, dee, eve]) await listen(u);
});

beforeEach(async () => {
  (await import("./limits")).resetChatLimits();
  for (const list of heard.values()) list.length = 0;
});

describe("who may be asked in", () => {
  it("lists teammates only, each with why they can't join", async () => {
    const list = await (await as(ann)).chat.candidates({ connectionId: annConn, key: "APP-1" });
    expect(list.map((c) => [c.name, c.ineligible])).toEqual([
      ["Bob", null],
      ["Cy", null],
      ["Dee", "noConnection"],
    ]);
    expect(list.find((c) => c.name === "Bob")?.teams).toEqual(["Analysis"]);
  });

  it("refuses someone outside the caller's teams, without saying who they are", async () => {
    expect(await messageOf((await as(ann)).chat.open({ connectionId: annConn, key: "APP-1", userIds: [eve] }))).toMatch(/your teams/);
  });

  it("refuses a teammate with no connection to the tracker, or one the tracker doesn't show the issue to", async () => {
    const c = await as(ann);
    expect(await messageOf(c.chat.open({ connectionId: annConn, key: "APP-1", userIds: [dee] }))).toMatch(/Dee has no connection to jira\.example/);
    expect(await messageOf(c.chat.open({ connectionId: annConn, key: "APP-1", userIds: [cy] }))).toMatch(/Cy can't see APP-1/);
    reach.set(bobConn, "unreachable");
    expect(await messageOf(c.chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] }))).toMatch(/can't be reached/);
    reach.set(bobConn, "reconnect");
    expect(await messageOf(c.chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] }))).toMatch(/Bob has to reconnect/);
    reach.delete(bobConn);
    // Nothing was written by any refusal.
    expect(await q("SELECT id FROM chat_threads")).toEqual([]);
  });

  it("refuses a turned-off account", async () => {
    await q("UPDATE users SET disabled_at = 1 WHERE id = ?", bob);
    try {
      expect(await messageOf((await as(ann)).chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] }))).toMatch(/turned off/);
      expect((await (await as(ann)).chat.candidates({ connectionId: annConn, key: "APP-1" })).find((c) => c.id === bob)?.ineligible).toBe("disabled");
    } finally {
      await q("UPDATE users SET disabled_at = NULL WHERE id = ?", bob);
    }
  });
});

describe("one thread per group and issue", () => {
  let thread = 0;

  it("opens a 1:1 with a line saying so, told to both", async () => {
    const out = await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] });
    expect(out.reused).toBe(false);
    thread = out.threadId;
    const view = await (await as(bob)).chat.thread({ threadId: thread });
    expect(view.issue).toMatchObject({ key: "APP-1", title: "Fix the export", status: "In corso", connectionId: bobConn });
    expect(view.members.map((m) => [m.name, m.role])).toEqual([
      ["Ann", "owner"],
      ["Bob", "member"],
    ]);
    const { messages } = await (await as(bob)).chat.messages({ threadId: thread });
    expect(messages.map((m) => [m.kind, m.system])).toEqual([["system", { kind: "opened" }]]);
    expect(changes(bob)).toEqual(["members"]);
    expect(changes(ann)).toEqual(["members"]);
    // The opener's own page is told it caused it (its other tabs act on it).
    expect(heard.get(ann)!.find((h) => h.e.type === "chat")?.origin).toBe("page-" + ann);
    // The system line opens nothing unread.
    expect(await (await as(bob)).chat.unreadCount()).toEqual({ threads: 0, messages: 0 });
  });

  it("opening it again, from either side, gives the same thread", async () => {
    expect(await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] })).toEqual({ threadId: thread, reused: true });
    expect(await (await as(bob)).chat.open({ connectionId: bobConn, key: "APP-1", userIds: [ann] })).toEqual({ threadId: thread, reused: true });
  });

  it("two opens at once give one thread", async () => {
    remote.set("APP-3", { remoteId: "10003", key: "APP-3", title: "Race", status: "Da fare", category: "todo" });
    const [a, b] = await Promise.all([
      (await as(ann)).chat.open({ connectionId: annConn, key: "APP-3", userIds: [bob] }),
      (await as(bob)).chat.open({ connectionId: bobConn, key: "APP-3", userIds: [ann] }),
    ]);
    expect(a.threadId).toBe(b.threadId);
    expect(await q("SELECT id FROM chat_threads WHERE issue_remote_id = '10003'")).toHaveLength(1);
  });

  it("an issue the opener never imported can be chatted about (the tracker asked with their connection)", async () => {
    const out = await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-2", userIds: [bob] });
    const view = await (await as(ann)).chat.thread({ threadId: out.threadId });
    expect(view.issue).toMatchObject({ key: "APP-2", remoteId: "10002", title: "Never imported", category: "todo" });
  });

  it("an issue the opener's tracker doesn't show reads as missing", async () => {
    expect(await codeOf((await as(ann)).chat.open({ connectionId: annConn, key: "NOPE-9", userIds: [bob] }))).toBe("NOT_FOUND");
  });

  it("someone else's connection is not the caller's way in", async () => {
    expect(await codeOf((await as(ann)).chat.open({ connectionId: bobConn, key: "APP-1", userIds: [bob] }))).toBe("NOT_FOUND");
  });

  it("finds the caller's threads on an issue by the tracker's id, even after the issue changed key", async () => {
    await q("UPDATE issues SET key = 'NEW-1' WHERE jira_id = '10001' AND user_id = ?", bob);
    try {
      const list = await (await as(bob)).chat.forIssue({ connectionId: bobConn, key: "NEW-1" });
      expect(list.map((t) => t.id)).toEqual([thread]);
      // Opening the thread refreshes its snapshot from the member's own copy.
      expect((await (await as(bob)).chat.thread({ threadId: thread })).issue.key).toBe("NEW-1");
    } finally {
      await q("DELETE FROM item_aliases");
      await q("UPDATE issues SET key = 'APP-1' WHERE jira_id = '10001'");
      await (await as(ann)).chat.thread({ threadId: thread });
    }
    expect((await (await as(ann)).chat.thread({ threadId: thread })).issue.key).toBe("APP-1");
  });
});

describe("messages", () => {
  let thread = 0;
  beforeAll(async () => {
    remote.set("APP-4", { remoteId: "10004", key: "APP-4", title: "Messages", status: "Da fare", category: "todo" });
    thread = (await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-4", userIds: [bob] })).threadId;
  });

  it("is written once whatever the retries, and told to every member", async () => {
    const id = nonce();
    const a = await (await as(ann)).chat.send({ threadId: thread, body: "  Is **APP-4** blocked?  ", clientNonce: id });
    const b = await (await as(ann)).chat.send({ threadId: thread, body: "Is **APP-4** blocked?", clientNonce: id });
    expect(b.id).toBe(a.id);
    expect(a.body).toBe("Is **APP-4** blocked?");
    expect(await q("SELECT id FROM chat_messages WHERE client_nonce = ?", id)).toHaveLength(1);
    expect(changes(bob)).toEqual(["message"]);
    expect(changes(cy)).toEqual([]);
  });

  it("refuses an empty message and a nonce already used in another thread", async () => {
    const c = await as(ann);
    expect(await codeOf(c.chat.send({ threadId: thread, body: "   ", clientNonce: nonce() }))).toBe("BAD_REQUEST");
    const other = (await c.chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] })).threadId;
    const id = nonce();
    await c.chat.send({ threadId: other, body: "there", clientNonce: id });
    expect(await codeOf(c.chat.send({ threadId: thread, body: "here", clientNonce: id }))).toBe("CONFLICT");
  });

  it("counts what the reader hasn't read; reads never move back", async () => {
    const c = await as(bob);
    const before = await c.chat.unreadCount();
    const m = await (await as(ann)).chat.send({ threadId: thread, body: "And now?", clientNonce: nonce() });
    expect((await c.chat.unreadCount()).messages).toBe(before.messages + 1);
    await c.chat.markRead({ threadId: thread, messageId: m.id });
    const t = await c.chat.thread({ threadId: thread });
    expect(t.unread).toBe(0);
    expect(t.members.find((x) => x.userId === bob)?.lastReadId).toBe(m.id);
    // A late read from another tab, of an older message: nothing moves.
    await c.chat.markRead({ threadId: thread, messageId: m.id - 1 });
    expect((await c.chat.thread({ threadId: thread })).members.find((x) => x.userId === bob)?.lastReadId).toBe(m.id);
    // The writer has read their own message.
    expect((await (await as(ann)).chat.thread({ threadId: thread })).unread).toBe(0);
  });

  it("a read of a message of another thread is refused", async () => {
    const other = (await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] })).threadId;
    const m = await (await as(ann)).chat.send({ threadId: other, body: "elsewhere", clientNonce: nonce() });
    expect(await codeOf((await as(bob)).chat.markRead({ threadId: thread, messageId: m.id }))).toBe("NOT_FOUND");
    expect(await codeOf((await as(bob)).chat.send({ threadId: thread, body: "re", replyToId: m.id, clientNonce: nonce() }))).toBe("NOT_FOUND");
  });

  it("muted and archived threads are left out of the badge", async () => {
    const c = await as(bob);
    await (await as(ann)).chat.send({ threadId: thread, body: "ping", clientNonce: nonce() });
    const with_ = await c.chat.unreadCount();
    await c.chat.prefs({ threadId: thread, muted: true });
    expect((await c.chat.unreadCount()).messages).toBeLessThan(with_.messages);
    await c.chat.prefs({ threadId: thread, muted: false, archived: true });
    expect((await c.chat.unreadCount()).messages).toBeLessThan(with_.messages);
    expect((await c.chat.threads({ filter: "all" })).threads.some((t) => t.id === thread)).toBe(false);
    expect((await c.chat.threads({ filter: "archived" })).threads.map((t) => t.id)).toContain(thread);
    // A new message brings it back.
    await (await as(ann)).chat.send({ threadId: thread, body: "back?", clientNonce: nonce() });
    expect((await c.chat.threads({ filter: "all" })).threads.some((t) => t.id === thread)).toBe(true);
    expect((await c.chat.threads({ filter: "unread" })).threads.some((t) => t.id === thread)).toBe(true);
  });

  it("only its writer edits or removes a message; removing keeps the line and drops its words, files and reactions", async () => {
    const m = await (await as(ann)).chat.send({ threadId: thread, body: "typo", clientNonce: nonce() });
    expect(await codeOf((await as(bob)).chat.edit({ messageId: m.id, body: "mine" }))).toBe("FORBIDDEN");
    await (await as(ann)).chat.edit({ messageId: m.id, body: "fixed" });
    await (await as(bob)).chat.react({ messageId: m.id, emoji: "👍", on: true });
    await (await as(bob)).chat.react({ messageId: m.id, emoji: "👍", on: true });
    let page = (await (await as(bob)).chat.messages({ threadId: thread })).messages.find((x) => x.id === m.id)!;
    expect(page.body).toBe("fixed");
    expect(page.editedAt).not.toBeNull();
    expect(page.reactions).toEqual([{ emoji: "👍", userIds: [bob] }]);
    const reply = await (await as(bob)).chat.send({ threadId: thread, body: "ok", replyToId: m.id, clientNonce: nonce() });
    expect(reply.replyTo).toMatchObject({ id: m.id, preview: "fixed", deleted: false });
    expect(await codeOf((await as(bob)).chat.remove({ messageId: m.id }))).toBe("FORBIDDEN");
    await (await as(ann)).chat.remove({ messageId: m.id });
    page = (await (await as(bob)).chat.messages({ threadId: thread })).messages.find((x) => x.id === m.id)!;
    expect(page).toMatchObject({ deleted: true, body: "", reactions: [] });
    const answer = (await (await as(bob)).chat.messages({ threadId: thread })).messages.find((x) => x.id === reply.id)!;
    expect(answer.replyTo).toMatchObject({ id: m.id, preview: "", deleted: true });
    expect(await codeOf((await as(ann)).chat.edit({ messageId: m.id, body: "again" }))).toBe("FORBIDDEN");
  });

  it("files go with a message of the thread they were uploaded to, by their uploader only", async () => {
    const draft = (await one<{ id: number }>("INSERT INTO chat_files (thread_id, uploader_id, name, content_type, size, data, created_at) VALUES (?, ?, 'a.png', 'image/png', 3, ?, ?) RETURNING id", thread, ann, Buffer.from("abc"), Date.now())).id;
    expect(await codeOf((await as(bob)).chat.send({ threadId: thread, body: "", fileIds: [draft], clientNonce: nonce() }))).toBe("NOT_FOUND");
    const m = await (await as(ann)).chat.send({ threadId: thread, body: "", fileIds: [draft], clientNonce: nonce() });
    expect(m.files.map((f) => f.name)).toEqual(["a.png"]);
    // Sent once: not again.
    expect(await codeOf((await as(ann)).chat.send({ threadId: thread, body: "", fileIds: [draft], clientNonce: nonce() }))).toBe("NOT_FOUND");
    // A message of only a file may be edited to have words, never emptied of everything.
    await (await as(ann)).chat.edit({ messageId: m.id, body: "the export" });
  });

  it("carries cards as their writer saw them", async () => {
    const m = await (await as(ann)).chat.send({
      threadId: thread,
      body: "see",
      refs: [{ kind: "worklog", key: "APP-4", date: "2026-11-20", seconds: 5400, comment: "analysis" }],
      clientNonce: nonce(),
    });
    expect(m.refs).toEqual([{ kind: "worklog", key: "APP-4", date: "2026-11-20", seconds: 5400, comment: "analysis" }]);
  });

  it("resolving says so in the thread; a new message opens it again", async () => {
    const c = await as(bob);
    await c.chat.setState({ threadId: thread, state: "resolved" });
    expect((await c.chat.thread({ threadId: thread })).state).toBe("resolved");
    expect((await c.chat.threads({ filter: "resolved" })).threads.map((t) => t.id)).toContain(thread);
    await (await as(ann)).chat.send({ threadId: thread, body: "one more thing", clientNonce: nonce() });
    expect((await c.chat.thread({ threadId: thread })).state).toBe("open");
    const lines = (await c.chat.messages({ threadId: thread })).messages.filter((m) => m.kind === "system").map((m) => m.system?.kind);
    expect(lines).toContain("resolved");
  });

  it("pages back from the latest, and centres on a message", async () => {
    const c = await as(ann);
    const t = (await c.chat.open({ connectionId: annConn, key: "APP-2", userIds: [bob] })).threadId;
    const sent: number[] = [];
    const { resetChatLimits } = await import("./limits");
    for (let i = 0; i < 60; i++) {
      if (i % 25 === 0) resetChatLimits();
      sent.push((await c.chat.send({ threadId: t, body: "m" + i, clientNonce: nonce() })).id);
    }
    const last = await c.chat.messages({ threadId: t });
    expect(last.messages).toHaveLength(50);
    expect(last.messages.at(-1)!.body).toBe("m59");
    expect(last.olderMore).toBe(true);
    const back = await c.chat.messages({ threadId: t, before: last.messages[0].id });
    expect(back.messages.at(-1)!.id).toBe(last.messages[0].id - 1);
    expect(back.olderMore).toBe(false);
    const mid = await c.chat.messages({ threadId: t, around: sent[30] });
    expect(mid.messages.map((m) => m.id)).toContain(sent[30]);
    expect(mid.olderMore && mid.newerMore).toBe(true);
    const after = await c.chat.messages({ threadId: t, after: sent[55] });
    expect(after.messages.map((m) => m.body)).toEqual(["m56", "m57", "m58", "m59"]);
  }, 30_000);

  it("finds words in the caller's threads only", async () => {
    await (await as(ann)).chat.send({ threadId: thread, body: "the quarterly reconciliation", clientNonce: nonce() });
    expect((await (await as(bob)).chat.search({ q: "reconcil" })).map((r) => r.message.body)).toEqual(["the quarterly reconciliation"]);
    expect(await (await as(cy)).chat.search({ q: "reconcil" })).toEqual([]);
    expect((await (await as(bob)).chat.threads({ filter: "all", q: "Ann" })).threads.length).toBeGreaterThan(0);
    expect((await (await as(bob)).chat.threads({ filter: "all", q: "APP-4" })).threads.map((t) => t.id)).toEqual([thread]);
  });

  it("refuses a flood", async () => {
    const c = await as(ann);
    const { SEND_PER_MINUTE } = await import("./limits");
    for (let i = 0; i < SEND_PER_MINUTE; i++) await c.chat.send({ threadId: thread, body: "x" + i, clientNonce: nonce() });
    expect(await codeOf(c.chat.send({ threadId: thread, body: "one too many", clientNonce: nonce() }))).toBe("TOO_MANY_REQUESTS");
  }, 30_000);
});

describe("typing", () => {
  it("reaches the other members now, is never numbered, kept or replayed", async () => {
    const { lastSeq, missedSince, RUN } = await import("../lib/userEvents");
    const thread = (await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-1", userIds: [bob] })).threadId;
    const seq = lastSeq(bob);
    await (await as(ann)).chat.typing({ threadId: thread });
    const got = heard.get(bob)!.filter((h) => h.e.change === "typing");
    expect(got).toHaveLength(1);
    expect(got[0].ephemeral).toBe(true);
    expect(lastSeq(bob)).toBe(seq);
    expect(missedSince(bob, RUN + ":" + (seq - 1))?.some((s) => s.e.type === "chat" && "change" in s.e && s.e.change === "typing")).toBe(false);
    // Again at once: the others already show it.
    await (await as(ann)).chat.typing({ threadId: thread });
    expect(heard.get(bob)!.filter((h) => h.e.change === "typing")).toHaveLength(1);
    // Not a member: refused, nobody told.
    expect(await codeOf((await as(cy)).chat.typing({ threadId: thread }))).toBe("NOT_FOUND");
  });
});

describe("members", () => {
  it("adds a teammate who sees the issue; one who doesn't is refused", async () => {
    remote.set("APP-5", { remoteId: "10005", key: "APP-5", title: "Group", status: "Da fare", category: "todo" });
    const c = await as(ann);
    const thread = (await c.chat.open({ connectionId: annConn, key: "APP-5", userIds: [bob] })).threadId;
    expect(await messageOf(c.chat.addMembers({ threadId: thread, userIds: [cy] }))).toMatch(/Cy can't see APP-5/);
    reach.set(cyConn, "ok");
    try {
      await c.chat.addMembers({ threadId: thread, userIds: [cy] });
    } finally {
      reach.set(cyConn, "noAccess");
    }
    expect((await (await as(cy)).chat.thread({ threadId: thread })).members.map((m) => m.name)).toEqual(["Ann", "Bob", "Cy"]);
    // A group thread is not the 1:1: opening "Ann + Bob" again gives a new one.
    const pair = await c.chat.open({ connectionId: annConn, key: "APP-5", userIds: [bob] });
    expect(pair.threadId).not.toBe(thread);
    expect(pair.reused).toBe(false);
  });

  it("whoever leaves no longer reaches it; the last one out takes it away", async () => {
    remote.set("APP-6", { remoteId: "10006", key: "APP-6", title: "Leave", status: "Da fare", category: "todo" });
    const thread = (await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-6", userIds: [bob] })).threadId;
    await (await as(bob)).chat.leave({ threadId: thread });
    expect(await codeOf((await as(bob)).chat.thread({ threadId: thread }))).toBe("NOT_FOUND");
    const view = await (await as(ann)).chat.thread({ threadId: thread });
    expect(view.members.find((m) => m.userId === bob)?.left).toBe(true);
    // Asked back in, they return (their earlier lines keep their name meanwhile).
    await (await as(ann)).chat.addMembers({ threadId: thread, userIds: [bob] });
    expect((await (await as(bob)).chat.thread({ threadId: thread })).members.find((m) => m.userId === bob)?.left).toBe(false);
    await (await as(bob)).chat.leave({ threadId: thread });
    await (await as(ann)).chat.leave({ threadId: thread });
    expect(await q("SELECT id FROM chat_threads WHERE id = ?", thread)).toEqual([]);
    expect(changes(ann)).toContain("gone");
  });
});

describe("housekeeping", () => {
  it("drops files never sent after a day, and chats nobody is left in", async () => {
    remote.set("APP-7", { remoteId: "10007", key: "APP-7", title: "Purge", status: "Da fare", category: "todo" });
    const thread = (await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-7", userIds: [bob] })).threadId;
    const now = Date.now();
    const old = (await one<{ id: number }>("INSERT INTO chat_files (thread_id, uploader_id, name, content_type, size, data, created_at) VALUES (?, ?, 'old', 'text/plain', 1, ?, ?) RETURNING id", thread, ann, Buffer.from("a"), now - 25 * 3600_000)).id;
    const fresh = (await one<{ id: number }>("INSERT INTO chat_files (thread_id, uploader_id, name, content_type, size, data, created_at) VALUES (?, ?, 'new', 'text/plain', 1, ?, ?) RETURNING id", thread, ann, Buffer.from("a"), now)).id;
    const orphan = (await one<{ id: number }>("INSERT INTO chat_threads (tracker_type, tracker_base, issue_remote_id, issue_key, created_at, last_message_at) VALUES ('jira', 'https://jira.example', '9', 'APP-9', 1, 1) RETURNING id")).id;
    const { purgeChat } = await import("./purge");
    const out = await purgeChat(now);
    expect(out.drafts).toBeGreaterThanOrEqual(1);
    expect((await q<{ id: number }>("SELECT id FROM chat_files WHERE id IN (?, ?)", old, fresh)).map((r) => r.id)).toEqual([fresh]);
    expect(await q("SELECT id FROM chat_threads WHERE id = ?", orphan)).toEqual([]);
    expect(await q("SELECT id FROM chat_threads WHERE id = ?", thread)).toHaveLength(1);
  });

  it("an erased member's words stay for the others, nameless; their export carries them", async () => {
    remote.set("APP-8", { remoteId: "10008", key: "APP-8", title: "Erase", status: "Da fare", category: "todo" });
    const gone = await person("Gus");
    await q("INSERT INTO team_members (team_id, user_id, role) SELECT id, ?, 'member' FROM teams WHERE name = 'Analysis'", gone);
    const gusConn = await connection(gone);
    const thread = (await (await as(ann)).chat.open({ connectionId: annConn, key: "APP-8", userIds: [gone] })).threadId;
    await (await as(gone)).chat.send({ threadId: thread, body: "my analysis", clientNonce: nonce() });
    const { exportEntries } = await import("../gdpr/exportData");
    const files = new Map<string, string>();
    for await (const e of exportEntries(gone)) files.set(e.name, typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8"));
    const chat = JSON.parse(files.get("chat.json")!) as { threads: { issueKey: string }[]; messages: { body: string }[] };
    expect(chat.threads.map((t) => t.issueKey)).toEqual(["APP-8"]);
    expect(chat.messages.map((m) => m.body)).toEqual(["my analysis"]);
    await q("DELETE FROM connections WHERE id = ?", gusConn);
    await q("DELETE FROM chat_members WHERE user_id = ?", gone);
    await q("DELETE FROM users WHERE id = ?", gone);
    const page = await (await as(ann)).chat.messages({ threadId: thread });
    expect(page.messages.find((m) => m.body === "my analysis")?.authorId).toBeNull();
  });
});
