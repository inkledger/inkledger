// The user's buckets and the one each device has on.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bucketColumns, bucketSources, buckets, connections, containers, devicePrefs, issues } from "@db/schema";
import { formatQuery, parseQuery } from "@contracts/query";
import { t } from "@contracts/i18n";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { activeBucket } from "../queries/buckets";

const source = z.object({ connectionId: z.number().int().positive(), containerId: z.number().int().positive().nullable().default(null) });
const boardMode = z.enum(["lanes", "category", "custom"]);
const column = z.object({ name: z.string().trim().min(1).max(40), statuses: z.record(z.string().regex(/^\d+$/), z.array(z.string().min(1).max(100)).max(50)) });

/** A bucket of the user's, or NOT_FOUND. */
async function ownBucket(userId: number, id: number) {
  const [own] = await getDb().select({ id: buckets.id }).from(buckets).where(and(eq(buckets.id, id), eq(buckets.userId, userId))).limit(1);
  if (!own) throw new TRPCError({ code: "NOT_FOUND" });
  return own;
}

const parseStatuses = (raw: string): Record<string, string[]> => {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).map(([k, list]) => [k, Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : []]));
  } catch {
    return {};
  }
};

export const bucketsRouter = createRouter({
  /** The user's buckets with their sources, and which one this device has on. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db.select().from(buckets).where(eq(buckets.userId, ctx.user.id)).orderBy(asc(buckets.position), asc(buckets.id));
    const sources = rows.length
      ? await db
          .select({ bucketId: bucketSources.bucketId, connectionId: bucketSources.connectionId, containerId: bucketSources.containerId })
          .from(bucketSources)
          .where(inArray(bucketSources.bucketId, rows.map((b) => b.id)))
      : [];
    const columns = rows.length ? await db.select().from(bucketColumns).where(inArray(bucketColumns.bucketId, rows.map((b) => b.id))).orderBy(asc(bucketColumns.position), asc(bucketColumns.id)) : [];
    return {
      buckets: rows.map((b) => ({
        id: b.id,
        name: b.name,
        query: b.query,
        boardMode: boardMode.catch("lanes").parse(b.boardMode),
        sources: sources.filter((s) => s.bucketId === b.id).map(({ connectionId, containerId }) => ({ connectionId, containerId })),
        columns: columns.filter((c) => c.bucketId === b.id).map((c) => ({ id: c.id, name: c.name, statuses: parseStatuses(c.statuses) })),
      })),
      active: await activeBucket(ctx.user.id, ctx.deviceId),
    };
  }),

  /** The containers a bucket can pick from: each live connection's, by name. */
  sources: protectedProcedure.query(async ({ ctx }) =>
    getDb()
      .select({ id: containers.id, connectionId: containers.connectionId, key: containers.key, name: containers.name })
      .from(containers)
      .innerJoin(connections, eq(connections.id, containers.connectionId))
      .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
      .orderBy(asc(containers.connectionId), asc(containers.key)),
  ),

  /** A new bucket, or new name and sources for one. */
  save: protectedProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(60),
        sources: z.array(source).min(1).max(100),
        /** A search narrowing it further (any language; kept in English) */
        query: z.string().trim().max(500).default(""),
        boardMode: boardMode.default("lanes"),
        /** Custom board columns, in order */
        columns: z.array(column).max(12).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // Only the user's own connections and their containers.
      const mine = await db.select({ id: connections.id }).from(connections).where(eq(connections.userId, ctx.user.id));
      const ownIds = new Set(mine.map((c) => c.id));
      const boxes = await db.select({ id: containers.id, connectionId: containers.connectionId }).from(containers).where(inArray(containers.connectionId, [...ownIds, -1]));
      for (const s of input.sources) {
        if (!ownIds.has(s.connectionId) || (s.containerId !== null && !boxes.some((b) => b.id === s.containerId && b.connectionId === s.connectionId))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: t("server.buckets.badSource") });
        }
      }
      const query = formatQuery(parseQuery(input.query).expr, "en");
      return db.transaction(async (tx) => {
        let id = input.id;
        if (id !== undefined) {
          const [own] = await tx.update(buckets).set({ name: input.name, query, boardMode: input.boardMode }).where(and(eq(buckets.id, id), eq(buckets.userId, ctx.user.id))).returning({ id: buckets.id });
          if (!own) throw new TRPCError({ code: "NOT_FOUND" });
          await tx.delete(bucketSources).where(eq(bucketSources.bucketId, id));
        } else {
          const count = (await tx.select({ id: buckets.id }).from(buckets).where(eq(buckets.userId, ctx.user.id))).length;
          id = (await tx.insert(buckets).values({ userId: ctx.user.id, name: input.name, position: count, query, boardMode: input.boardMode }).returning({ id: buckets.id }))[0].id;
        }
        await tx.insert(bucketSources).values(input.sources.map((s) => ({ bucketId: id, ...s })));
        if (input.columns) {
          // Columns name only the bucket's own trackers.
          const inBucket = new Set(input.sources.map((s) => String(s.connectionId)));
          await tx.delete(bucketColumns).where(eq(bucketColumns.bucketId, id));
          if (input.columns.length > 0) {
            await tx.insert(bucketColumns).values(
              input.columns.map((c, position) => ({
                bucketId: id,
                position,
                name: c.name,
                statuses: JSON.stringify(Object.fromEntries(Object.entries(c.statuses).filter(([conn]) => inBucket.has(conn)))),
              })),
            );
          }
        }
        return { id };
      });
    }),

  /** The board's layout for a bucket, from the board itself. */
  setBoardMode: protectedProcedure.input(z.object({ id: z.number().int().positive(), mode: boardMode })).mutation(async ({ ctx, input }) => {
    await ownBucket(ctx.user.id, input.id);
    await getDb().update(buckets).set({ boardMode: input.mode }).where(eq(buckets.id, input.id));
    return { ok: true };
  }),

  /** The buckets in a new order (the switchers list them so). */
  reorder: protectedProcedure.input(z.object({ ids: z.array(z.number().int().positive()).max(100) })).mutation(async ({ ctx, input }) => {
    await getDb().transaction(async (tx) => {
      for (const [position, id] of input.ids.entries()) {
        await tx.update(buckets).set({ position }).where(and(eq(buckets.id, id), eq(buckets.userId, ctx.user.id)));
      }
    });
    return { ok: true };
  }),

  /** The statuses each of the user's trackers has shown, by category: what custom columns map. */
  statuses: protectedProcedure.query(async ({ ctx }) =>
    getDb()
      .selectDistinct({ connectionId: issues.connectionId, status: issues.status, category: issues.category })
      .from(issues)
      .innerJoin(connections, eq(connections.id, issues.connectionId))
      .where(and(eq(issues.userId, ctx.user.id), isNull(connections.archivedAt), sql`${issues.status} <> ''`))
      .orderBy(asc(issues.connectionId), asc(issues.status)),
  ),

  delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const gone = await getDb().delete(buckets).where(and(eq(buckets.id, input.id), eq(buckets.userId, ctx.user.id))).returning({ id: buckets.id });
    if (gone.length === 0) throw new TRPCError({ code: "NOT_FOUND" });
    return { ok: true };
  }),

  /** This device's bucket (null: everything). */
  setActive: protectedProcedure.input(z.object({ id: z.number().int().positive().nullable() })).mutation(async ({ ctx, input }) => {
    if (!ctx.deviceId) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.buckets.noDevice") });
    if (input.id !== null) await ownBucket(ctx.user.id, input.id);
    await getDb()
      .insert(devicePrefs)
      .values({ userId: ctx.user.id, deviceId: ctx.deviceId, bucketId: input.id, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [devicePrefs.userId, devicePrefs.deviceId], set: { bucketId: input.id, updatedAt: new Date() } });
    return { active: input.id };
  }),
});
