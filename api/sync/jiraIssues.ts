import { and, eq, getTableColumns, inArray, ne, sql, type SQL } from "drizzle-orm";
import { getDb } from "../queries/connection";
import type { ReplayResult } from "./outboxLocks";
import { issues, type Connection, syncState, type User } from "@db/schema";
import { replayContract } from "./timeWrites";
import { streamState } from "./state";
import { knownRanks, priorityRanks } from "../jira/priorities";
import { categoryOfGroup } from "@contracts/categories";
import type { JiraCredentials } from "@contracts/types";
import { env } from "../lib/env";
import { rounds } from "../lib/rounds";
import {
  fetchAssignedIssues,
  fetchRecentlyAssignedIssues,
  fetchWatchedIssues,
  fetchIssueByKey,
  searchIssues,
  ISSUE_KEY_RE,
  canonicalCategory,
  componentNames,
  parseJiraDate,
  fetchOpenIssueActivity,
  JiraApiError,
  type JiraSearchedIssue,
} from "../jira/client";
import { detectNotifications, insertNotifications, snapshotIssues } from "../routers/notifications";
import { contextFor, type JiraUser } from "../providers/connections";

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

/**
 * Upsert values on conflict: each of the row's columns as inserted (`excluded`, so one
 * statement serves any number of rows), local flags kept, status-change time never
 * goes backwards.
 */
function conflictSet<R extends object>(row: R) {
  const columns = getTableColumns(issues) as Record<string, { name: string }>;
  const asInserted = Object.fromEntries(
    Object.entries(row)
      .filter(([k, v]) => v !== undefined && k in columns)
      .map(([k]) => [k, sql.raw(`excluded."${columns[k].name}"`)]),
  ) as { [K in keyof R]: SQL };
  return {
    ...asInserted,
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
  OR ${issues.components} IS DISTINCT FROM excluded.components
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

export function toRow(userId: number, siteUrl: string, connectionId: number, i: JiraSearchedIssue) {
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
    components: JSON.stringify(componentNames(i.fields.components)),
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

/** followMove for many rows, in one statement. */
async function followMoves(db: Pick<Tx, "execute">, userId: number, connectionId: number, rows: { remoteId: string; key: string }[]) {
  if (rows.length === 0) return;
  const moved = sql.join(rows.map((r) => sql`(${r.remoteId}, ${r.key})`), sql`, `);
  await db.execute(sql`UPDATE ${issues} SET key = v.key FROM (VALUES ${moved}) AS v(remote_id, key)
    WHERE ${issues.userId} = ${userId} AND ${issues.connectionId} = ${connectionId} AND ${issues.remoteId} = v.remote_id AND ${issues.key} <> v.key`);
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
      // However many: the moves in one statement, the rows in one upsert (an issue Jira
      // returned twice in rounds: one statement may not touch a row twice).
      const all = found.map((i) => withStatusChange(toRow(user.id, user.siteUrl, user.connectionId, i), previous, now));
      for (const rows of rounds(all, (r) => r.remoteId)) {
        await followMoves(tx, user.id, user.connectionId, rows);
        await tx.insert(issues)
          .values(rows)
          .onConflictDoUpdate({ target: [issues.userId, issues.connectionId, issues.remoteId], set: conflictSet(rows[0]) });
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

export type SyncResult = {
  synced: number;
  at: Date;
  /** Full catalog refresh (with watchers) rather than the recent-changes window */
  full: boolean;
  outbox: ReplayResult;
};

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
function incrementalWindowMin(): number {
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

/** Synced issues per statement at most (about 30 parameters each, 65535 per statement). */
const UPSERT_BATCH = 500;

/**
 * Upsert synced issues: local flags kept, status changes noticed. In a few statements
 * however many (the moves, the rows, then the two kinds of news), each decided on what
 * was stored before this sync, as one by one. An issue Jira returned twice goes in
 * rounds (its first copy, then its second, each with its news), as one by one did.
 */
async function upsertSynced(tx: Tx, c: UpsertContext, list: JiraSearchedIssue[]) {
  const { user, previous, previousAssignee, firstSync, lastSyncAt, now } = c;
  const all = list.map((i) => withStatusChange(toRow(user.id, user.siteUrl, user.connectionId, i), previous, now));
  for (const round of rounds(all, (r) => r.remoteId)) {
    for (let i = 0; i < round.length; i += UPSERT_BATCH) {
      const some = round.slice(i, i + UPSERT_BATCH);
      await followMoves(tx, user.id, user.connectionId, some);
      await tx.insert(issues)
        // Newly assigned to me (after the first sync): news from someone else.
        .values(some.map((row) => ({ ...row, othersActivityAt: firstSync || row.assigneeId !== user.accountId ? null : (row.remoteCreatedAt ?? now) })))
        .onConflictDoUpdate({
          target: [issues.userId, issues.connectionId, issues.remoteId],
          set: conflictSet(some[0]),
          setWhere: ROW_CHANGED,
        });
    }
    // Already in the catalog (watched, imported) and now reassigned to me: news from
    // someone else, like a brand-new assignment.
    const reassigned = [
      ...new Set(
        round
          .filter((row) => {
            const prevAssignee = previousAssignee.get(row.key);
            return !firstSync && row.assigneeId === user.accountId && prevAssignee !== undefined && prevAssignee !== user.accountId;
          })
          .map((row) => row.key),
      ),
    ];
    // A status change noticed between syncs has no known author: assume
    // someone else, unless the user opened the issue since the last sync.
    const restatused = [
      ...new Set(
        round
          .filter((row) => {
            const before = previous.get(row.key);
            return before !== undefined && before !== row.status;
          })
          .map((row) => row.key),
      ),
    ];
    for (let i = 0; i < reassigned.length; i += UPSERT_BATCH) {
      await tx.update(issues)
        .set({ othersActivityAt: othersActivityUpTo(now) })
        .where(and(eq(issues.userId, user.id), eq(issues.connectionId, user.connectionId), inArray(issues.key, reassigned.slice(i, i + UPSERT_BATCH))));
    }
    for (let i = 0; i < restatused.length; i += UPSERT_BATCH) {
      await tx.update(issues)
        .set({ othersActivityAt: othersActivityUpTo(now) })
        .where(
          and(
            eq(issues.userId, user.id),
            eq(issues.connectionId, user.connectionId),
            inArray(issues.key, restatused.slice(i, i + UPSERT_BATCH)),
            sql`coalesce(${issues.seenAt}, 0) <= ${lastSyncAt?.getTime() ?? 0}`,
          ),
        );
    }
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
    await upsertSynced(tx, c, watched.filter((i) => !alreadySynced.has(i.key)));
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

export async function runSync(account: User, conn: Connection, wantFull: boolean): Promise<SyncResult> {
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
      await upsertSynced(tx, ctx, remote);
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

/** A Jira connection's choice of what is mine: assigned (default), or involved (reported too). */
function jiraMineOf(conn: Connection): "assigned" | "involved" {
  try {
    return (JSON.parse(conn.options) as { mine?: string }).mine === "involved" ? "involved" : "assigned";
  } catch {
    return "assigned";
  }
}
