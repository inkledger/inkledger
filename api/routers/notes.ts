import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  NOTE_BODY_MAX,
  NOTE_FILTERS,
  NOTE_SEARCH_MAX,
  NOTE_SEARCH_MIN,
  NOTE_TITLE_MAX,
  type NoteChange,
  type NoteConflict,
  type NoteUpdated,
} from "@contracts/notes";
import { markdownNoteVersions, markdownNotes } from "@db/schema";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { noteDerived, searchNotes } from "../queries/noteSearch";
import {
  createNote,
  deleteNote,
  moveNote,
  noteDocument,
  noteTreeItem,
  ownNote,
  restoreNoteBatch,
  snapshotNote,
} from "../queries/notes";
import { publish } from "../lib/userEvents";
import { t } from "@contracts/i18n";

const id = z.uuid();
const title = z.string().max(NOTE_TITLE_MAX);
const body = z.string().max(NOTE_BODY_MAX);
const issue = z.object({
  connectionId: z.number().int().positive(),
  issueKey: issueKeyInput,
});
const revision = z.number().int().positive();

function changed(userId: number, id: string, change: NoteChange): void {
  publish(userId, { type: "notes", id, change });
}

async function checkedIssue(
  userId: number,
  value: { connectionId: number; issueKey: string } | null
) {
  if (!value) return null;
  const connection = await issueConnection(
    userId,
    value.issueKey,
    value.connectionId
  );
  return { connectionId: connection.id, issueKey: value.issueKey };
}

export const notesRouter = createRouter({
  tree: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select({
        id: markdownNotes.id,
        parentId: markdownNotes.parentId,
        position: markdownNotes.position,
        title: markdownNotes.title,
        contentRevision: markdownNotes.contentRevision,
        connectionId: markdownNotes.connectionId,
        issueKey: markdownNotes.issueKey,
        createdAt: markdownNotes.createdAt,
        updatedAt: markdownNotes.updatedAt,
      })
      .from(markdownNotes)
      .where(
        and(
          eq(markdownNotes.userId, ctx.user.id),
          isNull(markdownNotes.deletedAt)
        )
      )
      .orderBy(
        asc(markdownNotes.parentId),
        asc(markdownNotes.position),
        asc(markdownNotes.id)
      );
    return rows;
  }),

  get: protectedProcedure
    .input(z.object({ id }))
    .query(async ({ ctx, input }) =>
      noteDocument(await ownNote(getDb(), ctx.user.id, input.id, true))
    ),

  forIssue: protectedProcedure
    .input(
      z.object({
        connectionId: z.number().int().positive().optional(),
        issueKey: issueKeyInput,
      })
    )
    .query(async ({ ctx, input }) => {
      const connection = await issueConnection(
        ctx.user.id,
        input.issueKey,
        input.connectionId
      );
      const rows = await getDb()
        .select()
        .from(markdownNotes)
        .where(
          and(
            eq(markdownNotes.userId, ctx.user.id),
            isNull(markdownNotes.deletedAt),
            eq(markdownNotes.connectionId, connection.id),
            eq(markdownNotes.issueKey, input.issueKey)
          )
        )
        .orderBy(desc(markdownNotes.updatedAt), desc(markdownNotes.id));
      return rows.map(noteTreeItem);
    }),

  search: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().min(NOTE_SEARCH_MIN).max(NOTE_SEARCH_MAX),
        filter: z.enum(NOTE_FILTERS).default("all"),
        issue: issue.optional(),
        cursor: z.string().max(16_000).optional(),
        limit: z.number().int().min(1).max(50).default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.issue) await checkedIssue(ctx.user.id, input.issue);
      return searchNotes(ctx.user.id, input);
    }),

  create: protectedProcedure
    .input(
      z
        .object({
          title,
          body,
          parentId: id.nullable().default(null),
          issue: issue.nullable().default(null),
        })
        .refine(
          value =>
            value.title.trim().length > 0 || value.body.trim().length > 0,
          { error: () => t("server.notes.empty") }
        )
    )
    .mutation(async ({ ctx, input }) => {
      const linked = await checkedIssue(ctx.user.id, input.issue);
      const row = await createNote(ctx.user.id, { ...input, issue: linked });
      changed(ctx.user.id, row.id, "create");
      return noteDocument(row);
    }),

  updateContent: protectedProcedure
    .input(
      z.object({
        id,
        title,
        body,
        expectedRevision: revision,
      })
    )
    .mutation(async ({ ctx, input }): Promise<NoteUpdated | NoteConflict> => {
      const derived = noteDerived(input.title, input.body);
      const result = await getDb().transaction(
        async (tx): Promise<NoteUpdated | NoteConflict> => {
          const current = await ownNote(tx, ctx.user.id, input.id);
          if (current.deletedAt)
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: t("server.notes.deleted"),
            });
          if (current.contentRevision !== input.expectedRevision)
            return { status: "conflict", current: noteDocument(current) };
          const [next] = await tx
            .update(markdownNotes)
            .set({
              title: input.title,
              body: input.body,
              bodyText: derived.bodyText,
              searchTitle: derived.searchTitle,
              searchText: derived.searchText,
              contentRevision: sql`${markdownNotes.contentRevision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(markdownNotes.id, input.id),
                eq(markdownNotes.userId, ctx.user.id),
                isNull(markdownNotes.deletedAt),
                eq(markdownNotes.contentRevision, input.expectedRevision)
              )
            )
            .returning();
          if (!next) {
            const now = await ownNote(tx, ctx.user.id, input.id);
            if (now.deletedAt)
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: t("server.notes.deleted"),
              });
            return { status: "conflict", current: noteDocument(now) };
          }
          return { status: "updated", note: noteDocument(next) };
        }
      );
      if (result.status === "updated")
        changed(ctx.user.id, input.id, "content");
      return result;
    }),

  move: protectedProcedure
    .input(
      z.object({
        id,
        parentId: id.nullable(),
        index: z.number().int().min(0).max(5_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const row = await moveNote(
        ctx.user.id,
        input.id,
        input.parentId,
        input.index
      );
      changed(ctx.user.id, input.id, "move");
      return row;
    }),

  setIssue: protectedProcedure
    .input(z.object({ id, issue: issue.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const linked = await checkedIssue(ctx.user.id, input.issue);
      const [row] = await getDb()
        .update(markdownNotes)
        .set({
          connectionId: linked?.connectionId ?? null,
          issueKey: linked?.issueKey ?? null,
          itemId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(markdownNotes.id, input.id),
            eq(markdownNotes.userId, ctx.user.id),
            isNull(markdownNotes.deletedAt)
          )
        )
        .returning();
      if (!row) {
        const current = await ownNote(getDb(), ctx.user.id, input.id);
        if (current.deletedAt)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: t("server.notes.deleted"),
          });
      }
      changed(ctx.user.id, input.id, "issue");
      return noteTreeItem(row);
    }),

  remove: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      const result = await deleteNote(ctx.user.id, input.id);
      changed(ctx.user.id, input.id, "delete");
      return result;
    }),

  trash: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(markdownNotes)
      .where(
        and(
          eq(markdownNotes.userId, ctx.user.id),
          sql`${markdownNotes.deletedAt} IS NOT NULL`
        )
      )
      .orderBy(desc(markdownNotes.deletedAt), desc(markdownNotes.id));
    const parents = rows
      .map(row => row.parentId)
      .filter((value): value is string => value !== null);
    const active = parents.length
      ? await db
          .select({ id: markdownNotes.id })
          .from(markdownNotes)
          .where(
            and(
              eq(markdownNotes.userId, ctx.user.id),
              isNull(markdownNotes.deletedAt),
              inArray(markdownNotes.id, parents)
            )
          )
      : [];
    const activeParents = new Set(active.map(row => row.id));
    const batches = new Map<
      string,
      {
        batch: string;
        rootId: string;
        title: string;
        deletedAt: Date;
        count: number;
        parentId: string | null;
        parentActive: boolean;
      }
    >();
    for (const row of rows) {
      if (
        !row.deleteBatch ||
        !row.deleteRootId ||
        !row.deletedAt ||
        batches.has(row.deleteBatch)
      )
        continue;
      const root =
        rows.find(candidate => candidate.id === row.deleteRootId) ?? row;
      batches.set(row.deleteBatch, {
        batch: row.deleteBatch,
        rootId: row.deleteRootId,
        title: root.title,
        deletedAt: root.deletedAt ?? row.deletedAt,
        count: rows.filter(
          candidate => candidate.deleteBatch === row.deleteBatch
        ).length,
        parentId: root.parentId,
        parentActive:
          root.parentId !== null && activeParents.has(root.parentId),
      });
    }
    return [...batches.values()];
  }),

  restore: protectedProcedure
    .input(z.object({ batch: id, toRoot: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const result = await restoreNoteBatch(
        ctx.user.id,
        input.batch,
        input.toRoot
      );
      for (const noteId of result.ids) changed(ctx.user.id, noteId, "restore");
      return result;
    }),

  versions: protectedProcedure
    .input(z.object({ id }))
    .query(async ({ ctx, input }) => {
      await ownNote(getDb(), ctx.user.id, input.id);
      const rows = await getDb()
        .select()
        .from(markdownNoteVersions)
        .where(
          and(
            eq(markdownNoteVersions.userId, ctx.user.id),
            eq(markdownNoteVersions.noteId, input.id)
          )
        )
        .orderBy(
          desc(markdownNoteVersions.createdAt),
          desc(markdownNoteVersions.id)
        )
        .limit(50);
      return rows.map(row => ({
        id: row.id,
        noteId: row.noteId,
        title: row.title,
        contentRevision: row.contentRevision,
        origin: row.origin,
        createdAt: row.createdAt,
        preview: noteDerived("", row.body)
          .bodyText.replace(/\s+/g, " ")
          .trim()
          .slice(0, 240),
      }));
    }),

  saveVersion: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      const version = await getDb().transaction(async tx => {
        const row = await ownNote(tx, ctx.user.id, input.id, true);
        return snapshotNote(tx, row, "manual");
      });
      changed(ctx.user.id, input.id, "version");
      return { id: version };
    }),

  deleteVersion: protectedProcedure
    .input(z.object({ id, versionId: id }))
    .mutation(async ({ ctx, input }) => {
      await ownNote(getDb(), ctx.user.id, input.id, true);
      const [deleted] = await getDb()
        .delete(markdownNoteVersions)
        .where(
          and(
            eq(markdownNoteVersions.id, input.versionId),
            eq(markdownNoteVersions.userId, ctx.user.id),
            eq(markdownNoteVersions.noteId, input.id)
          )
        )
        .returning({ id: markdownNoteVersions.id });
      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: t("server.notes.notFound"),
        });
      }
      changed(ctx.user.id, input.id, "version");
      return deleted;
    }),

  compactVersions: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      const result = await getDb().transaction(async tx => {
        await ownNote(tx, ctx.user.id, input.id, true);
        const [latest] = await tx
          .select({ id: markdownNoteVersions.id })
          .from(markdownNoteVersions)
          .where(
            and(
              eq(markdownNoteVersions.userId, ctx.user.id),
              eq(markdownNoteVersions.noteId, input.id)
            )
          )
          .orderBy(
            desc(markdownNoteVersions.createdAt),
            desc(markdownNoteVersions.id)
          )
          .limit(1);
        if (!latest) return { deleted: 0, remaining: 0 };
        const deleted = await tx
          .delete(markdownNoteVersions)
          .where(
            and(
              eq(markdownNoteVersions.userId, ctx.user.id),
              eq(markdownNoteVersions.noteId, input.id),
              sql`${markdownNoteVersions.id} <> ${latest.id}`
            )
          )
          .returning({ id: markdownNoteVersions.id });
        return { deleted: deleted.length, remaining: 1 };
      });
      if (result.deleted > 0) changed(ctx.user.id, input.id, "version");
      return result;
    }),

  restoreVersion: protectedProcedure
    .input(z.object({ id, versionId: id, expectedRevision: revision }))
    .mutation(async ({ ctx, input }): Promise<NoteUpdated | NoteConflict> => {
      const result = await getDb().transaction(
        async (tx): Promise<NoteUpdated | NoteConflict> => {
          const current = await ownNote(tx, ctx.user.id, input.id, true);
          const [version] = await tx
            .select()
            .from(markdownNoteVersions)
            .where(
              and(
                eq(markdownNoteVersions.id, input.versionId),
                eq(markdownNoteVersions.userId, ctx.user.id),
                eq(markdownNoteVersions.noteId, input.id)
              )
            );
          if (!version)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: t("server.notes.notFound"),
            });
          if (current.contentRevision !== input.expectedRevision)
            return { status: "conflict", current: noteDocument(current) };
          const derived = noteDerived(version.title, version.body);
          const [next] = await tx
            .update(markdownNotes)
            .set({
              title: version.title,
              body: version.body,
              bodyText: derived.bodyText,
              searchTitle: derived.searchTitle,
              searchText: derived.searchText,
              contentRevision: sql`${markdownNotes.contentRevision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(markdownNotes.id, input.id),
                eq(markdownNotes.userId, ctx.user.id),
                isNull(markdownNotes.deletedAt),
                eq(markdownNotes.contentRevision, input.expectedRevision)
              )
            )
            .returning();
          if (!next)
            return {
              status: "conflict",
              current: noteDocument(
                await ownNote(tx, ctx.user.id, input.id, true)
              ),
            };
          return { status: "updated", note: noteDocument(next) };
        }
      );
      if (result.status === "updated")
        changed(ctx.user.id, input.id, "content");
      return result;
    }),
});
