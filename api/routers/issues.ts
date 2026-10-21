import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { pendingReplays } from "./outbox";
import type { ReplayResult } from "../sync/outboxLocks";
import { activity, clientContainers, clients, connections, containers, issues, itemAliases, type Connection, syncState, timers, worklogs, type User, type Issue } from "@db/schema";
import { boundTracker, syncConnectionEntries, syncConnectionIssues, syncInbox, withStream } from "../sync/engine";
import { toRichDoc } from "../providers/core/richtext";
import { replayContract } from "../sync/timeWrites";
import { streamState } from "../sync/state";
import { fieldsOf, upsertRemote } from "../sync/issues";
import { compileIssueQuery, mentions } from "../queries/issueQuery";
import { formatQuery, parseQuery, queryText } from "@contracts/query";
import { providerName } from "@contracts/providerNames";
import { onLiveConnection } from "../queries/liveConnections";
import { issuesInBucket } from "../queries/buckets";
import { knownRanks, priorityRanks } from "../jira/priorities";
import { categoryOfGroup, isClosed } from "@contracts/categories";

/** Finished one way or the other. */
const CLOSED = ["done", "cancelled"];
import { providerCall } from "../providers/trpc";
import { assertTransitionFields, executable } from "../providers/core/fields";
import { localDate, markdown } from "@contracts/values";
import { randomUUID } from "node:crypto";
import type { FieldValue, RemoteBody, RemoteIssue } from "../providers/types";
import type { JiraCredentials } from "@contracts/types";
import { env } from "../lib/env";
import { issueKeyInput, LIST_MAX_ROWS } from "../lib/inputs";
import { buildTimeline } from "../lib/history";
import { isShuttingDown } from "../lib/shutdown";
import {
  fetchAssignedIssues,
  fetchRecentlyAssignedIssues,
  fetchWatchedIssues,
  fetchIssueByKey,
  setWatching,
  fetchIssueHistory,
  searchIssues,
  ISSUE_KEY_RE,
  canonicalCategory,
  fetchAttachments,
  fetchRemoteLinks,
  parseJiraDate,
  fetchOpenIssueActivity,
  JiraApiError,
  type JiraSearchedIssue,
} from "../jira/client";
import { syncWorklogs } from "../worklogSync";
import { detectNotifications, insertNotifications, snapshotIssues } from "./notifications";
import { t } from "@contracts/i18n";
import { contextFor, issueConnection, ownConnection, jiraContextFor, myRemoteIds, type JiraUser } from "../providers/connections";

/**
 * Status-change time: Jira's statuscategorychangedate ignores moves within a
 * category (and is missing on older Servers), so a status that differs from
 * the last sync also counts, as "now". The later of the two wins.
 */
function withStatusChange<R extends { key: string; status: string; statusChangedAt: number | null }>(
  row: R,
  previous: Map<string, string>,
  now: number,
): R {
  const before = previous.get(row.key);
  const detected = before !== undefined && before !== row.status ? now : null;
  const jira = row.statusChangedAt;
  return {
    ...row,
    statusChangedAt: jira === null ? detected : detected === null ? jira : Math.max(jira, detected),
  };
}

/** Upsert values on conflict: local flags kept, status-change time never goes backwards. */
function conflictSet<R extends object>(row: R) {
  return {
    ...row,
    favorite: undefined,
    hidden: undefined,
    statusChangedAt: sql`NULLIF(greatest(coalesce(excluded.status_changed_at, 0), coalesce(${issues.statusChangedAt}, 0)), 0)`,
    // Ranks not read this time (Jira's priorities unreachable): the known one stays.
    priorityRank: sql`coalesce(excluded.priority_rank, ${issues.priorityRank})`,
  };
}

/** Rewrite a synced row only when Jira changed it (or it predates jira_updated_at). */
const ROW_CHANGED = sql`${issues.remoteUpdated} IS DISTINCT FROM excluded.jira_updated
  OR ${issues.status} IS DISTINCT FROM excluded.status
  OR ${issues.assigneeId} IS DISTINCT FROM excluded.assignee_id
  OR ${issues.url} IS DISTINCT FROM excluded.url
  OR ${issues.projectAvatarUrl} IS DISTINCT FROM excluded.project_avatar_url
  OR ${issues.remoteUpdatedAt} IS NULL
  OR ${issues.reporterName} IS NULL
  OR ${issues.category} IS DISTINCT FROM excluded.category
  OR (excluded.priority_rank IS NOT NULL AND ${issues.priorityRank} IS DISTINCT FROM excluded.priority_rank)`;

const ACTIVITY_EXPR = `NULLIF(greatest(
      coalesce(last_comment_at, 0),
      coalesce(status_changed_at, 0),
      coalesce(jira_created_at, 0)
    ), 0)`;

/** Nothing unread: used once per connection, when its catalog is first filled. */
async function markAllSeen(userId: number, connectionId: number) {
  await getDb().execute(
    sql`UPDATE issues SET seen_at = NULLIF(greatest(coalesce(activity_at, 0), coalesce(others_activity_at, 0)), 0)
      WHERE user_id = ${userId} AND connection_id = ${connectionId}`,
  );
}

/** The user looked at (or acted on) an issue: its activity so far is read. */
async function markSeen(userId: number, key: string, connectionId: number) {
  await getDb()
    .update(issues)
    .set({ seenAt: Date.now() })
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.key, key)));
}

/** Others' activity newer than the last visit (my own actions are never news). */
const UNREAD = sql<number>`(CASE WHEN ${issues.othersActivityAt} IS NOT NULL AND ${issues.othersActivityAt} > coalesce(${issues.seenAt}, 0) THEN 1 ELSE 0 END)`;

/** Raise others_activity_at to `at` (it never goes backwards). */
const othersActivityUpTo = (at: number) =>
  sql`greatest(coalesce(${issues.othersActivityAt}, 0), ${at})`;

/** activity_at = latest of comment, status change, creation (only rows that differ). */
async function refreshActivity(userId: number) {
  await getDb().execute(
    sql`UPDATE issues SET activity_at = ${sql.raw(ACTIVITY_EXPR)}
      WHERE user_id = ${userId} AND activity_at IS DISTINCT FROM ${sql.raw(ACTIVITY_EXPR)}`,
  );
}

function toRow(userId: number, siteUrl: string, connectionId: number, i: JiraSearchedIssue) {
  return {
    userId,
    connectionId,
    remoteId: i.id,
    key: i.key,
    summary: i.fields.summary,
    status: i.fields.status?.name ?? "Unknown",
    statusCategory: canonicalCategory(i.fields.status?.statusCategory),
    category: categoryOfGroup(canonicalCategory(i.fields.status?.statusCategory)),
    projectKey: i.fields.project?.key ?? "",
    projectName: i.fields.project?.name ?? "",
    issueType: i.fields.issuetype?.name ?? "",
    priority: i.fields.priority?.name ?? "",
    priorityRank: i.fields.priority?.name ? (knownRanks(siteUrl)?.get(i.fields.priority.name) ?? null) : null,
    labels: JSON.stringify(i.fields.labels ?? []),
    assigneeId: i.fields.assignee?.accountId ?? i.fields.assignee?.name ?? "",
    assigneeName: i.fields.assignee?.displayName ?? "",
    reporterName: i.fields.reporter?.displayName ?? "",
    timeEstimateSeconds: i.fields.timeestimate ?? null,
    timeSpentSeconds: i.fields.timespent ?? null,
    dueDate: i.fields.duedate ?? null,
    remoteUpdated: i.fields.updated ?? null,
    remoteUpdatedAt: parseJiraDate(i.fields.updated),
    remoteCreatedAt: parseJiraDate(i.fields.created),
    statusChangedAt: parseJiraDate(i.fields.statuscategorychangedate),
    projectAvatarUrl:
      i.fields.project?.avatarUrls?.["48x48"] ??
      i.fields.project?.avatarUrls?.["32x32"] ??
      null,
    url: `${siteUrl}/browse/${i.key}`,
    syncedAt: new Date(),
  };
}

/**
 * The issue moved (same Jira id, new key: APP-1 became NEW-1): its row takes
 * the new key before the upsert, instead of a second row beside the old one.
 * The database keeps the old key as an alias and moves what hangs on it.
 */
async function followMove(db: Pick<Tx, "update">, userId: number, connectionId: number, remoteId: string, key: string) {
  await db
    .update(issues)
    .set({ key })
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.remoteId, remoteId), ne(issues.key, key)));
}

export async function upsertIssue(userId: number, siteUrl: string, connectionId: number, i: JiraSearchedIssue) {
  const db = getDb();
  const stored = (await db
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.key, i.key))).limit(1))[0];
  const previous = new Map<string, string>(stored ? [[i.key, stored.status]] : []);
  const row = withStatusChange(toRow(userId, siteUrl, connectionId, i), previous, Date.now());
  await followMove(db, userId, connectionId, row.remoteId, row.key);
  await db
    .insert(issues)
    .values(row)
    .onConflictDoUpdate({ target: [issues.userId, issues.connectionId, issues.remoteId], set: conflictSet(row) });
  await refreshActivity(userId);
}

/**
 * Issues by key, in batches. Keys missing from a batch result are looked up
 * one by one before being reported `gone`: a search can drop a key for other
 * reasons than deletion (index lag, transient permission glitches).
 */
async function fetchIssuesByKeys(
  creds: JiraCredentials,
  keys: string[],
): Promise<{ found: JiraSearchedIssue[]; gone: string[] }> {
  const found: JiraSearchedIssue[] = [];
  const gone: string[] = [];
  const oneByOne = async (batch: string[]) => {
    for (const key of batch) {
      const one = await fetchIssueByKey(creds, key);
      if (one) found.push(one);
      else gone.push(key);
    }
  };
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    let page: JiraSearchedIssue[];
    try {
      page = await searchIssues(creds, `key in (${batch.join(",")})`, batch.length);
    } catch (e) {
      // One deleted / invisible key fails the whole JQL with 400: go one by one.
      if (!(e instanceof JiraApiError && e.status === 400)) throw e;
      await oneByOne(batch);
      continue;
    }
    found.push(...page);
    const returned = new Set(page.map((p) => p.key));
    await oneByOne(batch.filter((k) => !returned.has(k)));
  }
  return { found, gone };
}

/**
 * Local issues still marked as mine that the assigned search no longer
 * returns were reassigned or deleted: refresh them, and clear the assignee of
 * those Jira does not return at all. Best effort.
 */
async function refreshNoLongerAssigned(
  user: JiraUser,
  creds: JiraCredentials,
  remoteKeys: Set<string>,
  previous: Map<string, string>,
  now: number,
) {
  try {
    const stale = (
      await getDb()
        .select({ key: issues.key })
        .from(issues)
        .where(and(eq(issues.userId, user.id), eq(issues.connectionId, user.connectionId), eq(issues.assigneeId, user.accountId)))
    )
      .map((r) => r.key)
      .filter((k) => !remoteKeys.has(k) && ISSUE_KEY_RE.test(k));
    if (stale.length === 0) return;
    const { found, gone } = await fetchIssuesByKeys(creds, stale);
    await getDb().transaction(async (tx) => {
      for (const i of found) {
        const row = withStatusChange(toRow(user.id, user.siteUrl, user.connectionId, i), previous, now);
        await followMove(tx, user.id, user.connectionId, row.remoteId, row.key);
        await tx.insert(issues)
          .values(row)
          .onConflictDoUpdate({ target: [issues.userId, issues.connectionId, issues.remoteId], set: conflictSet(row) });
      }
      if (gone.length > 0) {
        await tx.update(issues)
          .set({ assigneeId: "" })
          .where(and(eq(issues.userId, user.id), eq(issues.connectionId, user.connectionId), inArray(issues.key, gone)));
      }
    });
  } catch (e) {
    console.warn(`[sync] reassigned issues skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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

function isKeyQuery(query: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(query.trim());
}

/** JQL for free-text global search: exact key, or full-text match. */
export function buildSearchJql(query: string): string {
  const q = query.trim();
  if (isKeyQuery(q)) {
    return `key = ${q.toUpperCase()}`;
  }
  // Lucene/JQL operators in free text break the query: blank them out.
  const escaped = q.replace(/[+\-&|!(){}[\]^~*?:\\"]/g, " ");
  return `text ~ "${escaped}" ORDER BY updated DESC`;
}

type SyncResult = {
  synced: number;
  at: Date;
  /** Full catalog refresh (with watchers) rather than the recent-changes window */
  full: boolean;
  outbox: ReplayResult;
};

type InFlightSync = { run: Promise<SyncResult>; full: boolean };

/** Shared with the dev server's re-evaluated modules: one run per user per process. */
const g = globalThis as { __iklSyncRuns?: Map<number, InFlightSync> };
const syncInFlight = (g.__iklSyncRuns ??= new Map<number, InFlightSync>());

/** Wait (at most `timeoutMs`) for running syncs and outbox replays; used on shutdown. */
export async function settleInFlightSyncs(timeoutMs: number): Promise<void> {
  const pending = [...[...syncInFlight.values()].map((s) => s.run), ...pendingReplays()];
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

async function recordSync(userId: number, outcome: { ok: true; full: boolean } | { error: string }) {
  const now = new Date();
  const set =
    "ok" in outcome
      ? { lastSyncAt: now, ...(outcome.full ? { lastFullSyncAt: now } : {}) }
      : { lastError: outcome.error.slice(0, 500), lastErrorAt: now };
  await getDb()
    .insert(syncState)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: syncState.userId, set });
}

/** Minutes looked back by an incremental sync: the interval plus some slack. */
export function incrementalWindowMin(): number {
  return Math.max(7, env.syncIntervalMin + 2);
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

type UpsertContext = {
  user: JiraUser;
  previous: Map<string, string>;
  /** Assignee before this sync, by key (catalog issues only). */
  previousAssignee: Map<string, string>;
  firstSync: boolean;
  lastSyncAt: Date | null;
  now: number;
};

/** Upsert one synced issue: local flags kept, status changes noticed. */
async function upsertSynced(tx: Tx, c: UpsertContext, i: JiraSearchedIssue) {
  const { user, previous, previousAssignee, firstSync, lastSyncAt, now } = c;
  const row = withStatusChange(toRow(user.id, user.siteUrl, user.connectionId, i), previous, now);
  const before = previous.get(row.key);
  const mine = row.assigneeId === user.accountId;
  await followMove(tx, user.id, user.connectionId, row.remoteId, row.key);
  await tx.insert(issues)
    // Newly assigned to me (after the first sync): news from someone else.
    .values({ ...row, othersActivityAt: firstSync || !mine ? null : row.remoteCreatedAt ?? now })
    .onConflictDoUpdate({
      target: [issues.userId, issues.connectionId, issues.remoteId],
      set: conflictSet(row),
      setWhere: ROW_CHANGED,
    });
  // Already in the catalog (watched, imported) and now reassigned to me: news from
  // someone else, like a brand-new assignment.
  const prevAssignee = previousAssignee.get(row.key);
  if (!firstSync && mine && prevAssignee !== undefined && prevAssignee !== user.accountId) {
    await tx.update(issues)
      .set({ othersActivityAt: othersActivityUpTo(now) })
      .where(and(eq(issues.userId, user.id), eq(issues.connectionId, user.connectionId), eq(issues.key, row.key)));
  }
  // A status change noticed between syncs has no known author: assume
  // someone else, unless the user opened the issue since the last sync.
  if (before !== undefined && before !== row.status) {
    await tx.update(issues)
      .set({ othersActivityAt: othersActivityUpTo(now) })
      .where(
        and(
          eq(issues.userId, user.id),
          eq(issues.connectionId, user.connectionId),
          eq(issues.key, row.key),
          sql`coalesce(${issues.seenAt}, 0) <= ${lastSyncAt?.getTime() ?? 0}`,
        ),
      );
  }
}

/**
 * Full sync only: upsert the watched issues missing from the catalog sync
 * (they are "not mine") and set the watching flags. Best effort: returns
 * false when Jira could not be asked, flags untouched.
 */
async function syncWatchers(
  c: UpsertContext,
  creds: JiraCredentials,
  alreadySynced: Set<string>,
): Promise<boolean> {
  let watched: JiraSearchedIssue[];
  try {
    watched = await fetchWatchedIssues(creds);
  } catch (e) {
    console.warn(`[sync] watchers skipped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  await getDb().transaction(async (tx) => {
    for (const i of watched) {
      if (!alreadySynced.has(i.key)) await upsertSynced(tx, c, i);
    }
    await tx.update(issues)
      .set({ watching: 0 })
      .where(and(eq(issues.userId, c.user.id), eq(issues.connectionId, c.user.connectionId), eq(issues.watching, 1)));
    for (const i of watched) {
      await tx.update(issues)
        .set({ watching: 1 })
        .where(and(eq(issues.userId, c.user.id), eq(issues.connectionId, c.user.connectionId), eq(issues.key, i.key)));
    }
  });
  return true;
}

/** Jira assignee of a searched issue, in the form stored in assignee_id. */
const assigneeOf = (i: JiraSearchedIssue) =>
  i.fields.assignee?.accountId ?? i.fields.assignee?.name ?? "";

async function runSync(account: User, conn: Connection, wantFull: boolean): Promise<SyncResult> {
  const syncStart = Date.now();
  let full = wantFull;
  try {
    const { user, creds } = contextFor(account, conn);
    // Ranks for this site's priorities (once a day): toRow reads them.
    await priorityRanks(creds);
    // This connection's own past: a second one has its own first sync; the
    // connection from before connections were separate goes on with the
    // user's state (no "first sync" again after the upgrade).
    const stream = conn.legacy ? undefined : await streamState(conn.id, "issues");
    const state = conn.legacy
      ? (await getDb()
          .select({ lastSyncAt: syncState.lastSyncAt, lastFullSyncAt: syncState.lastFullSyncAt })
          .from(syncState)
          .where(eq(syncState.userId, user.id)).limit(1))[0]
      : { lastSyncAt: stream?.lastOkAt ?? null, lastFullSyncAt: stream?.lastFullAt ?? null };
    // The very first successful sync fills the catalog as "already read",
    // and is always full; it raises no notifications.
    const lastSyncAt = state?.lastSyncAt ?? null;
    const firstSync = lastSyncAt === null;
    full = wantFull || firstSync;
    // Covers the time since the last successful sync too: a failed pass or downtime
    // must not leave gaps until the next full sync.
    const windowMin = lastSyncAt
      ? Math.max(incrementalWindowMin(), Math.ceil((syncStart - lastSyncAt.getTime()) / 60_000) + 2)
      : incrementalWindowMin();
    // Which issues are mine on this connection (Settings → Connections → Options).
    const mine = jiraMineOf(conn);
    const fetched = full
      ? await fetchAssignedIssues(creds, mine)
      : await fetchRecentlyAssignedIssues(creds, windowMin, mine);
    const before = await snapshotIssues(user.id, user.connectionId);
    // Incremental: "assignee was me" may return old issues never synced; only
    // mine and the ones already in the catalog (reassigned away) matter.
    const remote = full
      ? fetched
      : fetched.filter((i) => mine === "involved" || before.has(i.key) || assigneeOf(i) === user.accountId);
    // Jira Server may not report when the status changed: notice it here.
    const previous = new Map([...before].map(([k, r]) => [k, r.status]));
    const previousAssignee = new Map([...before].map(([k, r]) => [k, r.assigneeId]));
    const ctx: UpsertContext = {
      user,
      previous,
      previousAssignee,
      firstSync,
      lastSyncAt,
      now: Date.now(),
    };
    await getDb().transaction(async (tx) => {
      for (const i of remote) await upsertSynced(tx, ctx, i);
    });
    let watchersSynced = false;
    if (full) {
      const remoteKeys = new Set(remote.map((i) => i.key));
      await refreshNoLongerAssigned(user, creds, remoteKeys, previous, ctx.now);
      watchersSynced = await syncWatchers(ctx, creds, remoteKeys);
    }
    // Latest comment / status change (anyone) drive the "Activity" order,
    // the ones by others the unread mark; best effort, the between-syncs
    // estimate remains as fallback.
    try {
      const activity = await fetchOpenIssueActivity(
        creds,
        user.accountId,
        full ? undefined : windowMin,
      );
      await getDb().transaction(async (tx) => {
        for (const [key, a] of activity) {
          // A null comment time is news too (comments deleted).
          const others = Math.max(a.othersCommentAt ?? 0, a.othersStatusChangedAt ?? 0);
          const set = {
            lastCommentAt: a.lastCommentAt,
            ...(others > 0 ? { othersActivityAt: othersActivityUpTo(others) } : {}),
            ...(a.statusChangedAt !== null
              ? {
                  statusChangedAt: sql`greatest(coalesce(${issues.statusChangedAt}, 0), ${a.statusChangedAt})`,
                }
              : {}),
          };
          await tx.update(issues)
            .set(set)
            .where(and(eq(issues.userId, user.id), eq(issues.connectionId, user.connectionId), eq(issues.key, key)));
        }
      });
    } catch (e) {
      console.warn(`[sync] activity skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    await refreshActivity(user.id);
    if (firstSync) {
      await markAllSeen(user.id, user.connectionId);
    } else {
      // The first full sync only records the watched set: no watcher news.
      const watch = watchersSynced && (state?.lastFullSyncAt ?? null) !== null;
      await insertNotifications(
        user.id,
        detectNotifications(before, await snapshotIssues(user.id, user.connectionId), user.accountId, user.connectionId, syncStart, { watch }),
        Date.now(),
      );
    }
    // Jira is reachable: flush any queued offline worklog operations.
    const outbox = await replayContract(conn);
    await recordSync(user.id, { ok: true, full });
    return { synced: remote.length, at: new Date(), full, outbox };
  } catch (e) {
    await recordSync(account.id, { error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
    throw e;
  }
}

/**
 * Every active connection of the user, each through the sync engine (its
 * stream lease and wait, its outcome recorded). Jira keeps its own pass
 * (activity, watchers, notifications) until the catalogue maps any tracker's
 * statuses (WP-14); other trackers go through the provider contract. The
 * result is Jira's, as before; another tracker's failure is logged, never
 * fails the rest.
 */
/** A Jira connection's choice of what is mine: assigned (default), or involved (reported too). */
function jiraMineOf(conn: Connection): "assigned" | "involved" {
  try {
    return (JSON.parse(conn.options) as { mine?: string }).mine === "involved" ? "involved" : "assigned";
  } catch {
    return "assigned";
  }
}

/** The user's live trackers, in the order they were added. */
async function liveTrackers(userId: number): Promise<Connection[]> {
  return getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), isNull(connections.archivedAt), eq(connections.status, "ok")))
    .orderBy(asc(connections.id));
}

/** Searches answered in the last minute, by user, connection and query (a tracker isn't asked twice for the same). */
const searchCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof searchUncached>> }>();
const SEARCH_TTL_MS = 60_000;

async function searchConnection(user: User, conn: Connection, query: string) {
  const key = `${user.id}|${conn.id}|${query}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.value;
  const value = await searchUncached(user, conn, query);
  if (!value.failed) searchCache.set(key, { at: Date.now(), value });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!);
  return value;
}

/**
 * One tracker's answer to a search: a key or link is found directly; the
 * rest is said in the tracker's own query language (translate), or as its
 * words only; what it can't say is named in `unsupported`.
 */
async function searchUncached(user: User, conn: Connection, query: string) {
  const label = conn.label || conn.displayName || providerName(conn.type);
  const b = boundTracker(conn);
  const none = { connectionId: conn.id, results: [] as SearchResult[], unsupported: [] as string[], failed: null as { connectionId: number; label: string; message: string } | null };
  if (!b) return none;
  const parsed = parseQuery(query);
  let found: RemoteIssue[] = [];
  let unsupported: string[] = [];
  try {
    const handle = b.parseRef(query.trim());
    const direct = handle ? await b.findIssue(callMeta(), handle) : { kind: "none" as const };
    if (direct.kind === "found") found = [direct.issue];
    else if (direct.kind === "ambiguous") found = direct.candidates;
    else if (handle) found = [];
    else if (b.translate && b.query) {
      const said = b.translate(parsed.expr, new Date());
      unsupported = said.unsupported;
      found = said.query ? (await b.query(callMeta(), said.query, 25)).items : [];
    } else if (b.searchText) {
      // Words only: the operators are named as not applied.
      const words = queryText(parsed.expr);
      unsupported = formatQuery(parsed.expr, "en") !== words ? [formatQuery(parsed.expr, "en")] : [];
      found = words ? (await b.searchText(callMeta(), words, 25)).items : [];
    }
  } catch (e) {
    return { ...none, failed: { connectionId: conn.id, label, message: e instanceof Error ? e.message : String(e) } };
  }
  if (found.length === 0) return { ...none, unsupported };
  const db = getDb();
  const local = await db
    .select({ remoteId: issues.remoteId, watching: issues.watching })
    .from(issues)
    .where(and(eq(issues.userId, user.id), eq(issues.connectionId, conn.id), inArray(issues.remoteId, found.map((i) => i.remoteId))));
  const known = new Map(local.map((l) => [l.remoteId, l]));
  // The client of each project, for the badge.
  const owners = await db
    .select({ key: containers.key, client: clients.name })
    .from(containers)
    .innerJoin(clientContainers, eq(clientContainers.containerId, containers.id))
    .innerJoin(clients, eq(clients.id, clientContainers.clientId))
    .where(and(eq(containers.connectionId, conn.id), inArray(containers.key, [...new Set(found.map((i) => i.container.key))])));
  const clientOf = new Map(owners.map((o) => [o.key, o.client]));
  const results: SearchResult[] = found.map((issue) => {
    const mine = known.get(issue.remoteId);
    return {
      connectionId: conn.id,
      connectionLabel: label,
      key: issue.key,
      remoteId: issue.remoteId,
      summary: issue.title,
      status: issue.status.name,
      category: issue.status.category,
      projectKey: issue.container.key,
      client: clientOf.get(issue.container.key) ?? null,
      assignee: issue.assignees[0]?.name ?? null,
      isMine: conn.remoteAccountId !== "" && issue.assignees.some((p) => p.remoteId === conn.remoteAccountId),
      imported: mine !== undefined,
      watching: mine?.watching === 1,
      canWatch: !!b.watch,
      url: issue.url,
      updatedAt: issue.updatedAt ?? null,
    };
  });
  return { ...none, results, unsupported };
}

type SearchResult = {
  connectionId: number;
  connectionLabel: string;
  key: string;
  remoteId: string;
  summary: string;
  status: string;
  category: string;
  projectKey: string;
  client: string | null;
  assignee: string | null;
  isMine: boolean;
  imported: boolean;
  watching: boolean;
  canWatch: boolean;
  url: string;
  updatedAt: number | null;
};

/** A catalogue row as lists read it: everything but the raw fields (T8: never in lists). */
const listColumns = (() => {
  const { raw, ...rest } = getTableColumns(issues);
  void raw;
  return rest;
})();

/** Trackers synced at once for one user. */
const SYNC_CONCURRENCY = 3;

/** `run` over the items, at most `size` at a time; every outcome, in order. */
async function inPool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<PromiseSettledResult<void>[]> {
  const out = new Array<PromiseSettledResult<void>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await run(items[i]);
        out[i] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function syncConnections(user: User, full: boolean, background: boolean): Promise<SyncResult> {
  const conns = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, user.id), isNull(connections.archivedAt)))
    .orderBy(asc(connections.id));
  let result: SyncResult | undefined;
  const one = async (conn: Connection) => {
    // Waiting to be reconnected: only the user's own sync tries it again.
    if (background && conn.status !== "ok") return;
    if (conn.type === "jira") {
      const run = await withStream(conn, "issues", { full, background }, async () => ({ result: await runSync(user, conn, full) }));
      if (run.ran) result = run.result;
      else if (!background) throw new TRPCError({ code: "CONFLICT", message: t("server.issues.syncBusy") });
    } else {
      try {
        await syncConnectionIssues(conn, { full, background });
        // Its tracker answered: time changes queued meanwhile go now, in order.
        await replayContract(conn);
        // Then the time logged there (its own feed), over what was just sent.
        await syncConnectionEntries(conn, { full, background });
        // Its own inbox (mentions, comments, reviews asked).
        await syncInbox(conn, { background });
      } catch (e) {
        console.warn(`[sync] connection ${conn.id} (${conn.type}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  // A few trackers at a time (each its own service and budget); a failure of one waits for the others.
  const outcomes = await inPool(conns, SYNC_CONCURRENCY, one);
  const failure = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
  if (failure) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
  return result ?? { synced: 0, at: new Date(), full, outbox: { synced: 0, failed: 0, remaining: 0 } };
}

/**
 * Pull the user's issues and flush the offline outbox. Shared by the manual
 * "Sync" (full) and the background scheduler (incremental, full every
 * hour); the first sync is always full. Concurrent calls for the same user
 * share one run; a full one asked during an incremental runs right after it.
 */
export function syncUser(user: User, opts: { full?: boolean; background?: boolean } = {}): Promise<SyncResult> {
  if (isShuttingDown()) {
    return Promise.reject(
      new TRPCError({ code: "SERVICE_UNAVAILABLE", message: t("server.issues.shuttingDown") }),
    );
  }
  const full = opts.full ?? true;
  const running = syncInFlight.get(user.id);
  if (running && (running.full || !full)) return running.run;
  const run: Promise<SyncResult> = (async () => {
    if (running) await running.run.catch(() => undefined);
    const result = await syncConnections(user, full, opts.background ?? false);
    // Then the user's worklogs (time logged in Jira itself too). A failure
    // here doesn't undo the issues: the next pass picks up from the same point.
    try {
      await syncWorklogs(user);
    } catch (e) {
      console.warn(`[sync] worklogs of user ${user.id} not synced: ${String(e)}`);
    }
    return result;
  })().finally(() => {
    if (syncInFlight.get(user.id)?.run === run) syncInFlight.delete(user.id);
  });
  syncInFlight.set(user.id, { run, full });
  return run;
}

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


const callMeta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `ui-${Date.now()}` });

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
      .where(and(eq(issues.userId, ctx.user.id), onLiveConnection, inBucket))
      .orderBy(desc(issues.favorite), asc(issues.favoriteRank), ...BY_UPDATED)
      .limit(LIST_MAX_ROWS);
    // Mine: assigned to me on any of my connections (Jira, GitHub…).
    const myIds = new Set(await myRemoteIds(ctx.user.id));
    return rows.map(({ assigneeId, unread, remoteUpdatedAt, remoteCreatedAt, activityAt, ...r }) => ({
      ...r,
      unread: unread === 1,
      isMine: assigneeId !== null && myIds.has(assigneeId),
      /** Most relevant moment: last change, activity (comment, status) or creation */
      relevantAt: Math.max(remoteUpdatedAt ?? 0, activityAt ?? 0, remoteCreatedAt ?? 0) || null,
    }));
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
          .select(listColumns)
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
          labels: safeParseLabels(r.labels),
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
          return { ...row, labels: safeParseLabels(row.labels), remote: true as boolean };
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
        return { ...row, labels: safeParseLabels(row.labels), remote: true as boolean };
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
      return { ...rows[0], labels: safeParseLabels(rows[0].labels), remote: false as boolean };
    }),
});

function safeParseLabels(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
