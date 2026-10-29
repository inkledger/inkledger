import { pushSinks } from "./sync/extraSinks";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { connections, sessions, syncState, users, type User } from "@db/schema";
import { markConnection, markJiraConnection } from "./providers/connections";
import { originOf } from "./providers/core/origin";
import { syncUser } from "./routers/issues";
import { JiraApiError } from "./jira/client";
import { UnreadableCredentialsError } from "./middleware";
import { isShuttingDown } from "./lib/shutdown";
import { inMaintenance } from "./lib/maintenance";
import { readDueHistories } from "./estimates/history";

/**
 * Jira refused the stored credentials (revoked token) or they can't be decrypted: retrying
 * every interval would hammer Jira (Server may lock the account or ask for a CAPTCHA).
 */
function credentialsRejected(e: unknown): boolean {
  const cause = e instanceof Error && e.cause !== undefined ? e.cause : e;
  return (
    (e instanceof JiraApiError && e.status === 401) ||
    e instanceof UnreadableCredentialsError ||
    cause instanceof UnreadableCredentialsError
  );
}

/**
 * Users with at least one live session and a working tracker connection: a
 * logout stops their background sync, an account with nothing connected has
 * nothing to sync, and a connection waiting to be reconnected is left alone.
 */
export async function activeUsers(now: Date = new Date()): Promise<User[]> {
  const rows = await getDb()
    .selectDistinct({ user: users })
    .from(users)
    .innerJoin(sessions, and(eq(sessions.userId, users.id), gt(sessions.expiresAt, now)))
    .innerJoin(connections, and(eq(connections.userId, users.id), isNull(connections.archivedAt), eq(connections.status, "ok")));
  return rows.map((r) => r.user);
}

/** A background sync is full at least this often (catalog refresh + watchers). */
export const FULL_SYNC_EVERY_MS = 60 * 60_000;

/** Full when the user never had one, or the last is older than FULL_SYNC_EVERY_MS. */
export async function needsFullSync(userId: number, now: number = Date.now()): Promise<boolean> {
  const [row] = await getDb()
    .select({ at: syncState.lastFullSyncAt })
    .from(syncState)
    .where(eq(syncState.userId, userId))
    .limit(1);
  const last = row?.at;
  return !last || now - last.getTime() >= FULL_SYNC_EVERY_MS;
}

/** One pass: sync every active user in turn; failures are logged, never thrown. */
export async function syncActiveUsers(): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const user of await activeUsers()) {
    if (isShuttingDown() || inMaintenance()) break; // the rest waits for the next boot (or pass)
    try {
      await syncUser(user, { full: await needsFullSync(user.id), background: true });
      // Time still waiting for the user's time sinks goes now too.
      await pushSinks(user.id).catch((e: unknown) => console.warn(`[sinks] user ${user.id}: ${String(e)}`));
      ok++;
    } catch (e) {
      failed++;
      console.warn(
        `[sync] user ${user.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      if (credentialsRejected(e)) {
        // The connection waits for the user to reconnect it: no more background
        // syncs on it (Jira Server may lock an account hammered with a bad
        // password), and the user stays signed in.
        const status = e instanceof JiraApiError ? "auth_failed" : "unreadable";
        const from = originOf(e);
        await (from !== undefined ? markConnection(user.id, from, status) : markJiraConnection(user.id, status));
        console.warn(`[sync] user ${user.id}: credentials rejected, connection waits to be reconnected`);
      }
    }
  }
  return { ok, failed };
}

/** The history pass never fails the sync's: a failure waits for the next pass. */
async function readHistories(): Promise<void> {
  try {
    await readDueHistories();
  } catch (e) {
    console.warn(`[estimates] history pass: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** First pass soon after boot, so a restart doesn't leave data stale for a whole interval. */
export const FIRST_SYNC_DELAY_MS = 30_000;

/**
 * Background Jira sync every `minutes` (0 disables): the first pass shortly
 * after boot, then one every interval measured from the end of the previous
 * one (a slow pass delays the next, it never skips it). Returns a stop
 * function that resolves once the pass in progress, if any, is over.
 */
export function startSyncScheduler(minutes: number): () => Promise<void> {
  if (minutes <= 0) return async () => {};
  let stopped = false;
  let current: Promise<unknown> | null = null;
  let handle: ReturnType<typeof setTimeout>;
  const schedule = (ms: number) => {
    handle = setTimeout(() => {
      // Then the status histories the pass made due (estimates): read only, a bounded number per pass.
      current = syncActiveUsers()
        .then(() => (isShuttingDown() ? undefined : readHistories()))
        .finally(() => {
          current = null;
          if (!stopped) schedule(minutes * 60_000);
        });
    }, ms);
    handle.unref();
  };
  schedule(Math.min(FIRST_SYNC_DELAY_MS, minutes * 60_000));
  return async () => {
    stopped = true;
    clearTimeout(handle);
    await current;
  };
}
