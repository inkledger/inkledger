import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { activity, connections, containers, issues, itemAliases, type Connection, syncState, timers, worklogs, type User, type Issue } from "@db/schema";
import { boundTracker, syncConnectionEntries, syncConnectionIssues, withStream } from "../sync/engine";
import { toRichDoc } from "../providers/core/richtext";
import { replayContract } from "../sync/timeWrites";
import { fieldsOf, upsertRemote } from "../sync/issues";
import { compileIssueQuery, mentions, UNREAD_SQL } from "../queries/issueQuery";
import { parseQuery, queryText } from "@contracts/query";
import { providerName } from "@contracts/providerNames";
import { onLiveConnection } from "../queries/liveConnections";
import { issuesInBucket } from "../queries/buckets";
import { isClosed } from "@contracts/categories";

/** Finished one way or the other. */
const CLOSED = ["done", "cancelled"];
import { providerCall } from "../providers/trpc";
import { assertTransitionFields, executable } from "../providers/core/fields";
import { localDate, markdown } from "@contracts/values";
import { randomUUID } from "node:crypto";
import type { FieldValue, RemoteBody, RemoteIssue } from "../providers/types";
import { env } from "../lib/env";
import { issueKeyInput, LIST_MAX_ROWS } from "../lib/inputs";
import { buildTimeline } from "../lib/history";
import { signShare } from "../lib/shareLinks";
import { getSettings } from "./settings";
import { issueMarkdown } from "@contracts/issueCopy";
import {
  fetchIssueByKey,
  setWatching,
  fetchIssueHistory,
  fetchAttachments,
  fetchRemoteLinks,
} from "../jira/client";
import { t } from "@contracts/i18n";
import { contextFor, issueConnection, ownConnection, jiraContextFor, myRemoteIds } from "../providers/connections";
import { runSync, toRow, upsertIssue } from "../sync/jiraIssues";
import { syncUser } from "../sync/orchestrator";
import { callMeta, searchConnection } from "../issues/search";

export { settleInFlightSyncs, syncUser } from "../sync/orchestrator";

/** The user looked at (or acted on) an issue: its activity so far is read. */
async function markSeen(userId: number, key: string, connectionId: number) {
  await getDb()
    .update(issues)
    .set({ seenAt: Date.now() })
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.key, key)));
}

/** Others' activity newer than the last visit (my own actions are never news). */
const UNREAD = sql<number>`(CASE WHEN ${issues.othersActivityAt} IS NOT NULL AND ${issues.othersActivityAt} > coalesce(${issues.seenAt}, 0) THEN 1 ELSE 0 END)`;

/** My own time on the issue (its tracker's total counts everyone's). */
const MY_SPENT = sql<number>`(SELECT coalesce(sum(${worklogs.timeSpentSeconds}), 0)::int FROM ${worklogs}
  WHERE ${worklogs.userId} = ${issues.userId} AND ${worklogs.connectionId} = ${issues.connectionId} AND ${worklogs.issueKey} = ${issues.key})`;

/** Most urgent first; unknown priorities last. */
/** The tracker's own order when known (rank 0–4), else known names; unknown last. */
const PRIORITY_ORDER = sql`coalesce(${issues.priorityRank} * 2, CASE ${issues.priority}
  WHEN 'Blocker' THEN 0 WHEN 'Bloccante' THEN 0 WHEN 'Highest' THEN 1 WHEN 'Massima' THEN 1
  WHEN 'Critical' THEN 2 WHEN 'Critica' THEN 2 WHEN 'High' THEN 3 WHEN 'Alta' THEN 3
  WHEN 'Urgente' THEN 3 WHEN 'Major' THEN 4 WHEN 'Maggiore' THEN 4 WHEN 'Medium' THEN 5
  WHEN 'Media' THEN 5 WHEN 'Normale' THEN 5 WHEN 'Minor' THEN 6 WHEN 'Minore' THEN 6
  WHEN 'Low' THEN 7 WHEN 'Bassa' THEN 7 WHEN 'Lowest' THEN 8 WHEN 'Minima' THEN 8
  WHEN 'Trivial' THEN 9 WHEN 'Banale' THEN 9 ELSE 10 END)`;

/** Latest Jira update first; the text fallback covers rows not re-synced yet. */
const BY_UPDATED = [desc(issues.remoteUpdatedAt), desc(issues.remoteUpdated)];

function orderFor(sort: "activity" | "updated" | "priority" | "key" | "due") {
  switch (sort) {
    case "activity":
      return [
        asc(sql`${issues.activityAt} IS NULL`),
        desc(issues.activityAt),
        ...BY_UPDATED,
      ];
    case "priority":
      return [asc(PRIORITY_ORDER), ...BY_UPDATED];
    case "key":
      // The number a key ends with, whatever its shape (APP-12, owner/repo#12).
      return [asc(issues.projectKey), asc(sql`CAST(substring(${issues.key} from '(\d+)$') AS INTEGER)`), asc(issues.key)];
    case "due":
      return [asc(sql`${issues.dueDate} IS NULL`), asc(issues.dueDate)];
    default:
      return BY_UPDATED;
  }
}

/** Escape LIKE wildcards; pair with `ESCAPE '\\'`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The user's live trackers, in the order they were added. */
async function liveTrackers(userId: number): Promise<Connection[]> {
  return getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), isNull(connections.archivedAt), eq(connections.status, "ok")))
    .orderBy(asc(connections.id));
}

/** A catalogue row as lists read it: everything but the raw fields (T8: never in lists). */
const listColumns = (() => {
  const { raw, ...rest } = getTableColumns(issues);
  void raw;
  return rest;
})();

/** Each connection's projects or repositories, read live at most every 10 minutes. */
const containerCache = new Map<number, { at: number; list: { key: string; name: string }[] }>();

/** A connection's containers: live from its tracker (cached), else the ones the catalogue knows. */
async function containersOf(conn: Connection, b: NonNullable<ReturnType<typeof boundTracker>>): Promise<{ key: string; name: string }[]> {
  const cached = containerCache.get(conn.id);
  if (cached && cached.at > Date.now() - 10 * 60_000) return cached.list;
  if (b.containers) {
    try {
      const list = (await b.containers(callMeta())).map((c) => ({ key: c.key, name: c.name ?? c.key }));
      containerCache.set(conn.id, { at: Date.now(), list });
      return list;
    } catch (e) {
      // Offline or no permission: the ones already known are still enough to create.
      console.warn(`[issues.createTargets] ${conn.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return (await getDb().select({ key: containers.key, name: containers.name }).from(containers).where(eq(containers.connectionId, conn.id))).map((c) => ({ key: c.key, name: c.name ?? c.key }));
}

/** A transition field's value, as the form sends it (checked against the field by the core). */
const fieldValueInput = z.union([
  z.string().max(10_000),
  z.number(),
  z.array(z.string().max(200)).max(100),
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ user: z.string().min(1).max(200) }),
]);

/** The user's tracker for an issue, bound, and the issue's reference on it. */
/** The issue's tracker, bound to its connection, and the issue's reference on it. */
async function boundFor(user: User, key: string, connectionId?: number) {
  const conn = await issueConnection(user.id, key, connectionId);
  const b = boundTracker(conn);
  if (!b) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.auth.noConnection") });
  const [row] = await getDb()
    .select({ remoteId: issues.remoteId })
    .from(issues)
    .where(and(eq(issues.userId, user.id), eq(issues.connectionId, conn.id), eq(issues.key, key)))
    .limit(1);
  return { conn, b, ref: { remoteId: row?.remoteId ?? key, key } };
}

async function trackerFor(user: User, key: string, connectionId?: number) {
  const found = await boundFor(user, key, connectionId);
  if (!found.b.transitions?.list || !found.b.transitions.apply) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.auth.noConnection") });
  }
  return found;
}

/**
 * The issue's tracker through the provider contract when it isn't Jira
 * (Jira keeps its own calls until it moves over), else null.
 */
async function otherTracker(user: User, key: string, connectionId?: number) {
  const conn = await issueConnection(user.id, key, connectionId);
  return conn.type === "jira" ? null : boundFor(user, key, conn.id);
}

type ManageOp = "assignable" | "assign" | "labelOptions" | "setLabels" | "edit";

/** The issue's tracker when it can do `op`, with the issue's reference, container and my id there. */
async function managed(user: User, key: string, connectionId: number | undefined, op: ManageOp) {
  const found = await boundFor(user, key, connectionId);
  if (!found.b.manage?.[op]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.issues.cannotManage", { provider: providerName(found.conn.type) }) });
  const [row] = await getDb()
    .select({ projectKey: issues.projectKey })
    .from(issues)
    .where(and(eq(issues.userId, user.id), eq(issues.connectionId, found.conn.id), eq(issues.key, key)))
    .limit(1);
  const containerKey = row?.projectKey ?? key.replace(/#\d+$/, "").replace(/-\d+$/, "");
  return { ...found, ref: { ...found.ref, me: found.conn.remoteAccountId }, container: { remoteId: containerKey, key: containerKey } };
}

/** After a change: the issue as the tracker now has it, in the catalogue. */
async function refreshManaged(userId: number, m: Awaited<ReturnType<typeof managed>>, after: RemoteIssue | null) {
  const now = after ?? (await providerCall(() => m.b.getIssue(callMeta(), m.ref)));
  if (now) await upsertRemote({ userId, connectionId: m.conn.id }, now);
  return { key: now?.key ?? m.ref.key, title: now?.title ?? null, labels: now?.labels ?? [], assignees: (now?.assignees ?? []).map((p) => p.name) };
}

/** An issue of another tracker into the catalogue (read live, already seen): its key. */
async function importRemote(userId: number, found: Awaited<ReturnType<typeof boundFor>>): Promise<string> {
  const hit = await providerCall(() => found.b.findIssue(callMeta(), { key: found.ref.key }));
  if (hit.kind !== "found") throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFoundOnJiraKey", { key: found.ref.key }) });
  await upsertRemote({ userId, connectionId: found.conn.id }, hit.issue);
  await markSeen(userId, hit.issue.key, found.conn.id);
  return hit.issue.key;
}

/** A body as plain text (structured ones by their preview), until RichText renders them. */
const textOf = (b: RemoteBody | null) => (b === null ? "" : b.kind === "text" ? b.text : b.preview).trim();

/** Which connection an issue is on, when the caller knows (its link says it): needed only when a key is on two. */
const onConnection = { connectionId: z.number().int().positive().optional() };

/** The user's issues in compact form (board, palette, pickers, the sidebar's favorites), narrowed by `narrow`. */
async function compactIssues(userId: number, narrow: SQL | undefined) {
  const rows = await getDb()
    .select({
      key: issues.key,
      // Its identity, for links that survive a key change
      connectionId: issues.connectionId,
      remoteId: issues.remoteId,
      summary: issues.summary,
      status: issues.status,
      statusCategory: issues.statusCategory,
      category: issues.category,
      projectKey: issues.projectKey,
      issueType: issues.issueType,
      priority: issues.priority,
      priorityRank: issues.priorityRank,
      favorite: issues.favorite,
      favoriteRank: issues.favoriteRank,
      hidden: issues.hidden,
      watching: issues.watching,
      dueDate: issues.dueDate,
      assigneeId: issues.assigneeId,
      remoteUpdated: issues.remoteUpdated,
      remoteUpdatedAt: issues.remoteUpdatedAt,
      remoteCreatedAt: issues.remoteCreatedAt,
      activityAt: issues.activityAt,
      unread: UNREAD,
    })
    .from(issues)
    .where(and(eq(issues.userId, userId), onLiveConnection, narrow))
    .orderBy(desc(issues.favorite), asc(issues.favoriteRank), ...BY_UPDATED)
    .limit(LIST_MAX_ROWS);
  // Mine: assigned to me on any of my connections (Jira, GitHub…).
  const myIds = new Set(await myRemoteIds(userId));
  return rows.map(({ assigneeId, unread, remoteUpdatedAt, remoteCreatedAt, activityAt, ...r }) => ({
    ...r,
    unread: unread === 1,
    isMine: assigneeId !== null && myIds.has(assigneeId),
    /** Most relevant moment: last change, activity (comment, status) or creation */
    relevantAt: Math.max(remoteUpdatedAt ?? 0, activityAt ?? 0, remoteCreatedAt ?? 0) || null,
  }));
}

export const issuesRouter = createRouter({
  /** Pull assigned (and watched) issues from Jira and upsert them locally: always full. */
  sync: protectedProcedure.mutation(({ ctx }) => syncUser(ctx.user, { full: true })),

  /**
   * One connection now (Settings → Connections): its changes since the last
   * pass, or with `reconcile` everything again, asking for the issues it no
   * longer lists one by one.
   */
  syncConnection: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), reconcile: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const conn = await ownConnection(ctx.user.id, input.id);
      if (conn.type === "jira") {
        const run = await withStream(conn, "issues", { full: input.reconcile, background: false }, async () => ({ result: await runSync(ctx.user, conn, input.reconcile) }));
        if (!run.ran) throw new TRPCError({ code: "CONFLICT", message: t("server.issues.syncBusy") });
        return { synced: run.result.synced };
      }
      const run = await syncConnectionIssues(conn, { full: input.reconcile, background: false });
      if (!run.ran) throw new TRPCError({ code: "CONFLICT", message: t("server.issues.syncBusy") });
      await replayContract(conn);
      await syncConnectionEntries(conn, { full: input.reconcile, background: false });
      return { synced: run.result.seen, missing: run.result.missing };
    }),

  /** Last sync outcome, polled by the client to refresh after background syncs. */
  syncStatus: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select()
      .from(syncState)
      .where(eq(syncState.userId, ctx.user.id))
      .limit(1);
    const s = rows[0];
    return {
      lastSyncAt: s?.lastSyncAt ?? null,
      // An error older than the last success is stale.
      lastError:
        s?.lastError && (!s.lastSyncAt || (s.lastErrorAt ?? 0) >= s.lastSyncAt)
          ? s.lastError
          : null,
      intervalMin: env.syncIntervalMin,
    };
  }),

  /**
   * Search every connected tracker at once (any issue, not only mine), not
   * stored: a key or link finds that issue, words go to each tracker's own
   * search. A tracker that doesn't answer is named, the others still show.
   */
  search: protectedProcedure
    .input(z.object({ query: z.string().trim().min(2).max(200) }))
    .query(async ({ ctx, input }) => {
      const conns = await liveTrackers(ctx.user.id);
      const each = await Promise.all(conns.map((conn) => searchConnection(ctx.user, conn, input.query)));
      const exact = input.query.toLowerCase();
      return {
        // The key asked for first, then each tracker's own order.
        results: each.flatMap((e) => e.results).sort((a, z2) => Number(z2.key.toLowerCase() === exact) - Number(a.key.toLowerCase() === exact)),
        failed: each.flatMap((e) => (e.failed ? [e.failed] : [])),
        unsupported: [...new Set(each.flatMap((e) => e.unsupported))],
      };
    }),

  /**
   * A key or link someone pasted, as the issues it names: in the catalogue
   * first, then asked of the tracker it belongs to. Empty when it isn't one.
   */
  open: protectedProcedure
    .input(z.object({ text: z.string().trim().min(2).max(500) }))
    .query(async ({ ctx, input }) => {
      const conns = await liveTrackers(ctx.user.id);
      const named = conns.flatMap((conn) => {
        const b = boundTracker(conn);
        const handle = b?.parseRef(input.text) ?? null;
        return b && handle ? [{ conn, b, handle }] : [];
      });
      const found = await Promise.all(
        named.map(async ({ conn, b, handle }) => {
          const [known] = await getDb()
            .select({ key: issues.key, remoteId: issues.remoteId })
            .from(issues)
            .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, conn.id), handle.remoteId ? eq(issues.remoteId, handle.remoteId) : sql`lower(${issues.key}) = lower(${handle.key})`))
            .limit(1);
          if (known) return [{ connectionId: conn.id, key: known.key, remoteId: known.remoteId, inCatalogue: true }];
          const hit = await b.findIssue(callMeta(), handle).catch(() => ({ kind: "none" as const }));
          if (hit.kind === "found") return [{ connectionId: conn.id, key: hit.issue.key, remoteId: hit.issue.remoteId, inCatalogue: false }];
          if (hit.kind === "ambiguous") return hit.candidates.map((i) => ({ connectionId: conn.id, key: i.key, remoteId: i.remoteId, inCatalogue: false }));
          return [];
        }),
      );
      return found.flat();
    }),

  /** One connection's answer to a search (the page asks each on its own: results arrive as each tracker answers). */
  searchOn: protectedProcedure
    .input(z.object({ connectionId: z.number().int().positive(), query: z.string().trim().min(2).max(200) }))
    .query(async ({ ctx, input }) => searchConnection(ctx.user, await ownConnection(ctx.user.id, input.connectionId), input.query)),

  /** Who changed what and when (Jira changelog, comments, creation): read-only. */
  history: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      // Other trackers: what inkledger saw change between syncs (activity), and when it was made.
      const other = await otherTracker(ctx.user, input.key, input.connectionId);
      if (other) {
        const [row] = await getDb()
          .select({ id: issues.id, createdAt: issues.remoteCreatedAt, reporter: issues.reporterName })
          .from(issues)
          .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, other.conn.id), eq(issues.key, input.key)))
          .limit(1);
        const seen = row ? await getDb().select().from(activity).where(eq(activity.itemId, row.id)).orderBy(desc(activity.at)).limit(200) : [];
        return buildTimeline({
          created: row?.createdAt ? new Date(row.createdAt).toISOString() : null,
          reporter: row?.reporter || null,
          histories: seen.map((a) => ({ created: a.at.toISOString(), items: [{ field: a.field, fromString: a.fromValue, toString: a.toValue }] })),
          comments: [],
        });
      }
      return buildTimeline(await fetchIssueHistory((await jiraContextFor(ctx.user, input.key, input.connectionId)).creds, input.key));
    }),

  /**
   * Follow (or stop following) an issue on its tracker, like its "Watch" button.
   * An issue not in the catalog yet is imported first, so it shows up in
   * the "Watching" view and its changes come as notifications.
   */
  watch: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, watch: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const other = await otherTracker(ctx.user, input.key, input.connectionId);
      if (other) {
        if (!other.b.watch) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.issues.cannotManage", { provider: providerName(other.conn.type) }) });
        await providerCall(() => other.b.watch!(callMeta(), other.ref, input.watch));
        if (input.watch) await importRemote(ctx.user.id, other);
        await getDb()
          .update(issues)
          .set({ watching: input.watch ? 1 : 0 })
          .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, other.conn.id), eq(issues.key, input.key)));
        return { key: input.key, watching: input.watch };
      }
      const { user, creds } = await jiraContextFor(ctx.user, input.key, input.connectionId);
      const db = getDb();
      const known = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, user.connectionId), eq(issues.key, input.key)));
      await setWatching(creds, input.key, user.accountId, input.watch);
      if (!known[0] && input.watch) {
        const remote = await fetchIssueByKey(creds, input.key);
        if (remote) {
          await upsertIssue(user.id, user.siteUrl, user.connectionId, remote);
          await markSeen(user.id, remote.key, user.connectionId);
        }
      }
      // Local flag right away: the next full sync agrees, so no "watch" news.
      await db
        .update(issues)
        .set({ watching: input.watch ? 1 : 0 })
        .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, user.connectionId), eq(issues.key, input.key)));
      return { key: input.key, watching: input.watch };
    }),

  /** Import a single issue (any assignee) into the local catalog. */
  import: protectedProcedure
    .input(
      z.object({ ...onConnection, key: issueKeyInput }),
    )
    .mutation(async ({ ctx, input }) => {
      const other = await otherTracker(ctx.user, input.key, input.connectionId);
      if (other) return { imported: await importRemote(ctx.user.id, other) };
      const { user, creds } = await jiraContextFor(ctx.user, input.key, input.connectionId);
      const remote = await fetchIssueByKey(creds, input.key);
      if (!remote) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: t("server.issues.notFoundOnJiraKey", { key: input.key }),
        });
      }
      await upsertIssue(user.id, user.siteUrl, user.connectionId, remote);
      // Imported on purpose: nothing in it is news.
      await markSeen(ctx.user.id, remote.key, user.connectionId);
      return { imported: remote.key };
    }),

  /** Star/unstar an issue as favorite; a new favorite goes last in the order. */
  toggleFavorite: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.key, input.connectionId);
      // read max rank + write atomically: two quick stars must not share a rank
      return getDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ctx.user.id})`);
        const row = (await tx
          .select({ id: issues.id, favorite: issues.favorite })
          .from(issues)
          .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, conn.id), eq(issues.key, input.key))).limit(1))[0];
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
        }
        const next = row.favorite === 1 ? 0 : 1;
        const [top] = await tx
          .select({ maxRank: sql<number>`coalesce(max(${issues.favoriteRank}), 0)` })
          .from(issues)
          .where(and(eq(issues.userId, ctx.user.id), eq(issues.favorite, 1)));
        const maxRank = Number(top?.maxRank ?? 0);
        await tx.update(issues)
          .set(
            next === 1
              ? { favorite: 1, favoriteRank: maxRank + 1, hidden: 0 }
              : { favorite: 0, favoriteRank: 0 },
          )
          .where(eq(issues.id, row.id));
        return { key: input.key, favorite: next === 1 };
      });
    }),

  /**
   * Hide / restore an issue. Hidden issues stay in sync but leave every list;
   * hiding also drops the favorite (returned, so "Undo" can restore it).
   */
  setHidden: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, hidden: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const conn = await issueConnection(ctx.user.id, input.key, input.connectionId);
      const rows = await db
        .select({ id: issues.id, favorite: issues.favorite, rank: issues.favoriteRank })
        .from(issues)
        .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, conn.id), eq(issues.key, input.key)))
        .limit(1);
      if (!rows[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
      }
      await db
        .update(issues)
        .set(input.hidden ? { hidden: 1, favorite: 0, favoriteRank: 0 } : { hidden: 0 })
        .where(eq(issues.id, rows[0].id));
      return {
        key: input.key,
        hidden: input.hidden,
        wasFavorite: rows[0].favorite === 1,
        previousRank: rows[0].rank,
      };
    }),

  /** Manual order of the favorites: `keys` top to bottom. */
  reorderFavorites: protectedProcedure
    .input(
      z.object({
        keys: z.array(z.string().min(1)).max(500).default([]),
        /** Same order with the connection of each issue (keys alone match every connection with that key). */
        items: z.array(z.object({ key: z.string().min(1), connectionId: z.number().int().positive().optional() })).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const order = input.items ?? input.keys.map((key) => ({ key, connectionId: undefined }));
      await getDb().transaction(async (tx) => {
        for (const [i, { key, connectionId }] of order.entries()) {
          await tx
            .update(issues)
            .set({ favoriteRank: i + 1 })
            .where(
              and(
                eq(issues.userId, ctx.user.id),
                eq(issues.key, key),
                eq(issues.favorite, 1),
                ...(connectionId !== undefined ? [eq(issues.connectionId, connectionId)] : []),
              ),
            );
        }
      });
      return { ok: true };
    }),

  /**
   * Delete local issues nobody needs: no tracked worklogs, no timer, not
   * favorite or hidden (user choices), not open and assigned to me.
   */
  cleanup: protectedProcedure.mutation(async ({ ctx }) => {
    const db = getDb();
    const tracked = await db
      .select({ issueKey: worklogs.issueKey, connectionId: worklogs.connectionId })
      .from(worklogs)
      .where(eq(worklogs.userId, ctx.user.id))
      .groupBy(worklogs.issueKey, worklogs.connectionId);
    const timed = await db
      .select({ issueKey: timers.issueKey, connectionId: timers.connectionId })
      .from(timers)
      .where(eq(timers.userId, ctx.user.id));
    const keep = new Set([...tracked, ...timed].map((t) => `${t.connectionId}:${t.issueKey}`));

    const local = await db
      .select({
        id: issues.id,
        key: issues.key,
        connectionId: issues.connectionId,
        favorite: issues.favorite,
        hidden: issues.hidden,
        watching: issues.watching,
        assigneeId: issues.assigneeId,
        category: issues.category,
      })
      .from(issues)
      .where(eq(issues.userId, ctx.user.id));
    const myIds = new Set(await myRemoteIds(ctx.user.id));
    const toDelete = local
      .filter(
        (l) =>
          !keep.has(`${l.connectionId}:${l.key}`) &&
          l.favorite !== 1 &&
          l.hidden !== 1 &&
          l.watching !== 1 &&
          !(myIds.has(l.assigneeId) && !isClosed(l.category)),
      )
      .map((l) => l.id);

    if (toDelete.length > 0) {
      await db.delete(issues).where(inArray(issues.id, toDelete));
    }
    return { deleted: toDelete.length, kept: local.length - toDelete.length };
  }),

  /**
   * The fields of the issue inkledger doesn't map (custom fields, milestone…),
   * read live; the last read is kept (T8: at most 32 KB) and shown, marked,
   * when the tracker can't be reached.
   */
  otherFields: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      const found = await boundFor(ctx.user, input.key, input.connectionId);
      if (!found.b.otherFields) return { fields: [], stale: false };
      const where = and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, found.conn.id), eq(issues.key, input.key));
      try {
        const fields = await providerCall(() => found.b.otherFields!(callMeta(), found.ref));
        const raw = JSON.stringify(fields);
        if (raw.length <= 32 * 1024) await getDb().update(issues).set({ raw }).where(where);
        return { fields, stale: false };
      } catch (e) {
        const [row] = await getDb().select({ raw: issues.raw }).from(issues).where(where).limit(1);
        if (!row?.raw) throw e;
        return { fields: JSON.parse(row.raw) as { name: string; value: string }[], stale: true };
      }
    }),

  /** The issue's description on its tracker (fetched on demand, not stored): its text and its rich-text tree. */
  description: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      const { b, ref } = await boundFor(ctx.user, input.key, input.connectionId);
      const body = b.description ? await providerCall(() => b.description!(callMeta(), ref)) : null;
      return { text: textOf(body), doc: toRichDoc(body) };
    }),

  /** The issue's comments, newest first, each as text and as a rich-text tree. */
  comments: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      const { b, ref, conn } = await boundFor(ctx.user, input.key, input.connectionId);
      if (!b.comments) return [];
      const remote = await providerCall(() => b.comments!.list(callMeta(), ref));
      return remote
        .map((c) => ({
          id: c.id,
          author: c.author.name || "—",
          // Me on this issue's connection.
          isMine: c.author.remoteId === conn.remoteAccountId,
          body: textOf(c.body),
          doc: toRichDoc(c.body),
          created: new Date(c.createdAt ?? 0).toISOString(),
          edited: !!c.updatedAt && c.updatedAt !== c.createdAt,
        }))
        .reverse();
    }),

  addComment: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, text: z.string().trim().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => {
      const { b, ref, conn } = await boundFor(ctx.user, input.key, input.connectionId);
      if (!b.comments?.add) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.issues.cannotManage", { provider: providerName(conn.type) }) });
      const added = await providerCall(() => b.comments!.add!(callMeta(), ref, markdown(input.text), { idempotencyKey: randomUUID() }));
      await markSeen(ctx.user.id, input.key, conn.id);
      return { id: added.comment?.id ?? "" };
    }),

  /** Attachment metadata; content is served by GET /api/attachments/:id/:kind. */
  attachments: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      // Attachments are Jira's alone for now (no contract operation yet).
      if (await otherTracker(ctx.user, input.key, input.connectionId)) return [];
      const list = await fetchAttachments((await jiraContextFor(ctx.user, input.key, input.connectionId)).creds, input.key);
      return list.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType ?? "application/octet-stream",
        size: a.size ?? 0,
        created: a.created ?? null,
        author: a.author?.displayName ?? null,
        hasThumbnail: !!a.thumbnail,
      }));
    }),

  /**
   * The issue as Markdown for an agent the user pastes it into: header,
   * description, every attachment as a link through this app that opens
   * without a session until it expires (docs/work/ideas/issue-copy.md).
   */
  copyForAgent: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, minutes: z.number().int().min(5).max(1440).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { b, ref, conn } = await boundFor(ctx.user, input.key, input.connectionId);
      const [row] = await getDb()
        .select({ summary: issues.summary, status: issues.status, issueType: issues.issueType, url: issues.url })
        .from(issues)
        .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, conn.id), eq(issues.key, input.key)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
      const prefs = await getSettings(ctx.user.id);
      const now = Date.now();
      const exp = now + (input.minutes ?? prefs.shareLinkMinutes) * 60_000;
      const body = b.description ? await providerCall(() => b.description!(callMeta(), ref)) : null;
      // Attachments are Jira's alone for now (GitHub follows: batch C4).
      const files = conn.type === "jira" ? await fetchAttachments(contextFor(ctx.user, conn).creds, input.key) : [];
      const origin = new URL(ctx.req.url).origin;
      const attachments = files.map((f) => ({
        name: f.filename,
        url: `${origin}/api/shared/${signShare({ u: ctx.user.id, c: conn.id, a: f.id, iat: now, exp, g: prefs.shareLinkGeneration })}`,
      }));
      const markdown = issueMarkdown(
        { key: input.key, title: row.summary, url: row.url, status: row.status, type: row.issueType || null },
        toRichDoc(body),
        attachments,
      );
      return { markdown, expiresAt: new Date(exp) };
    }),

  /** Links to other services on the issue (read only); only http(s) URLs. */
  remoteLinks: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      if (await otherTracker(ctx.user, input.key, input.connectionId)) return [];
      const list = await fetchRemoteLinks((await jiraContextFor(ctx.user, input.key, input.connectionId)).creds, input.key);
      return list.flatMap((l) => {
        const url = l.object?.url;
        if (!url || !/^https?:\/\//i.test(url)) return [];
        return [
          {
            id: l.id,
            url,
            title: l.object?.title || url,
            summary: l.object?.summary ?? null,
            app: l.application?.name ?? l.object?.icon?.title ?? null,
          },
        ];
      });
    }),

  /** Statuses the issue can move to from its current one (Jira workflow). */
  /**
   * The ways out of the issue's status, now: each with the fields it asks
   * for, whether inkledger can carry it out, and the service's own page for one
   * it can't.
   */
  /** What the app can manage on this issue's tracker (assignees, labels, title and body). */
  manageable: protectedProcedure.input(z.object({ ...onConnection, key: issueKeyInput })).query(async ({ ctx, input }) => {
    const { b } = await boundFor(ctx.user, input.key, input.connectionId);
    return b.capabilities.manage;
  }),

  /** Who can be assigned to the issue (in its container). */
  assignable: protectedProcedure.input(z.object({ ...onConnection, key: issueKeyInput })).query(async ({ ctx, input }) => {
    const { b, ref, container } = await managed(ctx.user, input.key, input.connectionId, "assignable");
    const people = await providerCall(() => b.manage!.assignable!(callMeta(), container));
    return people.map((p) => ({ remoteId: p.remoteId, name: p.name, handle: p.handle ?? null, avatarUrl: p.avatarUrl ?? null, isMe: p.remoteId === ref.me }));
  }),

  /** The issue's assignees become exactly these (by their id on the tracker). */
  assign: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, people: z.array(z.object({ remoteId: z.string().min(1), name: z.string(), handle: z.string().nullable() })).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const m = await managed(ctx.user, input.key, input.connectionId, "assign");
      const after = await providerCall(() => m.b.manage!.assign!(callMeta(), m.ref, input.people.map((p) => ({ remoteId: p.remoteId, name: p.name, ...(p.handle ? { handle: p.handle } : {}) }))));
      return refreshManaged(ctx.user.id, m, after);
    }),

  /** The labels the issue's container offers. */
  labelOptions: protectedProcedure.input(z.object({ ...onConnection, key: issueKeyInput })).query(async ({ ctx, input }) => {
    const { b, container } = await managed(ctx.user, input.key, input.connectionId, "labelOptions");
    return providerCall(() => b.manage!.labelOptions!(callMeta(), container));
  }),

  /** The issue's labels become exactly these. */
  setLabels: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, labels: z.array(z.string().trim().min(1).max(100)).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const m = await managed(ctx.user, input.key, input.connectionId, "setLabels");
      return refreshManaged(ctx.user.id, m, await providerCall(() => m.b.manage!.setLabels!(callMeta(), m.ref, input.labels)));
    }),

  /** A new title and/or body (Markdown). */
  edit: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput, title: z.string().trim().min(1).max(500).optional(), body: z.string().max(65_000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const m = await managed(ctx.user, input.key, input.connectionId, "edit");
      const patch = { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: markdown(input.body) } : {}) };
      return refreshManaged(ctx.user.id, m, await providerCall(() => m.b.manage!.edit!(callMeta(), m.ref, patch)));
    }),

  /**
   * Where a new issue can go: every connection that can create, with its
   * projects or repositories (the ones I have issues in first) and whether
   * the tracker asks for an issue type.
   */
  createTargets: protectedProcedure.query(async ({ ctx }) => {
    const conns = await getDb()
      .select()
      .from(connections)
      .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
      .orderBy(asc(connections.id));
    const able = conns.flatMap((c) => {
      const b = boundTracker(c);
      return b?.manage?.create ? [{ c, b }] : [];
    });
    return Promise.all(
      able.map(async ({ c, b }) => {
        const mine = new Set(
          (
            await getDb()
              .selectDistinct({ key: issues.projectKey })
              .from(issues)
              .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, c.id)))
          ).map((r) => r.key),
        );
        const listed = await containersOf(c, b);
        const all = new Map(listed.map((k) => [k.key, k.name]));
        for (const k of mine) if (k && !all.has(k)) all.set(k, k);
        return {
          connectionId: c.id,
          name: providerName(c.type),
          label: c.label || c.displayName || providerName(c.type),
          types: b.capabilities.manage.types,
          containers: [...all]
            .map(([key, name]) => ({ key, name, mine: mine.has(key) }))
            .sort((a, z2) => Number(z2.mine) - Number(a.mine) || a.key.localeCompare(z2.key)),
        };
      }),
    );
  }),

  /** The issue types a new issue can have in a container, where its tracker asks for one. */
  createTypes: protectedProcedure
    .input(z.object({ connectionId: z.number().int().positive(), container: z.string().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const conn = await ownConnection(ctx.user.id, input.connectionId);
      const b = boundTracker(conn);
      if (!b?.manage?.createTypes) return [];
      return providerCall(() => b.manage!.createTypes!(callMeta(), { remoteId: input.container, key: input.container }));
    }),

  /** A new issue in a container of a connection (a Jira project, a GitHub repository), then into the catalogue. */
  createIn: protectedProcedure
    .input(
      z.object({
        connectionId: z.number().int().positive(),
        container: z.string().min(1).max(200),
        title: z.string().trim().min(1, { error: () => t("server.issues.summaryRequired") }).max(500),
        body: z.string().max(65_000).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
        assignToMe: z.boolean().optional(),
        /** One of createTypes, where the tracker asks for a type */
        type: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const conn = await ownConnection(ctx.user.id, input.connectionId);
      const b = boundTracker(conn);
      if (!b?.manage?.create) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.issues.cannotManage", { provider: providerName(conn.type) }) });
      // Me as the tracker knows me (with the handle it assigns by).
      const me = input.assignToMe ? await providerCall(() => b.verify(callMeta())) : null;
      const created = await providerCall(() =>
        b.manage!.create!(callMeta(), { remoteId: input.container, key: input.container }, {
          title: input.title,
          ...(input.body ? { body: markdown(input.body) } : {}),
          ...(input.labels ? { labels: input.labels } : {}),
          ...(input.type ? { type: input.type } : {}),
          assignees: me ? [me] : [],
        }),
      );
      await upsertRemote({ userId: ctx.user.id, connectionId: conn.id }, created);
      await markSeen(ctx.user.id, created.key, conn.id);
      return { key: created.key, connectionId: conn.id, remoteId: created.remoteId };
    }),

  transitions: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      const { b, ref } = await trackerFor(ctx.user, input.key, input.connectionId);
      const list = await providerCall(() => b.transitions!.list!(callMeta(), ref));
      return list.map((tr) => ({
        id: tr.id,
        name: tr.name,
        toStatus: tr.to.name,
        toCategory: tr.to.category,
        requirements: tr.requirements,
        executable: executable(tr),
        remoteUrl: tr.remoteUrl,
      }));
    }),

  /** Move an issue to a new status via a Jira transition, then refresh locally. */
  /**
   * Move an issue on, then refresh it locally: by a transition and the
   * values of the fields it asks for, or (a drag on the board) by the status
   * to reach, which works when that way asks for nothing. Fields missing or
   * wrong come back by field id.
   */
  transition: protectedProcedure
    .input(
      z.object({
        ...onConnection,
        key: issueKeyInput,
        toStatus: z.string().optional(),
        transitionId: z.string().min(1).max(64).optional(),
        fields: z.record(z.string(), fieldValueInput).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { conn, b, ref } = await trackerFor(ctx.user, input.key, input.connectionId);
      // Always the latest list: a transition id from an older one may be gone.
      const transitions = await providerCall(() => b.transitions!.list!(callMeta(), ref));
      const wanted = input.toStatus?.toLowerCase();
      const target = transitions.find((tr) =>
        input.transitionId ? tr.id === input.transitionId : tr.to.name.toLowerCase() === wanted || tr.name.toLowerCase() === wanted,
      );
      if (!target) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: t("server.issues.noTransition", { status: input.toStatus ?? input.transitionId ?? "", key: input.key }),
        });
      }
      // Dates as the contract's calendar days (a bad one is the form's fault).
      const fields: Record<string, FieldValue> = Object.fromEntries(
        Object.entries(input.fields ?? {}).map(([id, v]) => [id, typeof v === "object" && !Array.isArray(v) && "date" in v ? { date: localDate(v.date) } : v]),
      );
      const after = await providerCall(async () => {
        assertTransitionFields(target, fields);
        return b.transitions!.apply!(callMeta(), ref, target.id, fields);
      });
      if (conn.type === "jira") {
        // Jira keeps its own refresh (with the fields the generic path doesn't carry yet).
        const { user, creds } = contextFor(ctx.user, conn);
        const refreshed = await fetchIssueByKey(creds, input.key);
        if (refreshed) await upsertIssue(user.id, user.siteUrl, user.connectionId, refreshed);
        await markSeen(ctx.user.id, input.key, conn.id);
        return { moved: input.key, to: refreshed?.fields.status?.name ?? target.to.name };
      }
      const now = after ?? (await providerCall(() => b.getIssue(callMeta(), ref)));
      if (now) await upsertRemote({ userId: ctx.user.id, connectionId: conn.id }, now);
      await markSeen(ctx.user.id, input.key, conn.id);
      return { moved: input.key, to: now?.status.name ?? target.to.name };
    }),

  /** Every local issue in compact form (board, palette, pickers). */
  /** How many issues issues.all would list, and how many it gives at most: a catalogue past the limit is said, not cut silently. */
  allSize: protectedProcedure
    .input(z.object({ scope: z.enum(["bucket", "all"]).default("all") }).optional())
    .query(async ({ ctx, input }) => {
      const inBucket = input?.scope === "bucket" ? await issuesInBucket(ctx.user.id, ctx.deviceId) : undefined;
      const [row] = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.userId, ctx.user.id), onLiveConnection, inBucket));
      return { total: row?.n ?? 0, limit: LIST_MAX_ROWS };
    }),

  all: protectedProcedure
    // "bucket": only this device's bucket (Board, palette); "all" for what counts time (pickers, timesheet).
    .input(z.object({ scope: z.enum(["bucket", "all"]).default("all") }).optional())
    .query(async ({ ctx, input }) => {
      const inBucket = input?.scope === "bucket" ? await issuesInBucket(ctx.user.id, ctx.deviceId) : undefined;
      return compactIssues(ctx.user.id, inBucket);
    }),

  /** The favorites alone, as issues.all gives them: the sidebar (on every page) needs no more. */
  favorites: protectedProcedure.query(({ ctx }) => compactIssues(ctx.user.id, eq(issues.favorite, 1))),

  /** Open issues of mine with news since my last visit, counted here: the sidebar's counter (every page) needs one number. */
  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const me = await myRemoteIds(ctx.user.id);
    if (me.length === 0) return 0;
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(eq(issues.userId, ctx.user.id), onLiveConnection, eq(issues.hidden, 0), inArray(issues.assigneeId, me), notInArray(issues.category, CLOSED), UNREAD_SQL),
      );
    return row?.n ?? 0;
  }),

  list: protectedProcedure
    .input(
      z
        .object({
          status: z.string().optional(),
          projectKey: z.string().optional(),
          label: z.string().optional(),
          search: z.string().optional(),
          favoriteOnly: z.boolean().optional(),
          /** Only the issues I watch on Jira, whoever they are assigned to */
          watchingOnly: z.boolean().optional(),
          /** Only issues with activity since the last visit */
          unreadOnly: z.boolean().optional(),
          /** Default view: open issues assigned to me, hidden ones out. */
          includeDone: z.boolean().default(false),
          includeUnassigned: z.boolean().default(false),
          hidden: z.enum(["exclude", "only"]).default("exclude"),
          /** Favorites are shown in their own pinned group. */
          excludeFavorites: z.boolean().default(false),
          /** Sort applied after favorites (which always come first) */
          sort: z
            .enum(["activity", "updated", "priority", "key", "due"])
            .default("activity"),
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(200).default(25),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const page = input?.page ?? 1;
      const pageSize = input?.pageSize ?? 25;
      const db = getDb();
      // The user's issues on live connections (an archived one's leave the
      // lists), in this device's bucket if it has one on.
      const mine = and(eq(issues.userId, ctx.user.id), onLiveConnection, await issuesInBucket(ctx.user.id, ctx.deviceId))!;
      const notDone = notInArray(issues.category, CLOSED);
      const myIds = await myRemoteIds(ctx.user.id);
      const assignedToMe = inArray(issues.assigneeId, myIds);
      // The search box speaks the query language (contracts/query.ts).
      const parsed = parseQuery(input?.search?.trim() ?? "");
      const compiled = compileIssueQuery(parsed.expr, { myRemoteIds: myIds, now: new Date() });
      // A query that says which states or whose issues it wants decides that itself.
      const queryStates = mentions(parsed.expr, ["cat", "status"]) || mentions(parsed.expr, ["is"], ["open", "closed"]);
      const queryPeople = mentions(parsed.expr, ["me", "assignee", "author"]) || mentions(parsed.expr, ["is"], ["watched"]);
      const filters: SQL[] = [];
      if (input?.excludeFavorites) filters.push(eq(issues.favorite, 0));
      if (input?.status) filters.push(eq(issues.status, input.status));
      if (input?.projectKey) filters.push(eq(issues.projectKey, input.projectKey));
      if (input?.label) {
        // labels is a JSON array: match the quoted element, not a substring
        filters.push(
          sql`${issues.labels} ILIKE ${"%" + escapeLike(JSON.stringify(input.label)) + "%"} ESCAPE '\\'`,
        );
      }
      if (input?.favoriteOnly) filters.push(eq(issues.favorite, 1));
      if (input?.watchingOnly) filters.push(eq(issues.watching, 1));
      if (input?.unreadOnly) filters.push(sql`${UNREAD} = 1`);
      if (compiled.where) filters.push(compiled.where);
      // Words searched (§4.7): titles holding every word before matches by key only, then the chosen order.
      // (A key typed is a ref: it finds that issue alone.)
      const words = queryText(parsed.expr).split(/\s+/).filter(Boolean);
      const relevance: SQL[] = words.length
        ? [asc(sql`CASE WHEN ${and(...words.map((w) => sql`${issues.summary} ILIKE ${`%${escapeLike(w)}%`} ESCAPE '\\'`))} THEN 0 ELSE 1 END`)]
        : [];
      /** Conditions of a view; the toggle counts reuse them with one toggle flipped. */
      const viewWhere = (v: { hidden: boolean; includeDone: boolean; includeUnassigned: boolean }) => {
        const conds: SQL[] = [mine, eq(issues.hidden, v.hidden ? 1 : 0)];
        // The hidden view lists everything that was hidden; an explicit status wins over "done".
        if (!v.hidden && !v.includeDone && !input?.status && !queryStates) conds.push(notDone);
        // Watched issues are followed whoever works on them.
        if (!v.hidden && !v.includeUnassigned && !input?.watchingOnly && !queryPeople) conds.push(assignedToMe);
        return and(...conds, ...filters);
      };
      const view = {
        hidden: input?.hidden === "only",
        includeDone: input?.includeDone ?? false,
        includeUnassigned: input?.includeUnassigned ?? false,
      };
      const where = viewWhere(view);
      const [rows, countRows] = await Promise.all([
        db
          .select({ ...listColumns, mySpentSeconds: MY_SPENT })
          .from(issues)
          .where(where)
          // what the words match best, favorites (in their manual order), then the requested order
          .orderBy(
            ...relevance,
            desc(issues.favorite),
            asc(issues.favoriteRank),
            ...orderFor(input?.sort ?? "activity"),
          )
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db
          .select({ total: sql<number>`count(*)` })
          .from(issues)
          .where(where),
      ]);
      const total = countRows[0]?.total ?? 0;

      // What each toggle would add to the current view (labels of the toggles).
      const doneWhere = and(
        viewWhere({ ...view, hidden: false, includeDone: true }),
        inArray(issues.category, CLOSED),
      );
      const unassignedWhere = and(
        viewWhere({ ...view, hidden: false, includeUnassigned: true }),
        notInArray(issues.assigneeId, myIds),
      );
      const hiddenWhere = viewWhere({ ...view, hidden: true });
      const watchingWhere = and(
        viewWhere({ ...view, hidden: false, includeUnassigned: true }),
        eq(issues.watching, 1),
      );
      const countIf = (cond: SQL | undefined) =>
        sql<number>`coalesce(sum(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0)`;
      const [counts] = await db
        .select({
          done: countIf(doneWhere),
          unassigned: countIf(unassignedWhere),
          hidden: countIf(hiddenWhere),
          watching: countIf(watchingWhere),
        })
        .from(issues)
        .where(mine);

      const facets = await db
        .select({
          status: issues.status,
          projectKey: issues.projectKey,
          projectName: issues.projectName,
          labels: issues.labels,
          count: sql<number>`count(*)`,
        })
        .from(issues)
        .where(mine)
        .groupBy(issues.status, issues.projectKey, issues.projectName, issues.labels);

      const statuses = [...new Set(facets.map((f) => f.status))].sort();
      const projectsMap = new Map<string, string>();
      const labelsSet = new Set<string>();
      for (const f of facets) {
        projectsMap.set(f.projectKey, f.projectName);
        try {
          for (const l of JSON.parse(f.labels) as string[]) labelsSet.add(l);
        } catch {
          /* ignore malformed label payloads */
        }
      }
      const projects = [...projectsMap.entries()]
        .map(([key, name]) => ({ key, name }))
        .sort((a, b) => a.key.localeCompare(b.key));

      return {
        issues: rows.map((r) => ({
          ...r,
          labels: safeParseStrings(r.labels),
          isMine: r.assigneeId !== null && myIds.includes(r.assigneeId),
          unread: r.othersActivityAt !== null && r.othersActivityAt > (r.seenAt ?? 0),
        })),
        /** What the search couldn't apply here (written in English), and what it couldn't read. */
        query: { unsupported: compiled.unsupported, warnings: parsed.warnings },
        statuses,
        projects,
        labels: [...labelsSet].sort(),
        counts,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    }),

  /** Opening the detail marks the issue's activity as read. */
  markSeen: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.key, input.connectionId);
      await markSeen(ctx.user.id, input.key, conn.id);
      return { ok: true };
    }),

  /**
   * Where an issue lives, either way it is named: by its identity on a
   * connection (the app's links), or by a key, old keys included (links
   * from before, typed keys). Null when the catalogue doesn't have it.
   */
  locate: protectedProcedure
    .input(z.union([z.object({ ...onConnection, key: issueKeyInput }), z.object({ connectionId: z.number().int().positive(), remoteId: z.string().min(1).max(200) })]))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const pick = { connectionId: issues.connectionId, remoteId: issues.remoteId, key: issues.key };
      if ("remoteId" in input) {
        const [row] = await db
          .select(pick)
          .from(issues)
          .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, input.connectionId), eq(issues.remoteId, input.remoteId)))
          .limit(1);
        return row ?? null;
      }
      const onConn = input.connectionId !== undefined ? [eq(issues.connectionId, input.connectionId)] : [];
      const byKey = await db
        .select({ ...pick, summary: issues.summary })
        .from(issues)
        .where(and(eq(issues.userId, ctx.user.id), eq(issues.key, input.key), ...onConn))
        .limit(5);
      // The same key on two connections: the app asks which, never guesses.
      if (byKey.length > 1) return { ambiguous: true as const, candidates: byKey };
      if (byKey[0]) return { connectionId: byKey[0].connectionId, remoteId: byKey[0].remoteId, key: byKey[0].key };
      const [byAlias] = await db
        .select(pick)
        .from(itemAliases)
        .innerJoin(issues, eq(issues.id, itemAliases.itemId))
        .where(and(eq(issues.userId, ctx.user.id), eq(itemAliases.key, input.key), ...onConn))
        .orderBy(desc(itemAliases.createdAt))
        .limit(1);
      return byAlias ?? null;
    }),

  get: protectedProcedure
    .input(z.object({ ...onConnection, key: issueKeyInput }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const read = () =>
        db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.userId, ctx.user.id),
              eq(issues.key, input.key),
              ...(input.connectionId !== undefined ? [eq(issues.connectionId, input.connectionId)] : []),
            ),
          )
          .limit(2);
      let rows = await read();
      if (rows.length > 1) throw new TRPCError({ code: "CONFLICT", message: t("server.connections.ambiguousKey", { key: input.key }) });
      if (!rows[0]) {
        // Not in the catalog (e.g. opened from the search): shown live from
        // its tracker, read-only, without importing it.
        const other = await otherTracker(ctx.user, input.key, input.connectionId);
        if (other) {
          const hit = await providerCall(() => other.b.findIssue(callMeta(), { key: input.key }));
          if (hit.kind !== "found") throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFoundOnJira") });
          const row: Issue = {
            id: 0,
            userId: ctx.user.id,
            connectionId: other.conn.id,
            remoteId: hit.issue.remoteId,
            containerId: null,
            favorite: 0,
            favoriteRank: 0,
            hidden: 0,
            watching: 0,
            remoteUpdated: null,
            lastCommentAt: null,
            activityAt: null,
            othersActivityAt: null,
            seenAt: null,
            raw: null,
            ...fieldsOf(hit.issue),
          };
          return { ...row, labels: safeParseStrings(row.labels), components: safeParseStrings(row.components), remote: true as boolean };
        }
        const { user, creds } = await jiraContextFor(ctx.user, input.key, input.connectionId);
        const remote = await fetchIssueByKey(creds, input.key);
        if (!remote) {
          throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFoundOnJira") });
        }
        const row: Issue = {
          id: 0,
          containerId: null,
          goneAt: null,
          goneReason: null,
          favorite: 0,
          favoriteRank: 0,
          hidden: 0,
          watching: 0,
          lastCommentAt: null,
          activityAt: null,
          othersActivityAt: null,
          seenAt: null,
          raw: null,
          ...toRow(user.id, user.siteUrl, user.connectionId, remote),
        };
        return { ...row, labels: safeParseStrings(row.labels), components: safeParseStrings(row.components), remote: true as boolean };
      }
      // Rows synced before the people columns existed: fill them once (GET only).
      if (rows[0].reporterName === null) {
        try {
          const { user, creds } = await jiraContextFor(ctx.user, input.key, input.connectionId);
          const remote = await fetchIssueByKey(creds, input.key);
          if (remote) {
            await upsertIssue(user.id, user.siteUrl, user.connectionId, remote);
            rows = await read();
          }
        } catch (e) {
          // Jira unreachable: show what we have, the next sync fills them.
          console.warn(`[issues.get] people of ${input.key} not refreshed: ${String(e)}`);
        }
      }
      return { ...rows[0], labels: safeParseStrings(rows[0].labels), components: safeParseStrings(rows[0].components), remote: false as boolean };
    }),
});

function safeParseStrings(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
