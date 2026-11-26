// Feedback kept on this server (contracts/feedback.ts): each person's own, its thread, its
// states. Who may see or change what is decided by the caller (api/routers/feedback.ts);
// here only the reading and writing, and the author's notifications.
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { feedback, feedbackComments, notifications, users, type Feedback } from "@db/schema";
import type { FeedbackOrigin, FeedbackStatus, FeedbackType } from "@contracts/feedback";
import { getDb } from "../queries/connection";

/** What a list or a filter narrows to. */
export type FeedbackFilter = { userId?: number; status?: FeedbackStatus; type?: FeedbackType; ids?: number[] };

/** A feedback as the page sees it: never the screenshot's bytes, only whether there is one. */
export type FeedbackView = Omit<Feedback, "screenshot" | "uid"> & { hasScreenshot: boolean; authorName: string };

const columns = {
  id: feedback.id,
  userId: feedback.userId,
  type: feedback.type,
  title: feedback.title,
  body: feedback.body,
  page: feedback.page,
  appVersion: feedback.appVersion,
  look: feedback.look,
  density: feedback.density,
  status: feedback.status,
  statusReason: feedback.statusReason,
  screenshotType: feedback.screenshotType,
  shareConsent: feedback.shareConsent,
  shareScreenshot: feedback.shareScreenshot,
  shareState: feedback.shareState,
  sharedAt: feedback.sharedAt,
  upstreamStatus: feedback.upstreamStatus,
  createdAt: feedback.createdAt,
  updatedAt: feedback.updatedAt,
  hasScreenshot: sql<boolean>`(${feedback.screenshot} IS NOT NULL)`,
  authorName: sql<string>`coalesce(${users.displayName}, '')`,
};

function whereOf(f: FeedbackFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (f.userId !== undefined) parts.push(eq(feedback.userId, f.userId));
  if (f.status) parts.push(eq(feedback.status, f.status));
  if (f.type) parts.push(eq(feedback.type, f.type));
  if (f.ids) parts.push(f.ids.length ? inArray(feedback.id, f.ids) : sql`false`);
  return parts.length ? and(...parts) : undefined;
}

/** Feedback matching `f`, newest first (at most `limit`). */
export async function listFeedback(f: FeedbackFilter, limit = 500): Promise<FeedbackView[]> {
  const rows = await getDb()
    .select(columns)
    .from(feedback)
    .leftJoin(users, eq(users.id, feedback.userId))
    .where(whereOf(f))
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, hasScreenshot: Boolean(r.hasScreenshot) }));
}

/** One feedback as the page sees it, or undefined. */
export async function feedbackById(id: number): Promise<FeedbackView | undefined> {
  return (await listFeedback({ ids: [id] }, 1))[0];
}

/** The row itself (the screenshot's bytes and uid included). */
export async function feedbackRow(id: number): Promise<Feedback | undefined> {
  const [row] = await getDb().select().from(feedback).where(eq(feedback.id, id)).limit(1);
  return row;
}

export type CommentView = {
  id: number;
  origin: FeedbackOrigin;
  authorId: number | null;
  authorName: string;
  body: string;
  statusFrom: string | null;
  statusTo: string | null;
  createdAt: Date;
};

/** A feedback's thread, oldest first. */
export async function commentsOf(feedbackIds: number[]): Promise<Map<number, CommentView[]>> {
  const out = new Map<number, CommentView[]>();
  if (feedbackIds.length === 0) return out;
  const rows = await getDb()
    .select({
      id: feedbackComments.id,
      feedbackId: feedbackComments.feedbackId,
      origin: feedbackComments.origin,
      authorId: feedbackComments.authorId,
      authorName: sql<string>`coalesce(${users.displayName}, '')`,
      body: feedbackComments.body,
      statusFrom: feedbackComments.statusFrom,
      statusTo: feedbackComments.statusTo,
      createdAt: feedbackComments.createdAt,
    })
    .from(feedbackComments)
    .leftJoin(users, eq(users.id, feedbackComments.authorId))
    .where(inArray(feedbackComments.feedbackId, feedbackIds))
    .orderBy(asc(feedbackComments.createdAt), asc(feedbackComments.id));
  for (const { feedbackId, ...r } of rows) {
    const list = out.get(feedbackId) ?? [];
    list.push({ ...r, origin: r.origin as FeedbackOrigin });
    out.set(feedbackId, list);
  }
  return out;
}

export type NewFeedback = {
  type: FeedbackType;
  title: string;
  body: string;
  page: string;
  appVersion: string;
  look: string;
  density: string;
  shareConsent: boolean;
  shareScreenshot: boolean;
};

/** A new feedback of `userId`'s; queued for the developers when its author agreed and sharing is on. */
export async function createFeedback(userId: number, f: NewFeedback, queue: boolean, now = new Date()): Promise<Feedback> {
  const [row] = await getDb()
    .insert(feedback)
    .values({
      uid: randomUUID(),
      userId,
      type: f.type,
      title: f.title,
      body: f.body,
      page: f.page,
      appVersion: f.appVersion,
      look: f.look,
      density: f.density,
      shareConsent: f.shareConsent ? 1 : 0,
      shareScreenshot: f.shareConsent && f.shareScreenshot ? 1 : 0,
      shareState: queue ? "queued" : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

/** The author is told in-app (the alerts list, about no tracker) that their feedback changed. */
/** The author's consent given later: their own, not shared yet, queued for the next batch. True when it was. */
export async function shareLater(id: number, userId: number, shareScreenshot: boolean, now = new Date()): Promise<boolean> {
  const rows = await getDb()
    .update(feedback)
    .set({ shareConsent: 1, shareScreenshot: shareScreenshot ? 1 : 0, shareState: "queued", updatedAt: now })
    .where(and(eq(feedback.id, id), eq(feedback.userId, userId), isNull(feedback.shareState)))
    .returning({ id: feedback.id });
  return rows.length > 0;
}

export async function notifyAuthor(row: Pick<Feedback, "id" | "userId" | "title">, what: "status" | "comment", now = Date.now()): Promise<void> {
  await getDb()
    .insert(notifications)
    .values({
      userId: row.userId,
      connectionId: null,
      kind: "alert",
      issueKey: "",
      detail: JSON.stringify({ kind: "feedback", name: row.title, ref: row.id, what }),
      dedupe: `feedback:${row.id}:${what}:${now}:${randomUUID().slice(0, 8)}`,
      createdAt: new Date(now),
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupe] });
}

/** A line in the thread; the author is told when someone else wrote it. */
export async function addComment(row: Pick<Feedback, "id" | "userId" | "title">, by: number | null, origin: FeedbackOrigin, body: string, now = new Date()): Promise<number> {
  const [c] = await getDb()
    .insert(feedbackComments)
    .values({ feedbackId: row.id, authorId: by, origin, body, createdAt: now })
    .returning({ id: feedbackComments.id });
  await getDb().update(feedback).set({ updatedAt: now }).where(eq(feedback.id, row.id));
  if (by !== row.userId) await notifyAuthor(row, "comment", now.getTime());
  return c.id;
}

/**
 * Moves a feedback to `to` (a rejection keeps its reason): one line in the thread, and its
 * author told unless they moved it themselves. Null when it already was there.
 */
export async function setFeedbackStatus(
  row: Pick<Feedback, "id" | "userId" | "title" | "status">,
  to: FeedbackStatus,
  o: { by: number | null; reason?: string | null; origin?: Extract<FeedbackOrigin, "status" | "upstream">; upstream?: FeedbackStatus; now?: Date },
): Promise<{ from: string; to: FeedbackStatus } | null> {
  const now = o.now ?? new Date();
  const reason = to === "rejected" ? (o.reason?.trim() || null) : null;
  const changed = await getDb().transaction(async (tx) => {
    const [cur] = await tx.select({ status: feedback.status }).from(feedback).where(eq(feedback.id, row.id)).for("update");
    if (!cur) return null;
    const upstream = o.upstream !== undefined ? { upstreamStatus: o.upstream } : {};
    if (cur.status === to) {
      if (o.upstream !== undefined) await tx.update(feedback).set(upstream).where(eq(feedback.id, row.id));
      return null;
    }
    await tx.update(feedback).set({ status: to, statusReason: reason, updatedAt: now, ...upstream }).where(eq(feedback.id, row.id));
    await tx.insert(feedbackComments).values({ feedbackId: row.id, authorId: o.by, origin: o.origin ?? "status", body: reason ?? "", statusFrom: cur.status, statusTo: to, createdAt: now });
    return { from: cur.status, to };
  });
  if (changed && o.by !== row.userId) await notifyAuthor(row, "status", now.getTime());
  return changed;
}

/** Shared feedback whose state is to be read back from the developers, oldest read first. */
export async function sentFeedback(limit: number): Promise<Feedback[]> {
  return getDb()
    .select()
    .from(feedback)
    .where(and(eq(feedback.shareState, "sent"), isNotNull(feedback.sharedAt)))
    .orderBy(desc(feedback.sharedAt))
    .limit(limit);
}
