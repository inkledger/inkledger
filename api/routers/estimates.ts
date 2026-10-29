// Estimates (docs/work/ideas/estimates.md): how long an issue or a TODO likely
// takes, from my closed issues, and which statuses count as work.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { connections, workStatuses } from "@db/schema";
import { t } from "@contracts/i18n";
import { countsAsWork } from "@contracts/estimate";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb, q } from "../queries/connection";
import { issueKeyInput } from "../lib/inputs";
import { estimateForIssue, estimateForTodo } from "../estimates/estimate";
import { statusesOf, type Known } from "../estimates/history";
import { boundTracker } from "../sync/engine";
import { providerCall } from "../providers/trpc";
import { callMeta } from "../issues/search";

const id = z.number().int().positive();

/** The user's own connection, else NOT_FOUND (never another's: R-0.8). */
async function ownConnection(userId: number, connectionId: number) {
  const [conn] = await getDb()
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.userId, userId), isNull(connections.archivedAt)))
    .limit(1);
  if (!conn) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
  return conn;
}

/** A connection's statuses, each with whether it counts as work and whether that is the default (R-3.14). */
async function listWorkStatuses(userId: number, connectionId: number) {
  const conn = await ownConnection(userId, connectionId);
  const b = boundTracker(conn);
  const known: Known = b ? await providerCall(() => statusesOf(conn, b, callMeta())) : { statuses: new Map() };
  const chosen = new Map(
    (await getDb().select().from(workStatuses).where(and(eq(workStatuses.userId, userId), eq(workStatuses.connectionId, connectionId)))).map((w) => [w.statusId, w.counts === 1]),
  );
  const hasDoing = [...known.statuses.values()].some((s) => s.category === "doing");
  return [...known.statuses].map(([statusId, s]) => {
    const override = chosen.get(statusId);
    return { statusId, name: s.name, category: s.category, counts: countsAsWork({ category: s.category, hasDoing, override }), byDefault: override === undefined };
  });
}

export const estimatesRouter = createRouter({
  /** How long this issue likely takes; nothing for a closed one. */
  forIssue: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: id.optional() }))
    .query(({ ctx, input }) => estimateForIssue(ctx.user.id, input, Date.now())),

  /** A TODO's: its issue's, or my habit with TODO estimates. */
  forTodo: protectedProcedure.input(z.object({ id })).query(({ ctx, input }) => estimateForTodo(ctx.user.id, input.id, Date.now())),

  /** How many of my closed issues with my time are in each history state (Settings). */
  historyStates: protectedProcedure.query(async ({ ctx }) => {
    const rows = await q<{ state: string; n: number }>(
      `SELECT coalesce(r."state", 'pending') AS "state", count(*)::int AS "n"
       FROM "issues" i LEFT JOIN "issue_history_reads" r ON r."item_id" = i."id"
       WHERE i."user_id" = ? AND i."category" = 'done' AND i."gone_at" IS NULL
         AND EXISTS (SELECT 1 FROM "worklogs" w WHERE w."item_id" = i."id" AND w."user_id" = i."user_id")
       GROUP BY 1`,
      ctx.user.id,
    );
    const count = (state: string) => rows.find((r) => r.state === state)?.n ?? 0;
    return { available: count("available"), pending: count("pending"), unsupported: count("unsupported"), stale: count("stale"), retry: count("retry"), invalid: count("invalid") };
  }),

  /** A connection's statuses and whether each counts as work. */
  workStatuses: protectedProcedure.input(z.object({ connectionId: id })).query(({ ctx, input }) => listWorkStatuses(ctx.user.id, input.connectionId)),

  /** Counts as work or not; null: back to the default. The revision is raised by the table's trigger. */
  setWorkStatus: protectedProcedure
    .input(z.object({ connectionId: id, statusId: z.string().min(1).max(200), counts: z.boolean().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const listed = await listWorkStatuses(ctx.user.id, input.connectionId);
      if (!listed.some((s) => s.statusId === input.statusId)) throw new TRPCError({ code: "NOT_FOUND", message: t("server.estimates.unknownStatus") });
      const where = and(eq(workStatuses.userId, ctx.user.id), eq(workStatuses.connectionId, input.connectionId), eq(workStatuses.statusId, input.statusId));
      if (input.counts === null) await getDb().delete(workStatuses).where(where);
      else
        await getDb()
          .insert(workStatuses)
          .values({ userId: ctx.user.id, connectionId: input.connectionId, statusId: input.statusId, counts: input.counts ? 1 : 0 })
          .onConflictDoUpdate({ target: [workStatuses.userId, workStatuses.connectionId, workStatuses.statusId], set: { counts: sql`excluded."counts"` } });
      return { ok: true as const };
    }),
});
