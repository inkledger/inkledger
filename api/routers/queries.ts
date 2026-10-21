// Searches the user keeps (§4.7): saved ones by name, and the last ones used
// (at most RECENT_MAX). Stored as the query language in English, so a search
// saved in Italian reads the same in English and back.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { recentQueries, savedQueries } from "@db/schema";
import { formatQuery, parseQuery } from "@contracts/query";
import { t } from "@contracts/i18n";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";

const RECENT_MAX = 10;
const query = z.string().trim().min(1).max(200);

/** A query as kept: its canonical English form (or the text as typed, when it parses to nothing). */
const canonical = (text: string) => formatQuery(parseQuery(text).expr, "en") || text.trim();

export const queriesRouter = createRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const [saved, recent] = await Promise.all([
      db.select({ id: savedQueries.id, name: savedQueries.name, query: savedQueries.query }).from(savedQueries).where(eq(savedQueries.userId, ctx.user.id)).orderBy(asc(sql`lower(${savedQueries.name})`)),
      db.select({ query: recentQueries.query }).from(recentQueries).where(eq(recentQueries.userId, ctx.user.id)).orderBy(desc(recentQueries.usedAt)).limit(RECENT_MAX),
    ]);
    return { saved, recent: recent.map((r) => r.query) };
  }),

  /** A search was run: first among the recent ones; the oldest beyond RECENT_MAX go. */
  used: protectedProcedure.input(z.object({ query })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const q = canonical(input.query);
    await db
      .insert(recentQueries)
      .values({ userId: ctx.user.id, query: q, usedAt: new Date() })
      .onConflictDoUpdate({ target: [recentQueries.userId, recentQueries.query], set: { usedAt: new Date() } });
    await db.execute(
      sql`DELETE FROM ${recentQueries} WHERE ${recentQueries.userId} = ${ctx.user.id} AND ${recentQueries.query} NOT IN (SELECT ${recentQueries.query} FROM ${recentQueries} WHERE ${recentQueries.userId} = ${ctx.user.id} ORDER BY ${recentQueries.usedAt} DESC LIMIT ${RECENT_MAX})`,
    );
    return { query: q };
  }),

  clearRecent: protectedProcedure.mutation(async ({ ctx }) => {
    await getDb().delete(recentQueries).where(eq(recentQueries.userId, ctx.user.id));
    return { ok: true };
  }),

  /** Saves a search under a name (a name already used is overwritten). */
  save: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(60), query })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const q = canonical(input.query);
    const [same] = await db
      .select({ id: savedQueries.id })
      .from(savedQueries)
      .where(and(eq(savedQueries.userId, ctx.user.id), sql`lower(${savedQueries.name}) = lower(${input.name})`));
    if (same) {
      await db.update(savedQueries).set({ query: q }).where(eq(savedQueries.id, same.id));
      return { id: same.id, query: q };
    }
    const [row] = await db.insert(savedQueries).values({ userId: ctx.user.id, name: input.name, query: q }).returning({ id: savedQueries.id });
    return { id: row.id, query: q };
  }),

  delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const gone = await getDb()
      .delete(savedQueries)
      .where(and(eq(savedQueries.id, input.id), eq(savedQueries.userId, ctx.user.id)))
      .returning({ id: savedQueries.id });
    if (gone.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: t("server.queries.notFound") });
    return { ok: true };
  }),
});
