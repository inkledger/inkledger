import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueNotes, pinboardNotes, pinboards } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { boardDisplayName } from "@contracts/pinboard";
import { t } from "@contracts/i18n";

/** Private notes on an issue: the user's own comments, never sent to Jira (no Jira client here). */
const body = z.string().trim().min(1, { error: () => t("server.issueNotes.empty") }).max(5000);
const idInput = z.number().int().positive();
/** The issue's connection, when a key lives on two. */
const connectionInput = z.number().int().positive().optional();

async function own(userId: number, id: number) {
  const [row] = await getDb()
    .select()
    .from(issueNotes)
    .where(and(eq(issueNotes.id, id), eq(issueNotes.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issueNotes.notFound") });
  return row;
}

export const issueNotesRouter = createRouter({
  /** The notes on an issue, newest first, with the boards each one hangs on. */
  list: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput })).query(async ({ ctx, input }) => {
    const db = getDb();
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    const notes = await db
      .select()
      .from(issueNotes)
      .where(and(eq(issueNotes.userId, ctx.user.id), eq(issueNotes.connectionId, conn.id), eq(issueNotes.issueKey, input.issueKey)))
      .orderBy(desc(issueNotes.createdAt), desc(issueNotes.id));
    const ids = notes.map((n) => n.id);
    const hung = ids.length
      ? await db
          .select({ noteId: pinboardNotes.issueNoteId, boardId: pinboards.id, name: pinboards.name })
          .from(pinboardNotes)
          .innerJoin(pinboards, eq(pinboards.id, pinboardNotes.boardId))
          .where(and(eq(pinboardNotes.userId, ctx.user.id), inArray(pinboardNotes.issueNoteId, ids)))
      : [];
    return notes.map((n) => ({
      ...n,
      pinnedOn: hung.filter((h) => h.noteId === n.id).map((h) => ({ boardId: h.boardId, boardName: boardDisplayName(h.name) })),
    }));
  }),

  add: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput, body })).mutation(async ({ ctx, input }) => {
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    const [row] = await getDb()
      .insert(issueNotes)
      .values({ userId: ctx.user.id, connectionId: conn.id, issueKey: input.issueKey, body: input.body })
      .returning({ id: issueNotes.id });
    return { id: row.id };
  }),

  update: protectedProcedure.input(z.object({ id: idInput, body })).mutation(async ({ ctx, input }) => {
    const row = await own(ctx.user.id, input.id);
    await getDb().update(issueNotes).set({ body: input.body, updatedAt: new Date() }).where(eq(issueNotes.id, row.id));
    return { ok: true };
  }),

  /** Delete a note (its post-its go with it). Returns it so "Undo" can put the text back. */
  remove: protectedProcedure.input(z.object({ id: idInput })).mutation(async ({ ctx, input }) => {
    const row = await own(ctx.user.id, input.id);
    await getDb().delete(issueNotes).where(eq(issueNotes.id, row.id));
    return row;
  }),

  /** Put back a note deleted by mistake (same issue, text and date; not its post-its). */
  restore: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput, body, createdAt: z.number().int().nonnegative() }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const [row] = await getDb()
        .insert(issueNotes)
        .values({ userId: ctx.user.id, connectionId: conn.id, issueKey: input.issueKey, body: input.body, createdAt: new Date(input.createdAt) })
        .returning({ id: issueNotes.id });
      return { id: row.id };
    }),
});
