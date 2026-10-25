// The queue of worklog changes a tracker couldn't take yet: listed, retried
// (each connection against its own tracker, through the contract:
// sync/timeWrites.ts replayContract), discarded.
import { z } from "zod";
import { and, asc, count, eq, inArray, isNull, lt, not, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { t } from "@contracts/i18n";
import { TIME_SINK_TYPES } from "@contracts/providers";
import { createRouter, protectedProcedure } from "../middleware";
import { LIST_MAX_ROWS } from "../lib/inputs";
import { getDb } from "../queries/connection";
import { connections, issues, outbox, worklogs } from "@db/schema";
import { PENDING_PREFIX } from "./worklogs";
import { CLAIM_TTL_MS, replayContract } from "../sync/timeWrites";
import { heldSinkDelete, pushSinks } from "../sync/extraSinks";
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
      // A sink's queued deletes go with the sinks' own pass (a sink has no tracker to replay
      // against), all of them as "Send now" does; a tracker's queue, replayed.
      const isSink = (c: { type: string }) => (TIME_SINK_TYPES as readonly string[]).includes(c.type);
      const sinks = conns.filter(isSink);
      for (const conn of conns.filter((c) => !isSink(c))) {
        const r = await replayContract(conn);
        total.synced += r.synced;
        total.failed += r.failed;
      }
      if (sinks.length > 0) {
        const r = await pushSinks(ctx.user.id, Date.now, { force: true });
        total.synced += r.sent;
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
      withOutboxLock(ctx.user.id, () =>
        // Only while no replay (another process on this database included) is sending it.
        getDb().transaction(async (db) => {
          const [entry] = await db
            .delete(outbox)
            .where(and(eq(outbox.id, input.id), eq(outbox.userId, ctx.user.id), or(isNull(outbox.claimedAt), lt(outbox.claimedAt, Date.now() - CLAIM_TTL_MS))))
            .returning();
          if (!entry) {
            const [still] = await db.select({ id: outbox.id }).from(outbox).where(and(eq(outbox.id, input.id), eq(outbox.userId, ctx.user.id)));
            if (still) throw new TRPCError({ code: "CONFLICT", message: t("server.worklogs.justSynced") });
            return { ok: true };
          }
          if (entry.kind === "create") {
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
          return { ok: true };
        }),
      ),
    ),
});
