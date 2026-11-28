// Chats about an issue (contracts/chat.ts): threads, members, messages, reads. Who may do what is
// decided here too (a member of the thread, nobody else: anyone else's thread reads as missing),
// and every change is told live to the thread's members (api/lib/userEvents.ts).
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { chatFiles, chatMembers, chatMessages, chatReactions, chatThreads, users, type ChatThread, type Connection, type User } from "@db/schema";
import { CHAT_MEMBERS_MAX, CHAT_PAGE, CHAT_SEARCH_MAX, CHAT_THREADS_PAGE, chatPreview, isChatReaction } from "@contracts/chat";
import type { ChatChange } from "@contracts/liveEvents";
import type {
  ChatCandidate,
  ChatFileView,
  ChatFilter,
  ChatIssueView,
  ChatMemberView,
  ChatMessageView,
  ChatReaction,
  ChatRef,
  ChatSystemEvent,
  ChatThreadState,
  ChatThreadView,
} from "@contracts/chat";
import { t } from "@contracts/i18n";
import { getDb, type Db } from "../queries/connection";
import { xactLock } from "../queries/locks";
import { ownConnection } from "../providers/connections";
import { publish as publishEvent } from "../lib/userEvents";
import { addIssueComment } from "../routers/issues";
import { fromMarkdown } from "../providers/core/richtext";
import { candidates as candidatesFor, connectionsTo, findIssueByKey, lookIssue, ownIssueRow, teammates, type Reach, type TrackerOf } from "./access";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: t("server.chat.notFound") });
const refused = (message: string) => new TRPCError({ code: "PRECONDITION_FAILED", message });

/** The issue a thread is about: where it lives, and what it looked like when last seen. */
export type Anchor = TrackerOf & { remoteId: string; key: string; title: string; status: string; category: string };

const trackerName = (base: string) => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};

/**
 * The issue a user points at (by their own connection and its key), as a thread anchors it: their
 * imported copy when they have one, else the tracker asked with their connection (an issue they
 * never imported can be chatted about too).
 */
export async function anchorOf(userId: number, connectionId: number, key: string): Promise<Anchor> {
  const conn = await ownConnection(userId, connectionId);
  const tracker = { trackerType: conn.type, trackerBase: conn.baseUrl };
  const row = await ownIssueRow(userId, conn.id, null, key);
  if (row) return { ...tracker, remoteId: row.remoteId, key: row.key, title: row.summary, status: row.status, category: row.category };
  const { reach, issue } = await findIssueByKey(conn, key);
  if (reach === "ok" && issue) return { ...tracker, remoteId: issue.remoteId, key: issue.key, title: issue.title, status: issue.status.name, category: issue.status.category };
  if (reach === "unreachable") throw refused(t("server.chat.unreachable", { tracker: trackerName(conn.baseUrl) }));
  if (reach === "reconnect") throw refused(t("server.chat.reconnectYours", { tracker: trackerName(conn.baseUrl) }));
  throw new TRPCError({ code: "NOT_FOUND", message: t("server.chat.issueNotFound", { key }) });
}

/** The tracker a user's connection reaches, and the issue's id there when they have it imported. */
export async function trackerOf(userId: number, connectionId: number, key: string): Promise<{ tracker: TrackerOf; remoteId: string | null; conn: Connection }> {
  const conn = await ownConnection(userId, connectionId);
  const row = await ownIssueRow(userId, conn.id, null, key);
  return { tracker: { trackerType: conn.type, trackerBase: conn.baseUrl }, remoteId: row?.remoteId ?? null, conn };
}

/** Teammates for the picker, about one issue. */
export async function candidates(userId: number, connectionId: number, key: string): Promise<ChatCandidate[]> {
  const { tracker, remoteId } = await trackerOf(userId, connectionId, key);
  return candidatesFor(userId, tracker, remoteId);
}

// ---------------------------------------------------------------------------
// Membership

type Membership = { thread: ChatThread; role: string; lastReadId: number; muted: boolean; pinned: boolean; archived: boolean };

/** The thread, when `userId` is in it (and hasn't left); NOT_FOUND otherwise, never "forbidden". */
export async function memberOf(userId: number, threadId: number, db: Pick<Db, "select"> = getDb()): Promise<Membership> {
  const [row] = await db
    .select({ thread: chatThreads, role: chatMembers.role, lastReadId: chatMembers.lastReadId, muted: chatMembers.muted, pinned: chatMembers.pinned, archivedAt: chatMembers.archivedAt })
    .from(chatMembers)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMembers.threadId))
    .where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId), isNull(chatMembers.leftAt)))
    .limit(1);
  if (!row) throw notFound();
  return { thread: row.thread, role: row.role, lastReadId: row.lastReadId, muted: row.muted === 1, pinned: row.pinned === 1, archived: row.archivedAt !== null };
}

/** Who is in a thread now. */
async function activeMemberIds(threadId: number, db: Pick<Db, "select"> = getDb()): Promise<number[]> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.threadId, threadId), isNull(chatMembers.leftAt), isNull(users.disabledAt)));
  return rows.map((r) => r.userId);
}

/** Tells every member's open pages (the actor's own included: their other tabs) what changed. */
export async function tell(threadId: number, change: ChatChange, by: number, opts: { messageId?: number; origin?: string; to?: number[] } = {}) {
  const to = opts.to ?? (await activeMemberIds(threadId));
  for (const userId of to) {
    publishEvent(userId, opts.messageId === undefined ? { type: "chat", threadId, change, by } : { type: "chat", threadId, change, by, messageId: opts.messageId }, userId === by ? opts.origin : undefined);
  }
}

// ---------------------------------------------------------------------------
// Asking people in

/** Why someone can't be asked in, as the error says it. */
function reachRefusal(reach: Reach, name: string, key: string, tracker: string): TRPCError {
  if (reach === "unreachable") return refused(t("server.chat.unreachable", { tracker }));
  if (reach === "reconnect") return refused(t("server.chat.reconnect", { name, tracker }));
  if (reach === "unsupported") return refused(t("server.chat.unsupported", { tracker }));
  return refused(t("server.chat.noAccess", { name, key }));
}

/**
 * Checks that each of `ids` may be asked into a thread about `anchor` by `userId`: a teammate,
 * not turned off, with a connection to the tracker, who the tracker (asked with their connection)
 * shows the issue to. Throws the first reason one can't; nothing is written.
 */
async function checkInvitees(userId: number, ids: number[], anchor: Anchor): Promise<void> {
  if (ids.length === 0) return;
  const mates = await teammates(userId);
  const people = await getDb()
    .select({ id: users.id, name: users.displayName, username: users.username, disabledAt: users.disabledAt })
    .from(users)
    .where(inArray(users.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  const tracker = trackerName(anchor.trackerBase);
  for (const id of ids) {
    const p = byId.get(id);
    // Someone who isn't a teammate reads as nobody: who else is on the server isn't told.
    if (!p || !mates.has(id)) throw refused(t("server.chat.notTeammate"));
    if (p.disabledAt) throw refused(t("server.chat.disabled", { name: p.name || p.username || "" }));
  }
  const conns = await connectionsTo(ids, anchor, anchor.remoteId);
  for (const id of ids) {
    const p = byId.get(id)!;
    if (!conns.has(id)) throw refused(t("server.chat.noConnection", { name: p.name || p.username || "", tracker }));
  }
  const reaches = await Promise.all(ids.map(async (id) => [id, (await lookIssue(conns.get(id)!, { remoteId: anchor.remoteId, key: anchor.key })).reach] as const));
  for (const [id, reach] of reaches) {
    if (reach !== "ok") {
      const p = byId.get(id)!;
      throw reachRefusal(reach, p.name || p.username || "", anchor.key, tracker);
    }
  }
}

/** A thread about `anchor` whose active members are exactly these people. */
async function threadWithExactly(anchor: Anchor, ids: number[], db: Pick<Db, "select"> = getDb()): Promise<number | null> {
  const want = [...new Set(ids)].sort((a, b) => a - b);
  const rows = await db
    .select({ id: chatThreads.id, members: sql<number[]>`array_agg(${chatMembers.userId} ORDER BY ${chatMembers.userId})` })
    .from(chatThreads)
    .innerJoin(chatMembers, and(eq(chatMembers.threadId, chatThreads.id), isNull(chatMembers.leftAt)))
    .where(and(eq(chatThreads.trackerType, anchor.trackerType), eq(chatThreads.trackerBase, anchor.trackerBase), eq(chatThreads.issueRemoteId, anchor.remoteId)))
    .groupBy(chatThreads.id)
    .orderBy(desc(chatThreads.lastMessageAt));
  const found = rows.find((r) => r.members.map(Number).join(",") === want.join(","));
  return found?.id ?? null;
}

async function systemLine(tx: Tx | Db, threadId: number, authorId: number, event: ChatSystemEvent, at = new Date()) {
  const [m] = await tx.insert(chatMessages).values({ threadId, authorId, kind: "system", system: JSON.stringify(event), createdAt: at }).returning({ id: chatMessages.id });
  return m.id;
}

export type OpenInput = { connectionId: number; key: string; userIds: number[]; origin?: string };

/**
 * A chat with these teammates about an issue: the one already there with exactly them (1:1
 * above all), else a new one. Each is checked first (checkInvitees); two people opening the
 * same chat at once get one thread.
 */
export async function openThread(userId: number, input: OpenInput): Promise<{ threadId: number; reused: boolean }> {
  const ids = [...new Set(input.userIds)].filter((id) => id !== userId);
  if (ids.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.chat.nobody") });
  if (ids.length + 1 > CHAT_MEMBERS_MAX) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.chat.tooMany", { max: CHAT_MEMBERS_MAX }) });
  const anchor = await anchorOf(userId, input.connectionId, input.key);
  const everyone = [userId, ...ids];
  const existing = await threadWithExactly(anchor, everyone);
  if (existing !== null) return { threadId: existing, reused: true };
  await checkInvitees(userId, ids, anchor);
  const opened = await getDb().transaction(async (tx) => {
    // One at a time per issue and group: two "chat with" clicks give one thread.
    await xactLock(tx, `chat-open:${anchor.trackerType}:${anchor.trackerBase}:${anchor.remoteId}:${[...everyone].sort((a, b) => a - b).join(",")}`);
    const again = await threadWithExactly(anchor, everyone, tx);
    if (again !== null) return { threadId: again, reused: true };
    const now = new Date();
    const [thread] = await tx
      .insert(chatThreads)
      .values({
        createdBy: userId,
        trackerType: anchor.trackerType,
        trackerBase: anchor.trackerBase,
        issueRemoteId: anchor.remoteId,
        issueKey: anchor.key,
        issueTitle: anchor.title,
        issueStatus: anchor.status,
        issueCategory: anchor.category,
        createdAt: now,
        lastMessageAt: now,
      })
      .returning({ id: chatThreads.id });
    await tx.insert(chatMembers).values(everyone.map((id) => ({ threadId: thread.id, userId: id, role: id === userId ? "owner" : "member", joinedAt: now })));
    const line = await systemLine(tx, thread.id, userId, { kind: "opened" }, now);
    await tx.update(chatMembers).set({ lastReadId: line }).where(and(eq(chatMembers.threadId, thread.id), eq(chatMembers.userId, userId)));
    return { threadId: thread.id, reused: false };
  });
  if (!opened.reused) await tell(opened.threadId, "members", userId, { origin: input.origin, to: everyone });
  return opened;
}

/** More teammates into a thread (each checked as when opening); one who had left comes back. */
export async function addMembers(userId: number, threadId: number, userIds: number[], origin?: string): Promise<void> {
  const { thread } = await memberOf(userId, threadId);
  const active = new Set(await activeMemberIds(threadId));
  const ids = [...new Set(userIds)].filter((id) => !active.has(id) && id !== userId);
  if (ids.length === 0) return;
  if (active.size + ids.length > CHAT_MEMBERS_MAX) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.chat.tooMany", { max: CHAT_MEMBERS_MAX }) });
  const anchor: Anchor = { trackerType: thread.trackerType, trackerBase: thread.trackerBase, remoteId: thread.issueRemoteId, key: thread.issueKey, title: thread.issueTitle, status: thread.issueStatus, category: thread.issueCategory };
  await checkInvitees(userId, ids, anchor);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    for (const id of ids) {
      await tx
        .insert(chatMembers)
        .values({ threadId, userId: id, role: "member", joinedAt: now })
        .onConflictDoUpdate({ target: [chatMembers.threadId, chatMembers.userId], set: { leftAt: null, joinedAt: now, archivedAt: null } });
    }
    await systemLine(tx, threadId, userId, { kind: "added", userIds: ids }, now);
    await tx.update(chatThreads).set({ lastMessageAt: now }).where(eq(chatThreads.id, threadId));
  });
  await tell(threadId, "members", userId, { origin });
}

/** Out of a thread: it no longer reaches them. The last one out takes it (and its files) away. */
export async function leave(userId: number, threadId: number, origin?: string): Promise<void> {
  await memberOf(userId, threadId);
  const before = await activeMemberIds(threadId);
  const gone = await getDb().transaction(async (tx) => {
    const now = new Date();
    await tx.update(chatMembers).set({ leftAt: now }).where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId)));
    const [left] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMembers)
      .where(and(eq(chatMembers.threadId, threadId), isNull(chatMembers.leftAt)));
    if (Number(left.n) === 0) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, threadId));
      return true;
    }
    await systemLine(tx, threadId, userId, { kind: "left" }, now);
    return false;
  });
  // The one who left is told too (their other tabs drop it); the rest see the line.
  await tell(threadId, gone ? "gone" : "members", userId, { origin, to: before });
}

// ---------------------------------------------------------------------------
// Reading

const fileCols = { id: chatFiles.id, messageId: chatFiles.messageId, name: chatFiles.name, contentType: chatFiles.contentType, size: chatFiles.size, width: chatFiles.width, height: chatFiles.height };

function parseRefs(json: string): ChatRef[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as ChatRef[]) : [];
  } catch {
    return [];
  }
}

function parseSystem(json: string | null): ChatSystemEvent | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ChatSystemEvent;
  } catch {
    return null;
  }
}

type MessageRow = typeof chatMessages.$inferSelect;

/** Messages as the thread shows them: files, reactions and what each answers. */
async function views(rows: MessageRow[]): Promise<ChatMessageView[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const [files, reactions] = await Promise.all([
    db.select(fileCols).from(chatFiles).where(inArray(chatFiles.messageId, ids)).orderBy(asc(chatFiles.id)),
    db.select({ messageId: chatReactions.messageId, userId: chatReactions.userId, emoji: chatReactions.emoji }).from(chatReactions).where(inArray(chatReactions.messageId, ids)).orderBy(asc(chatReactions.createdAt)),
  ]);
  const replyIds = [...new Set(rows.map((r) => r.replyToId).filter((id): id is number => id !== null))];
  const replies = replyIds.length
    ? await db.select({ id: chatMessages.id, authorId: chatMessages.authorId, body: chatMessages.body, deletedAt: chatMessages.deletedAt }).from(chatMessages).where(inArray(chatMessages.id, replyIds))
    : [];
  const replyOf = new Map(replies.map((r) => [r.id, r]));
  const filesOf = new Map<number, ChatFileView[]>();
  for (const { messageId, ...f } of files) if (messageId !== null) filesOf.set(messageId, [...(filesOf.get(messageId) ?? []), f]);
  const reactionsOf = new Map<number, Map<ChatReaction, number[]>>();
  for (const r of reactions) {
    if (!isChatReaction(r.emoji)) continue;
    const m = reactionsOf.get(r.messageId) ?? new Map<ChatReaction, number[]>();
    m.set(r.emoji, [...(m.get(r.emoji) ?? []), r.userId]);
    reactionsOf.set(r.messageId, m);
  }
  return rows.map((r) => {
    const reply = r.replyToId !== null ? replyOf.get(r.replyToId) : undefined;
    return {
      id: r.id,
      threadId: r.threadId,
      authorId: r.authorId,
      kind: r.kind === "system" ? "system" : "text",
      body: r.deletedAt ? "" : r.body,
      doc: r.deletedAt || r.kind !== "text" || !r.body ? null : fromMarkdown(r.body, "gfm"),
      system: parseSystem(r.system),
      refs: r.deletedAt ? [] : parseRefs(r.refs),
      files: filesOf.get(r.id) ?? [],
      replyTo: r.replyToId === null ? null : reply ? { id: reply.id, authorId: reply.authorId, preview: reply.deletedAt ? "" : chatPreview(reply.body, 120), deleted: reply.deletedAt !== null } : { id: r.replyToId, authorId: null, preview: "", deleted: true },
      reactions: [...(reactionsOf.get(r.id) ?? new Map<ChatReaction, number[]>())].map(([emoji, userIds]) => ({ emoji, userIds })),
      jiraCommentId: r.jiraCommentId,
      clientNonce: r.clientNonce,
      createdAt: r.createdAt.getTime(),
      editedAt: r.editedAt?.getTime() ?? null,
      deleted: r.deletedAt !== null,
    };
  });
}

/** Members of these threads, as views (who left too: their lines keep a name). */
async function membersOfThreads(threadIds: number[]): Promise<Map<number, ChatMemberView[]>> {
  const out = new Map<number, ChatMemberView[]>();
  if (threadIds.length === 0) return out;
  const rows = await getDb()
    .select({ threadId: chatMembers.threadId, userId: chatMembers.userId, name: users.displayName, username: users.username, avatarUrl: users.avatarUrl, role: chatMembers.role, lastReadId: chatMembers.lastReadId, leftAt: chatMembers.leftAt, joinedAt: chatMembers.joinedAt })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(inArray(chatMembers.threadId, threadIds))
    .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.userId));
  for (const r of rows) {
    out.set(r.threadId, [
      ...(out.get(r.threadId) ?? []),
      { userId: r.userId, name: r.name || r.username || "", avatarUrl: r.avatarUrl, role: r.role === "owner" ? "owner" : "member", lastReadId: r.lastReadId, left: r.leftAt !== null },
    ]);
  }
  return out;
}

/** The thread's issue as `userId` sees it: through their own connection to its tracker, if any. */
async function issueViews(userId: number, threads: ChatThread[]): Promise<Map<number, ChatIssueView>> {
  const out = new Map<number, ChatIssueView>();
  const byTracker = new Map<string, ChatThread[]>();
  for (const th of threads) byTracker.set(th.trackerType + " " + th.trackerBase, [...(byTracker.get(th.trackerType + " " + th.trackerBase) ?? []), th]);
  for (const list of byTracker.values()) {
    const first = list[0];
    const conn = (await connectionsTo([userId], first, first.issueRemoteId)).get(userId) ?? null;
    for (const th of list) {
      out.set(th.id, {
        trackerType: th.trackerType,
        trackerBase: th.trackerBase,
        remoteId: th.issueRemoteId,
        key: th.issueKey,
        title: th.issueTitle,
        status: th.issueStatus,
        category: th.issueCategory,
        connectionId: conn?.id ?? null,
      });
    }
  }
  return out;
}

/** Unread messages per thread for `userId`: someone else's words after where they read. */
const unreadSql = (userId: number) => sql<number>`(
  SELECT count(*)::int FROM ${chatMessages} m
  WHERE m.thread_id = ${chatThreads.id} AND m.id > ${chatMembers.lastReadId}
    AND m.kind = 'text' AND m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM ${userId}
)`;

export type ThreadsQuery = { filter: ChatFilter; q?: string; before?: number };

/**
 * The user's threads, pinned first then the latest; `before` (a lastMessageAt) pages on.
 * Archived ones only under "archived"; "resolved" shows resolved ones; "unread" those with news.
 */
export async function listThreads(userId: number, query: ThreadsQuery): Promise<{ threads: ChatThreadView[]; more: boolean }> {
  const unread = unreadSql(userId);
  const where: SQL[] = [eq(chatMembers.userId, userId), isNull(chatMembers.leftAt)];
  if (query.filter === "archived") where.push(sql`${chatMembers.archivedAt} IS NOT NULL`);
  else where.push(isNull(chatMembers.archivedAt));
  if (query.filter === "resolved") where.push(eq(chatThreads.state, "resolved"));
  if (query.filter === "unread") where.push(sql`${unread} > 0`);
  if (query.before !== undefined) where.push(lt(chatThreads.lastMessageAt, new Date(query.before)));
  const text = query.q?.trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push(sql`(${chatThreads.issueKey} ILIKE ${like} OR ${chatThreads.issueTitle} ILIKE ${like} OR EXISTS (
      SELECT 1 FROM ${chatMembers} om JOIN ${users} ou ON ou.id = om.user_id
      WHERE om.thread_id = ${chatThreads.id} AND om.user_id <> ${userId} AND ou.display_name ILIKE ${like}))`);
  }
  const rows = await getDb()
    .select({ thread: chatThreads, muted: chatMembers.muted, pinned: chatMembers.pinned, archivedAt: chatMembers.archivedAt, unread })
    .from(chatMembers)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMembers.threadId))
    .where(and(...where))
    .orderBy(query.before === undefined ? desc(chatMembers.pinned) : sql`1`, desc(chatThreads.lastMessageAt), desc(chatThreads.id))
    .limit(CHAT_THREADS_PAGE + 1);
  const page = rows.slice(0, CHAT_THREADS_PAGE);
  return { threads: await threadViews(userId, page), more: rows.length > CHAT_THREADS_PAGE };
}

type ThreadRow = { thread: ChatThread; muted: number; pinned: number; archivedAt: Date | null; unread: number };

async function threadViews(userId: number, rows: ThreadRow[]): Promise<ChatThreadView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.thread.id);
  const [members, issuesOf, lasts] = await Promise.all([
    membersOfThreads(ids),
    issueViews(userId, rows.map((r) => r.thread)),
    getDb()
      .selectDistinctOn([chatMessages.threadId], { threadId: chatMessages.threadId, id: chatMessages.id, authorId: chatMessages.authorId, body: chatMessages.body, kind: chatMessages.kind, deletedAt: chatMessages.deletedAt, createdAt: chatMessages.createdAt, files: sql<number>`(SELECT count(*)::int FROM ${chatFiles} f WHERE f.message_id = ${chatMessages.id})` })
      .from(chatMessages)
      .where(inArray(chatMessages.threadId, ids))
      .orderBy(chatMessages.threadId, desc(chatMessages.id)),
  ]);
  const lastOf = new Map(lasts.map((l) => [l.threadId, l]));
  return rows.map((r) => {
    const l = lastOf.get(r.thread.id);
    return {
      id: r.thread.id,
      issue: issuesOf.get(r.thread.id)!,
      state: r.thread.state === "resolved" ? "resolved" : "open",
      members: members.get(r.thread.id) ?? [],
      last: l ? { id: l.id, authorId: l.authorId, preview: l.deletedAt ? "" : chatPreview(l.body), at: l.createdAt.getTime(), kind: l.kind === "system" ? "system" : "text", files: Number(l.files) } : null,
      unread: Number(r.unread),
      muted: r.muted === 1,
      pinned: r.pinned === 1,
      archived: r.archivedAt !== null,
      lastMessageAt: r.thread.lastMessageAt.getTime(),
      createdAt: r.thread.createdAt.getTime(),
    };
  });
}

/** One thread for its member; its issue snapshot refreshed from their own copy when that is newer. */
export async function threadView(userId: number, threadId: number): Promise<ChatThreadView> {
  const m = await memberOf(userId, threadId);
  await refreshSnapshot(userId, m.thread);
  const [row] = await getDb()
    .select({ thread: chatThreads, muted: chatMembers.muted, pinned: chatMembers.pinned, archivedAt: chatMembers.archivedAt, unread: unreadSql(userId) })
    .from(chatMembers)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMembers.threadId))
    .where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId)))
    .limit(1);
  if (!row) throw notFound();
  return (await threadViews(userId, [row]))[0];
}

/** The thread's key, title and status as the member's own copy has them (a move, a new status). */
async function refreshSnapshot(userId: number, th: ChatThread): Promise<void> {
  const conn = (await connectionsTo([userId], th, th.issueRemoteId)).get(userId);
  if (!conn) return;
  const row = await ownIssueRow(userId, conn.id, th.issueRemoteId, th.issueKey);
  if (!row || row.remoteId !== th.issueRemoteId) return;
  if (row.key === th.issueKey && row.summary === th.issueTitle && row.status === th.issueStatus && row.category === th.issueCategory) return;
  await getDb().update(chatThreads).set({ issueKey: row.key, issueTitle: row.summary, issueStatus: row.status, issueCategory: row.category }).where(eq(chatThreads.id, th.id));
}

/** The user's threads about one issue (theirs, by connection and key). */
export async function threadsForIssue(userId: number, connectionId: number, key: string): Promise<ChatThreadView[]> {
  const { tracker, remoteId } = await trackerOf(userId, connectionId, key);
  const rows = await getDb()
    .select({ thread: chatThreads, muted: chatMembers.muted, pinned: chatMembers.pinned, archivedAt: chatMembers.archivedAt, unread: unreadSql(userId) })
    .from(chatMembers)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMembers.threadId))
    .where(
      and(
        eq(chatMembers.userId, userId),
        isNull(chatMembers.leftAt),
        eq(chatThreads.trackerType, tracker.trackerType),
        eq(chatThreads.trackerBase, tracker.trackerBase),
        remoteId !== null ? eq(chatThreads.issueRemoteId, remoteId) : eq(chatThreads.issueKey, key),
      ),
    )
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(CHAT_THREADS_PAGE);
  return threadViews(userId, rows);
}

export type MessagesQuery = { threadId: number; before?: number; after?: number; around?: number };

/**
 * A page of a thread's messages, oldest first: the latest by default; `before`/`after` a
 * message id page back or forth; `around` centres on one (a link, the first unread).
 */
export async function messages(userId: number, query: MessagesQuery): Promise<{ messages: ChatMessageView[]; olderMore: boolean; newerMore: boolean }> {
  await memberOf(userId, query.threadId);
  const db = getDb();
  const base = eq(chatMessages.threadId, query.threadId);
  const older = async (beforeId: number | null, n: number) =>
    db.select().from(chatMessages).where(beforeId === null ? base : and(base, lt(chatMessages.id, beforeId))).orderBy(desc(chatMessages.id)).limit(n);
  const newer = async (afterId: number, n: number) => db.select().from(chatMessages).where(and(base, gt(chatMessages.id, afterId))).orderBy(asc(chatMessages.id)).limit(n);
  if (query.after !== undefined) {
    const rows = await newer(query.after, CHAT_PAGE + 1);
    return { messages: await views(rows.slice(0, CHAT_PAGE)), olderMore: true, newerMore: rows.length > CHAT_PAGE };
  }
  if (query.around !== undefined) {
    const half = Math.floor(CHAT_PAGE / 2);
    const [up, down] = await Promise.all([older(query.around, half + 1), newer(query.around - 1, half + 1)]);
    return { messages: await views([...up.slice(0, half).reverse(), ...down.slice(0, half)]), olderMore: up.length > half, newerMore: down.length > half };
  }
  const rows = await older(query.before ?? null, CHAT_PAGE + 1);
  return { messages: await views(rows.slice(0, CHAT_PAGE).reverse()), olderMore: rows.length > CHAT_PAGE, newerMore: false };
}

/** One message of a thread the user is in, or NOT_FOUND. */
async function messageIn(userId: number, messageId: number): Promise<MessageRow & { membership: Membership }> {
  const [row] = await getDb().select().from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!row) throw notFound();
  const membership = await memberOf(userId, row.threadId);
  return { ...row, membership };
}

// ---------------------------------------------------------------------------
// Writing

export type SendInput = { threadId: number; body: string; refs: ChatRef[]; fileIds: number[]; replyToId?: number; clientNonce: string; origin?: string };

/**
 * A message from a member. Sent twice with the same nonce (a retry), it is written once. A new
 * message opens a resolved thread again and brings it back to whoever archived it.
 */
export async function send(userId: number, input: SendInput): Promise<ChatMessageView> {
  const { thread } = await memberOf(userId, input.threadId);
  const body = input.body.trim();
  const fileIds = [...new Set(input.fileIds)];
  if (!body && input.refs.length === 0 && fileIds.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.chat.empty") });
  const db = getDb();
  const [known] = await db.select().from(chatMessages).where(and(eq(chatMessages.authorId, userId), eq(chatMessages.clientNonce, input.clientNonce))).limit(1);
  if (known) {
    if (known.threadId !== input.threadId) throw new TRPCError({ code: "CONFLICT", message: t("server.chat.nonceUsed") });
    return (await views([known]))[0];
  }
  if (input.replyToId !== undefined) {
    const [to] = await db.select({ threadId: chatMessages.threadId }).from(chatMessages).where(eq(chatMessages.id, input.replyToId)).limit(1);
    if (!to || to.threadId !== input.threadId) throw notFound();
  }
  const written = await db.transaction(async (tx) => {
    if (fileIds.length > 0) {
      const mine = await tx
        .select({ id: chatFiles.id })
        .from(chatFiles)
        .where(and(inArray(chatFiles.id, fileIds), eq(chatFiles.threadId, input.threadId), eq(chatFiles.uploaderId, userId), isNull(chatFiles.messageId)));
      if (mine.length !== fileIds.length) throw new TRPCError({ code: "NOT_FOUND", message: t("server.chat.fileNotFound") });
    }
    const now = new Date();
    const [m] = await tx
      .insert(chatMessages)
      .values({ threadId: input.threadId, authorId: userId, kind: "text", body, refs: JSON.stringify(input.refs), replyToId: input.replyToId ?? null, clientNonce: input.clientNonce, createdAt: now })
      .onConflictDoNothing({ target: [chatMessages.authorId, chatMessages.clientNonce] })
      .returning();
    if (!m) return null;
    if (fileIds.length > 0) await tx.update(chatFiles).set({ messageId: m.id }).where(inArray(chatFiles.id, fileIds));
    await tx
      .update(chatThreads)
      .set(thread.state === "resolved" ? { lastMessageAt: now, state: "open", resolvedBy: null, resolvedAt: null } : { lastMessageAt: now })
      .where(eq(chatThreads.id, input.threadId));
    await tx.update(chatMembers).set({ lastReadId: m.id }).where(and(eq(chatMembers.threadId, input.threadId), eq(chatMembers.userId, userId)));
    await tx.update(chatMembers).set({ archivedAt: null }).where(and(eq(chatMembers.threadId, input.threadId), isNull(chatMembers.leftAt)));
    return m;
  });
  // Lost the race to its own retry: the one that won is the message.
  const row = written ?? (await db.select().from(chatMessages).where(and(eq(chatMessages.authorId, userId), eq(chatMessages.clientNonce, input.clientNonce))).limit(1))[0];
  if (written) await tell(input.threadId, "message", userId, { messageId: written.id, origin: input.origin });
  return (await views([row]))[0];
}

/** A member's own message, rewritten. */
export async function edit(userId: number, messageId: number, body: string, origin?: string): Promise<void> {
  const m = await messageIn(userId, messageId);
  if (m.authorId !== userId || m.kind !== "text" || m.deletedAt) throw new TRPCError({ code: "FORBIDDEN", message: t("server.chat.notYours") });
  const text = body.trim();
  if (!text && parseRefs(m.refs).length === 0) {
    const [files] = await getDb().select({ n: sql<number>`count(*)::int` }).from(chatFiles).where(eq(chatFiles.messageId, messageId));
    if (Number(files.n) === 0) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.chat.empty") });
  }
  if (text === m.body) return;
  await getDb().update(chatMessages).set({ body: text, editedAt: new Date() }).where(eq(chatMessages.id, messageId));
  await tell(m.threadId, "edit", userId, { messageId, origin });
}

/** A member's own message, removed: the line stays (answers point at it), its words, cards, files and reactions go. */
export async function remove(userId: number, messageId: number, origin?: string): Promise<void> {
  const m = await messageIn(userId, messageId);
  if (m.authorId !== userId || m.kind !== "text") throw new TRPCError({ code: "FORBIDDEN", message: t("server.chat.notYours") });
  if (m.deletedAt) return;
  await getDb().transaction(async (tx) => {
    await tx.update(chatMessages).set({ body: "", refs: "[]", deletedAt: new Date() }).where(eq(chatMessages.id, messageId));
    await tx.delete(chatFiles).where(eq(chatFiles.messageId, messageId));
    await tx.delete(chatReactions).where(eq(chatReactions.messageId, messageId));
  });
  await tell(m.threadId, "edit", userId, { messageId, origin });
}

/** A reaction on or off. */
export async function react(userId: number, messageId: number, emoji: ChatReaction, on: boolean, origin?: string): Promise<void> {
  const m = await messageIn(userId, messageId);
  if (m.deletedAt || m.kind !== "text") throw notFound();
  const db = getDb();
  if (on) await db.insert(chatReactions).values({ messageId, userId, emoji }).onConflictDoNothing();
  else await db.delete(chatReactions).where(and(eq(chatReactions.messageId, messageId), eq(chatReactions.userId, userId), eq(chatReactions.emoji, emoji)));
  await tell(m.threadId, "react", userId, { messageId, origin });
}

/** Read up to a message: never moves back (a late call from another tab can't undo a newer read). */
export async function markRead(userId: number, threadId: number, messageId: number, origin?: string): Promise<void> {
  const m = await memberOf(userId, threadId);
  if (messageId <= m.lastReadId) return;
  const [msg] = await getDb().select({ threadId: chatMessages.threadId }).from(chatMessages).where(eq(chatMessages.id, messageId)).limit(1);
  if (!msg || msg.threadId !== threadId) throw notFound();
  const moved = await getDb()
    .update(chatMembers)
    .set({ lastReadId: messageId })
    .where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId), lt(chatMembers.lastReadId, messageId)))
    .returning({ id: chatMembers.lastReadId });
  if (moved.length > 0) await tell(threadId, "read", userId, { messageId, origin });
}

/** Resolved (the question had its answer) or open again. */
export async function setState(userId: number, threadId: number, state: ChatThreadState, origin?: string): Promise<void> {
  const { thread } = await memberOf(userId, threadId);
  if (thread.state === state) return;
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx
      .update(chatThreads)
      .set(state === "resolved" ? { state, resolvedBy: userId, resolvedAt: now, lastMessageAt: now } : { state, resolvedBy: null, resolvedAt: null, lastMessageAt: now })
      .where(eq(chatThreads.id, threadId));
    await systemLine(tx, threadId, userId, { kind: state === "resolved" ? "resolved" : "reopened" }, now);
  });
  await tell(threadId, "state", userId, { origin });
}

/** The member's own choices for a thread: muted, pinned, archived. */
export async function setPrefs(userId: number, threadId: number, prefs: { muted?: boolean; pinned?: boolean; archived?: boolean }, origin?: string): Promise<void> {
  await memberOf(userId, threadId);
  const set: Partial<typeof chatMembers.$inferInsert> = {};
  if (prefs.muted !== undefined) set.muted = prefs.muted ? 1 : 0;
  if (prefs.pinned !== undefined) set.pinned = prefs.pinned ? 1 : 0;
  if (prefs.archived !== undefined) set.archivedAt = prefs.archived ? new Date() : null;
  if (Object.keys(set).length === 0) return;
  await getDb().update(chatMembers).set(set).where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId)));
  // Only the member's own pages care.
  await tell(threadId, "prefs", userId, { origin, to: [userId] });
}

/** What the badges count: threads with news and their messages (muted and archived ones left out). */
export async function unreadCount(userId: number): Promise<{ threads: number; messages: number }> {
  const unread = unreadSql(userId);
  const [row] = await getDb()
    .select({ threads: sql<number>`count(*) FILTER (WHERE ${unread} > 0)::int`, messages: sql<number>`coalesce(sum(${unread}), 0)::int` })
    .from(chatMembers)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMembers.threadId))
    .where(and(eq(chatMembers.userId, userId), isNull(chatMembers.leftAt), isNull(chatMembers.archivedAt), eq(chatMembers.muted, 0)));
  return { threads: Number(row?.threads ?? 0), messages: Number(row?.messages ?? 0) };
}

/** Messages with this text in the user's threads, newest first. */
export async function search(userId: number, text: string): Promise<{ threadId: number; issueKey: string; message: ChatMessageView }[]> {
  const like = `%${text.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = await getDb()
    .select({ message: chatMessages, issueKey: chatThreads.issueKey })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .innerJoin(chatMembers, and(eq(chatMembers.threadId, chatMessages.threadId), eq(chatMembers.userId, userId), isNull(chatMembers.leftAt)))
    .where(and(eq(chatMessages.kind, "text"), isNull(chatMessages.deletedAt), sql`${chatMessages.body} ILIKE ${like}`, ne(chatMessages.body, "")))
    .orderBy(desc(chatMessages.id))
    .limit(CHAT_SEARCH_MAX);
  const vs = await views(rows.map((r) => r.message));
  return rows.map((r, i) => ({ threadId: r.message.threadId, issueKey: r.issueKey, message: vs[i] }));
}

/**
 * A message of the thread written on the tracker as a comment, by the caller (their own account,
 * through their own connection): their own words as they are, someone else's quoted with their
 * name. Once per message; the thread says it was published.
 */
export async function publish(user: User, messageId: number, origin?: string): Promise<{ commentId: string; issueKey: string; connectionId: number }> {
  const m = await messageIn(user.id, messageId);
  if (m.kind !== "text" || m.deletedAt || !m.body.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.chat.nothingToPublish") });
  if (m.jiraCommentId) throw new TRPCError({ code: "CONFLICT", message: t("server.chat.published") });
  const th = m.membership.thread;
  await refreshSnapshot(user.id, th);
  const conn = (await connectionsTo([user.id], th, th.issueRemoteId)).get(user.id);
  if (!conn) throw refused(t("server.chat.noConnectionYours", { tracker: trackerName(th.trackerBase) }));
  const row = await ownIssueRow(user.id, conn.id, th.issueRemoteId, th.issueKey);
  const key = row?.key ?? th.issueKey;
  let text = m.body;
  if (m.authorId !== user.id) {
    const [author] = m.authorId === null ? [] : await getDb().select({ name: users.displayName, username: users.username }).from(users).where(eq(users.id, m.authorId)).limit(1);
    const name = author ? author.name || author.username || "" : t("server.chat.someone");
    text = t("server.chat.quoted", { name }) + "\n\n" + m.body.split("\n").map((l) => "> " + l).join("\n");
  }
  // Claimed first: two clicks (two tabs) never write two comments.
  const [claimed] = await getDb()
    .update(chatMessages)
    .set({ jiraCommentId: "" })
    .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.jiraCommentId)))
    .returning({ id: chatMessages.id });
  if (!claimed) throw new TRPCError({ code: "CONFLICT", message: t("server.chat.published") });
  let commentId: string;
  try {
    commentId = (await addIssueComment(user, key, text, conn.id)).id;
  } catch (e) {
    await getDb().update(chatMessages).set({ jiraCommentId: null }).where(and(eq(chatMessages.id, messageId), eq(chatMessages.jiraCommentId, "")));
    throw e;
  }
  await getDb().transaction(async (tx) => {
    await tx.update(chatMessages).set({ jiraCommentId: commentId || "?" }).where(eq(chatMessages.id, messageId));
    await systemLine(tx, th.id, user.id, { kind: "published", messageId });
    await tx.update(chatThreads).set({ lastMessageAt: new Date() }).where(eq(chatThreads.id, th.id));
  });
  await tell(th.id, "edit", user.id, { messageId, origin });
  return { commentId, issueKey: key, connectionId: conn.id };
}

/** Members to tell that someone is typing (the typer's own other tabs too). */
export async function typingTargets(userId: number, threadId: number): Promise<number[]> {
  await memberOf(userId, threadId);
  return activeMemberIds(threadId);
}
