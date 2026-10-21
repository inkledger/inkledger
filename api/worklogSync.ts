import { and, eq, inArray, isNotNull, like, not } from "drizzle-orm";
import { connectionSync, issues, outbox, syncState, worklogs, worklogTrash, type Connection, type User } from "@db/schema";
import { getDb } from "./queries/connection";
import {
  fetchDeletedWorklogIds,
  fetchIssueById,
  fetchUpdatedWorklogIds,
  fetchWorklogs,
  fetchWorklogsByIds,
  searchIssues,
  type JiraWorklog,
} from "./jira/client";
import { isAuthoredBy, PENDING_PREFIX, rowFromJira, upsertLocal } from "./routers/worklogs";
import { upsertIssue } from "./routers/issues";
import { contextFor, jiraConnections, type JiraUser } from "./providers/connections";
import { streamState } from "./sync/state";
import { creationInFlight } from "./sync/timeWrites";

/** How far back the first import reaches. */
export const WORKLOG_HISTORY_DAYS = 365;

export type WorklogSyncResult = { imported: number; deleted: number; initial: boolean };

/**
 * The user's worklogs, from Jira to here — so time logged in Jira itself
 * (or from another inkledger) shows up. First run: the last 12 months, issue by
 * issue. Then only what changed since the last run (Jira's /worklog/updated
 * and /worklog/deleted feeds). Read only: nothing is written to Jira.
 * Queued offline edits/deletes (outbox) win over Jira's copy until replayed.
 */
export async function syncWorklogs(user: User, opts: { reimport?: boolean } = {}): Promise<WorklogSyncResult> {
  const total: WorklogSyncResult = { imported: 0, deleted: 0, initial: false };
  for (const conn of await jiraConnections(user.id)) {
    const r = await syncConnectionWorklogs(user, conn, opts);
    total.imported += r.imported;
    total.deleted += r.deleted;
    total.initial ||= r.initial;
  }
  return total;
}

/**
 * One Jira connection's worklogs. Where it stands is its own (connection_sync,
 * "worklogs"); the connection from before connections were separate goes on
 * from the user's state.
 */
async function syncConnectionWorklogs(account: User, conn: Connection, opts: { reimport?: boolean }): Promise<WorklogSyncResult> {
  const db = getDb();
  const streamCheckpoint = conn.legacy ? null : Number((await streamState(conn.id, "worklogs"))?.checkpoint);
  const saved = conn.legacy
    ? ((await db.select({ at: syncState.lastWorklogSyncAt }).from(syncState).where(eq(syncState.userId, account.id)).limit(1))[0]?.at ?? null)
    : streamCheckpoint && Number.isFinite(streamCheckpoint)
      ? new Date(streamCheckpoint)
      : null;
  const since = opts.reimport ? null : saved;
  const queued = new Set([
    ...(
      await db
        .select({ id: outbox.remoteId })
        .from(outbox)
        .where(and(eq(outbox.userId, account.id), eq(outbox.connectionId, conn.id), inArray(outbox.kind, ["update", "delete"])))
    ).map((o) => o.id),
    // Deleted here while Jira still has it (its delete on the way, through
    // Jira or the sink standing in for it): never read back as new.
    ...(
      await db
        .select({ id: worklogTrash.remoteId })
        .from(worklogTrash)
        .where(and(eq(worklogTrash.userId, account.id), eq(worklogTrash.connectionId, conn.id), eq(worklogTrash.reason, "user"), isNotNull(worklogTrash.remoteId)))
    ).flatMap((o) => (o.id ? [o.id] : [])),
  ]);
  const startedAt = Date.now();
  const ctx = contextFor(account, conn);
  const result = since ? await incremental(ctx, since.getTime(), queued) : await initial(ctx, queued);
  const until = new Date(result.until ?? startedAt);
  if (conn.legacy) {
    await db.insert(syncState)
      .values({ userId: account.id, lastWorklogSyncAt: until })
      .onConflictDoUpdate({ target: syncState.userId, set: { lastWorklogSyncAt: until } });
  } else {
    await db
      .insert(connectionSync)
      .values({ connectionId: conn.id, stream: "worklogs", checkpoint: String(until.getTime()), lastOkAt: new Date() })
      .onConflictDoUpdate({ target: [connectionSync.connectionId, connectionSync.stream], set: { checkpoint: String(until.getTime()), lastOkAt: new Date() } });
  }
  return { imported: result.imported, deleted: result.deleted, initial: !since };
}

type Pass = { imported: number; deleted: number; until?: number };

type Ctx = ReturnType<typeof contextFor>;

async function initial({ user, creds }: Ctx, queued: Set<string>): Promise<Pass> {
  const from = Date.now() - WORKLOG_HISTORY_DAYS * 86_400_000;
  const found = await searchIssues(
    creds,
    `worklogAuthor = currentUser() AND worklogDate >= -${WORKLOG_HISTORY_DAYS}d ORDER BY updated DESC`,
    5000,
  );
  let imported = 0;
  let deleted = 0;
  for (const issue of found) {
    await ensureIssue(user, issue.key, () => Promise.resolve(issue));
    const mine = (await fetchWorklogs(creds, issue.key)).filter(
      (w) => isAuthoredBy(w, user.accountId) && Date.parse(w.started) >= from,
    );
    for (const w of mine) {
      if (queued.has(w.id)) continue;
      await upsertLocal(rowFromJira(user.id, issue.key, w, user.connectionId));
      imported++;
    }
    deleted += await dropMissing(user.id, user.connectionId, issue.key, mine.map((w) => w.id), queued, from);
  }
  return { imported, deleted };
}

async function incremental({ user, creds }: Ctx, since: number, queued: Set<string>): Promise<Pass> {
  const updated = await fetchUpdatedWorklogIds(creds, since);
  const removed = await fetchDeletedWorklogIds(creds, since);
  let imported = 0;
  if (updated.ids.length) {
    const list: JiraWorklog[] = await fetchWorklogsByIds(creds, updated.ids);
    const keyOf = await issueKeysById(user.id, user.connectionId);
    for (const w of list) {
      if (!isAuthoredBy(w, user.accountId) || queued.has(w.id) || !w.issueId) continue;
      let key = keyOf.get(w.issueId);
      if (!key) {
        const remote = await fetchIssueById(creds, w.issueId);
        if (!remote) continue;
        await ensureIssue(user, remote.key, () => Promise.resolve(remote));
        key = remote.key;
        keyOf.set(w.issueId, key);
      }
      await upsertLocal(rowFromJira(user.id, key, w, user.connectionId));
      imported++;
    }
  }
  const gone = removed.ids.filter((id) => !queued.has(id));
  let deleted = 0;
  if (gone.length) {
    deleted = (
      await getDb()
        .delete(worklogs)
        .where(and(eq(worklogs.userId, user.id), eq(worklogs.connectionId, user.connectionId), inArray(worklogs.remoteId, gone)))
        .returning({ id: worklogs.id })
    ).length;
  }
  return { imported, deleted, until: Math.max(updated.until, removed.until) || undefined };
}

/** Local issue keys by Jira id. */
async function issueKeysById(userId: number, connectionId: number): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ id: issues.remoteId, key: issues.key })
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId)));
  return new Map(rows.map((r) => [r.id, r.key]));
}

/** Worklogs need their issue in the catalog (summary, project): import it if missing. */
async function ensureIssue(user: JiraUser, key: string, load: () => Promise<Parameters<typeof upsertIssue>[3]>) {
  const [known] = await getDb()
    .select({ key: issues.key })
    .from(issues)
    .where(and(eq(issues.userId, user.id), eq(issues.connectionId, user.connectionId), eq(issues.key, key)))
    .limit(1);
  if (!known) await upsertIssue(user.id, user.siteUrl, user.connectionId, await load());
}

/** Local copies of Jira worklogs no longer there (inside the imported window). */
async function dropMissing(userId: number, connectionId: number, issueKey: string, keep: string[], queued: Set<string>, from: number): Promise<number> {
  const local = await getDb()
    .select({ id: worklogs.remoteId, started: worklogs.started })
    .from(worklogs)
    .where(
      and(
        eq(worklogs.userId, userId),
        eq(worklogs.connectionId, connectionId),
        eq(worklogs.issueKey, issueKey),
        not(like(worklogs.remoteId, `${PENDING_PREFIX}%`)),
      ),
    );
  const gone = local
    .filter((w) => !keep.includes(w.id) && !queued.has(w.id) && w.started.getTime() >= from)
    .map((w) => w.id);
  if (!gone.length) return 0;
  const removed = await getDb()
    .delete(worklogs)
    // One still being created (its answer on the way) stays, whatever the read said.
    .where(and(eq(worklogs.userId, userId), eq(worklogs.connectionId, connectionId), eq(worklogs.issueKey, issueKey), inArray(worklogs.remoteId, gone), not(creationInFlight())))
    .returning({ id: worklogs.id });
  return removed.length;
}
