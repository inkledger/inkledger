import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { pendingReplays } from "../routers/outbox";
import { connections, type Connection, type User } from "@db/schema";
import { syncConnectionEntries, syncConnectionIssues, syncInbox, withStream } from "./engine";
import { replayContract } from "./timeWrites";
import { t } from "@contracts/i18n";
import { isShuttingDown } from "../lib/shutdown";
import { syncWorklogs } from "../worklogSync";
import { runSync, type SyncResult } from "./jiraIssues";

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

/**
 * Every active connection of the user, each through the sync engine (its
 * stream lease and wait, its outcome recorded). Jira keeps its own pass
 * (activity, watchers, notifications) until the catalogue maps any tracker's
 * statuses (WP-14); other trackers go through the provider contract. The
 * result is Jira's, as before; another tracker's failure is logged, never
 * fails the rest.
 */
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
