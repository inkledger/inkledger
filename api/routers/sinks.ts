// Where a time sink files the user's time: its targets (projects, tasks)
// found by searching the sink, the activity each asks for, and which of the
// user's containers goes where (a default for all the others).
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { containers, connections, sinkMappings, worklogSinks } from "@db/schema";
import { t } from "@contracts/i18n";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { ownConnection } from "../providers/connections";
import { providerCall } from "../providers/trpc";
import { boundSink, pushSinks, sinksSoon } from "../sync/extraSinks";

const meta = () => ({ signal: AbortSignal.timeout(20_000), correlationId: `sink-ui-${Date.now()}` });
const target = z.object({ remoteId: z.string().min(1).max(200), name: z.string().max(300), path: z.array(z.object({ remoteId: z.string().max(200), name: z.string().max(300) })).max(10) });

async function ownSink(userId: number, id: number) {
  const conn = await ownConnection(userId, id);
  const b = boundSink(conn);
  if (!b) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.sinks.notASink") });
  return { conn, b };
}

export const sinksRouter = createRouter({
  /** What the sink files time under, found by its own search; and whether it needs one. */
  targets: protectedProcedure.input(z.object({ id: z.number().int().positive(), query: z.string().trim().max(100).default("") })).query(async ({ ctx, input }) => {
    const { b } = await ownSink(ctx.user.id, input.id);
    const use = b.capabilities.target.use;
    if (use === "none" || !b.targets) return { use, items: [], complete: true };
    const found = await providerCall(() => b.targets!(meta(), input.query, 25));
    return { use, ...found };
  }),

  /** The activities (work types) it offers, when it keeps them. */
  activities: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const { b } = await ownSink(ctx.user.id, input.id);
    const e = b.capabilities.entries;
    const required = e.model === "entries" ? e.activities.required : "no";
    if (!b.entries.activities) return { required, items: [] };
    return { required, items: (await providerCall(() => b.entries.activities!(meta(), {}, 100))).items };
  }),

  /** The sink's mappings: the default (container null) and one per container, with the containers it may map. */
  mappings: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    const { conn } = await ownSink(ctx.user.id, input.id);
    const db = getDb();
    const rows = await db.select().from(sinkMappings).where(eq(sinkMappings.sinkConnectionId, conn.id));
    const boxes = await db
      .select({ id: containers.id, key: containers.key, name: containers.name, connectionId: containers.connectionId })
      .from(containers)
      .innerJoin(connections, eq(connections.id, containers.connectionId))
      .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
      .orderBy(asc(containers.key));
    const failed = await db.select({ n: worklogSinks.worklogId }).from(worklogSinks).where(and(eq(worklogSinks.sinkConnectionId, conn.id), eq(worklogSinks.state, "failed")));
    return {
      mappings: rows.map((r) => ({ containerId: r.containerId, target: { remoteId: r.targetRemoteId, name: r.targetName }, activityId: r.activityId })),
      containers: boxes,
      failed: failed.length,
    };
  }),

  /** Files a container's time (or, with none, everything else's) under a target; the worklogs that couldn't go are tried again. */
  map: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), containerId: z.number().int().positive().nullable(), target, activityId: z.string().max(200).nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      const { conn } = await ownSink(ctx.user.id, input.id);
      const db = getDb();
      if (input.containerId !== null) {
        const [own] = await db
          .select({ id: containers.id })
          .from(containers)
          .innerJoin(connections, eq(connections.id, containers.connectionId))
          .where(and(eq(containers.id, input.containerId), eq(connections.userId, ctx.user.id)));
        if (!own) throw new TRPCError({ code: "NOT_FOUND" });
      }
      await db.delete(sinkMappings).where(and(eq(sinkMappings.sinkConnectionId, conn.id), input.containerId === null ? isNull(sinkMappings.containerId) : eq(sinkMappings.containerId, input.containerId)));
      await db.insert(sinkMappings).values({
        sinkConnectionId: conn.id,
        containerId: input.containerId,
        targetRemoteId: input.target.remoteId,
        targetName: input.target.name,
        targetPath: JSON.stringify(input.target.path),
        activityId: input.activityId,
      });
      await db.update(worklogSinks).set({ state: "pending", lastError: null }).where(and(eq(worklogSinks.sinkConnectionId, conn.id), eq(worklogSinks.state, "failed")));
      sinksSoon(ctx.user.id);
      return { ok: true };
    }),

  unmap: protectedProcedure.input(z.object({ id: z.number().int().positive(), containerId: z.number().int().positive().nullable() })).mutation(async ({ ctx, input }) => {
    const { conn } = await ownSink(ctx.user.id, input.id);
    await getDb()
      .delete(sinkMappings)
      .where(and(eq(sinkMappings.sinkConnectionId, conn.id), input.containerId === null ? isNull(sinkMappings.containerId) : eq(sinkMappings.containerId, input.containerId)));
    return { ok: true };
  }),

  /** Sends what is waiting now (Settings → the sink's "Send now"). */
  push: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await ownSink(ctx.user.id, input.id);
    return pushSinks(ctx.user.id);
  }),
});
