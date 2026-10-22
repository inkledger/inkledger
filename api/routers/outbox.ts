// The queue of worklog changes a tracker couldn't take yet: listed, retried
// (each connection against its own tracker, through the contract:
// sync/timeWrites.ts replayContract), discarded.
import { z } from "zod";
import { and, asc, count, eq, inArray, isNull, not } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { LIST_MAX_ROWS } from "../lib/inputs";
import { getDb } from "../queries/connection";
import { connections, issues, outbox, worklogs } from "@db/schema";
import { PENDING_PREFIX } from "./worklogs";
import { replayContract } from "../sync/timeWrites";
import { heldSinkDelete } from "../sync/extraSinks";
import { withOutboxLock, type ReplayResult } from "../sync/outboxLocks";
import { singleFlight } from "../lib/locks";

export { pendingReplays, withOutboxLock } from "../sync/outboxLocks";

/** A "retry everything" under way, per user: concurrent asks share one run. */
const retries = singleFlight<number, ReplayResult>();

export const outboxRouter = createRouter({
  /** Queued operations, joined with the issue summary for display. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        id: outbox.id,
        kind: outbox.kind,
        issueKey: outbox.issueKey,
        remoteId: outbox.remoteId,
        timeSpentSeconds: outbox.timeSpentSeconds,
        started: outbox.started,
        comment: outbox.comment,
        attempts: outbox.attempts,
        lastError: outbox.lastError,
        createdAt: outbox.createdAt,
        issueSummary: issues.summary,
      })
      .from(outbox)
      .leftJoin(
        issues,
        and(eq(issues.userId, outbox.userId), eq(issues.connectionId, outbox.connectionId), eq(issues.key, outbox.issueKey)),
      )
      // A sink delete held while its worklog's own delete is under way isn't queued yet.
      .where(and(eq(outbox.userId, ctx.user.id), not(heldSinkDelete)))
      .orderBy(asc(outbox.createdAt), asc(outbox.id))
      .limit(LIST_MAX_ROWS);
    return rows;
  }),

  /** Replay the whole queue, each connection's against its own tracker; concurrent asks share one run. */
  retry: protectedProcedure.mutation(({ ctx }) => {
    return retries.run(ctx.user.id, async () => {
      const total: ReplayResult = { synced: 0, failed: 0, remaining: 0 };
      // Each connection with something queued, against its own tracker.
      const queued = await getDb().selectDistinct({ id: outbox.connectionId }).from(outbox).where(eq(outbox.userId, ctx.user.id));
      const conns = queued.length
        ? await getDb().select().from(connections).where(and(eq(connections.userId, ctx.user.id), inArray(connections.id, queued.map((q) => q.id)), isNull(connections.archivedAt)))
        : [];
      for (const conn of conns) {
        const r = await replayContract(conn);
        total.synced += r.synced;
        total.failed += r.failed;
      }
      // What is left, everywhere (a connection's replay counts its own).
      total.remaining = (await getDb().select({ n: count() }).from(outbox).where(and(eq(outbox.userId, ctx.user.id), not(heldSinkDelete))))[0]?.n ?? 0;
      return total;
    });
  }),

  /**
   * Drop a queued operation. For pending creates the local placeholder
   * worklog is removed too (it never existed on Jira).
   */
  discard: protectedProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(({ ctx, input }) =>
      // Never alongside a replay: it could post the entry right after it is dropped.
      withOutboxLock(ctx.user.id, async () => {
        const db = getDb();
        const [entry] = await db
          .select()
          .from(outbox)
          .where(and(eq(outbox.id, input.id), eq(outbox.userId, ctx.user.id)));
        if (entry?.kind === "create") {
          await db
            .delete(worklogs)
            .where(
              and(
                eq(worklogs.userId, ctx.user.id),
                eq(worklogs.connectionId, entry.connectionId),
                entry.worklogId !== null ? eq(worklogs.id, entry.worklogId) : and(eq(worklogs.issueKey, entry.issueKey), eq(worklogs.remoteId, `${PENDING_PREFIX}${entry.id}`)),
              ),
            );
        }
        await db
          .delete(outbox)
          .where(and(eq(outbox.id, input.id), eq(outbox.userId, ctx.user.id)));
        return { ok: true };
      }),
    ),
});
