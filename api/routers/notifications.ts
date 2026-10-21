import { notificationsInBucket } from "../queries/buckets";
import { notificationOnLiveConnection } from "../queries/liveConnections";
import { isClosed } from "@contracts/categories";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issues, notifications } from "@db/schema";
import {
  CRITICAL_PRIORITIES,
  NOTIFICATION_KINDS,
  isNotificationKind,
  type NotificationKind,
} from "@contracts/notifications";
import { addDays, dayKey } from "@contracts/time";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";

/** What the sync compares before / after to raise notifications. */
export type IssueSnapshotRow = {
  status: string;
  assigneeId: string;
  priority: string;
  /** 0 (highest) … 4; null when unknown */
  priorityRank: number | null;
  statusCategory: string;
  /** Canonical category (contracts/categories.ts) */
  category: string;
  dueDate: string | null;
  watching: number;
};

export type IssueSnapshot = Map<string, IssueSnapshotRow>;

/** Current state of one connection's catalog, by issue key. */
export async function snapshotIssues(userId: number, connectionId: number): Promise<IssueSnapshot> {
  const rows = await getDb()
      .select({
        key: issues.key,
        status: issues.status,
        assigneeId: issues.assigneeId,
        priority: issues.priority,
        priorityRank: issues.priorityRank,
        statusCategory: issues.statusCategory,
        category: issues.category,
        dueDate: issues.dueDate,
        watching: issues.watching,
      })
      .from(issues)
      .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId)));
  return new Map(rows.map(({ key, ...row }) => [key, row]));
}

type NewNotification = {
  connectionId: number;
  kind: NotificationKind;
  issueKey: string;
  detail: string;
  dedupe: string;
};

const CRITICAL = new Set(CRITICAL_PRIORITIES);

/** The top priority: rank 0 when the tracker's order is known, else a critical name (Highest, Blocker…). */
const critical = (r: Pick<IssueSnapshotRow, "priority" | "priorityRank">) => (r.priorityRank !== null ? r.priorityRank === 0 : CRITICAL.has(r.priority));

/** Days ahead (today included) a due date raises a "due" notification. */
const DUE_DAYS_AHEAD = 2;

/**
 * Notifications implied by the catalog change `before` → now. `syncStart`
 * tags the events that may legitimately repeat (a later re-assignment
 * notifies again); `watch` enables the watcher diff (full syncs only).
 * `before` / `after` are snapshots of the same connection.
 */
export function detectNotifications(
  before: IssueSnapshot,
  after: IssueSnapshot,
  me: string,
  connectionId: number,
  syncStart: number,
  opts: { watch: boolean },
): NewNotification[] {
  const today = dayKey(new Date(syncStart));
  const until = dayKey(addDays(new Date(syncStart), DUE_DAYS_AHEAD));
  const out: NewNotification[] = [];
  const add = (kind: NotificationKind, issueKey: string, dedupe: string, detail = "") =>
    out.push({ connectionId, kind, issueKey, detail, dedupe });
  // No watched issue known yet = watchers never recorded (first run, or the
  // first watcher search failed): record them silently, no avalanche.
  const watchersKnown = [...before.values()].some((p) => p.watching === 1);
  for (const [key, now] of after) {
    const prev = before.get(key);
    const mineNow = now.assigneeId === me;
    const minePrev = prev?.assigneeId === me;
    const open = !isClosed(now.category);
    if (mineNow && !minePrev) add("assigned", key, `assigned:${key}:${syncStart}`);
    if (prev && minePrev && !mineNow) add("unassigned", key, `unassigned:${key}:${syncStart}`);
    // New rows already get "assigned": the priority is news only when it changes.
    if (prev && mineNow && open && critical(now) && !critical(prev)) {
      add("priority", key, `priority:${key}:${now.priority}:${syncStart}`, now.priority);
    }
    if (mineNow && open && now.dueDate && now.dueDate >= today && now.dueDate <= until) {
      add("due", key, `due:${key}:${now.dueDate}`, now.dueDate);
    }
    if (opts.watch) {
      const wasWatching = (prev?.watching ?? 0) === 1;
      const watching = now.watching === 1;
      if (watching && !wasWatching && watchersKnown)
        add("watch_added", key, `watch_added:${key}:${syncStart}`);
      if (!watching && wasWatching) add("watch_removed", key, `watch_removed:${key}:${syncStart}`);
    }
  }
  return out;
}

/** Store notifications; already-known ones (same dedupe, per connection) are ignored. */
export async function insertNotifications(userId: number, items: NewNotification[], at: number) {
  if (items.length === 0) return;
  const createdAt = new Date(at);
  await getDb().transaction(async (tx) => {
    for (const n of items) {
      await tx.insert(notifications)
        .values({ userId, ...n, dedupe: `c${n.connectionId}:${n.dedupe}`, createdAt })
        .onConflictDoNothing({ target: [notifications.userId, notifications.dedupe] });
    }
  });
}

const undismissed = (userId: number) =>
  and(eq(notifications.userId, userId), isNull(notifications.dismissedAt));

/** What list and count show: known kinds, issue not hidden (or not in the catalog). */
const visible = (userId: number) =>
  and(
    undismissed(userId),
    inArray(notifications.kind, [...NOTIFICATION_KINDS]),
    sql`coalesce(${issues.hidden}, 0) = 0`,
    notificationOnLiveConnection,
  );

const joinIssue = and(
  eq(issues.userId, notifications.userId),
  eq(issues.connectionId, notifications.connectionId),
  eq(issues.key, notifications.issueKey),
);

/** Dismissed notifications are kept this long, then purged. */
const KEEP_DISMISSED_MS = 30 * 24 * 3600 * 1000;

/** Drop notifications dismissed long ago; returns how many were removed. */
export async function purgeDismissedNotifications(now: number = Date.now()): Promise<number> {
  const gone = await getDb()
    .delete(notifications)
    .where(lt(notifications.dismissedAt, new Date(now - KEEP_DISMISSED_MS)))
    .returning({ id: notifications.id });
  return gone.length;
}

export const notificationsRouter = createRouter({
  /** Undismissed notifications, newest first, with the issue's current details. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select({
        id: notifications.id,
        kind: notifications.kind,
        issueKey: notifications.issueKey,
        connectionId: notifications.connectionId,
        detail: notifications.detail,
        createdAt: notifications.createdAt,
        summary: issues.summary,
        priority: issues.priority,
        status: issues.status,
        statusCategory: issues.statusCategory,
        projectKey: issues.projectKey,
      })
      .from(notifications)
      .leftJoin(issues, joinIssue)
      .where(and(visible(ctx.user.id), await notificationsInBucket(ctx.user.id, ctx.deviceId)))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(50);
    return rows.flatMap(({ kind, ...r }) =>
      isNotificationKind(kind) ? [{ ...r, kind }] : [],
    );
  }),

  /** Undismissed count and newest id (the client notices new ones by id). */
  count: protectedProcedure.query(async ({ ctx }) => {
    const row = (await getDb()
      .select({
        count: sql<number>`count(*)`,
        latestId: sql<number | null>`max(${notifications.id})`,
      })
      .from(notifications)
      .leftJoin(issues, joinIssue)
      .where(and(visible(ctx.user.id), await notificationsInBucket(ctx.user.id, ctx.deviceId))).limit(1))[0];
    return { count: Number(row?.count ?? 0), latestId: row?.latestId ?? null };
  }),

  /**
   * A fake notification for Settings → "Test notifiche": local DB only, never Jira. It goes
   * through the real path (badge, "For you", toast). Defaults to one of the user's open issues
   * so the card shows real details.
   */
  createTest: protectedProcedure
    .input(z.object({ kind: z.enum(NOTIFICATION_KINDS), issueKey: issueKeyInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const [open] = input.issueKey ? [] : await getDb()
          .select({ key: issues.key, connectionId: issues.connectionId })
          .from(issues)
          .where(
            and(
              eq(issues.userId, ctx.user.id),
              eq(issues.hidden, 0),
              notInArray(issues.category, ["done", "cancelled"]),
            ),
          )
          .orderBy(desc(issues.activityAt))
          .limit(1);
      const issueKey = input.issueKey ?? open?.key ?? "TEST-1";
      // The chosen issue's connection; else the user's first live connection.
      const connectionId = open?.connectionId ?? (await issueConnection(ctx.user.id, issueKey)).id;
      const now = Date.now();
      const detail =
        input.kind === "priority"
          ? CRITICAL_PRIORITIES[0]
          : input.kind === "due"
            ? dayKey(new Date(now))
            : "";
      await insertNotifications(
        ctx.user.id,
        [{ connectionId, kind: input.kind, issueKey, detail, dedupe: `test:${input.kind}:${now}` }],
        now,
      );
      return { issueKey };
    }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const res = await getDb()
        .update(notifications)
        .set({ dismissedAt: new Date() })
        .where(and(undismissed(ctx.user.id), eq(notifications.id, input.id)))
        .returning({ id: notifications.id, dedupe: notifications.dedupe });
      // From a tracker's inbox: read there too.
      await (await import("../sync/inboxRead")).markInboxRead(ctx.user.id, res.map((r) => r.dedupe));
      return { dismissed: res.length };
    }),

  dismissAll: protectedProcedure.mutation(async ({ ctx }) => {
    // On a device with a bucket, that bucket's only: the others were never shown here.
    const inBucket = await notificationsInBucket(ctx.user.id, ctx.deviceId);
    const db = getDb();
    const res = await db
      .update(notifications)
      .set({ dismissedAt: new Date() })
      .where(
        inBucket
          ? inArray(
              notifications.id,
              db.select({ id: notifications.id }).from(notifications).leftJoin(issues, joinIssue).where(and(undismissed(ctx.user.id), inBucket)),
            )
          : undismissed(ctx.user.id),
      )
      .returning({ id: notifications.id, dedupe: notifications.dedupe });
    await (await import("../sync/inboxRead")).markInboxRead(ctx.user.id, res.map((r) => r.dedupe));
    return { dismissed: res.length };
  }),
});
