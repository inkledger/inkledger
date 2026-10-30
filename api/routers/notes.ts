import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  NOTE_BODY_MAX,
  NOTE_FILTERS,
  NOTE_SEARCH_MAX,
  NOTE_SEARCH_MIN,
  NOTE_TITLE_MAX,
  noteKind,
  type NoteChange,
  type NoteConflict,
  type NoteDocument,
  type NoteUpdated,
} from "@contracts/notes";
import { DIARY_MAX_DAYS, diaryInstructions, diaryMarkdown } from "@contracts/diary";
import { TIDY_MAX } from "@contracts/noteTidy";
import { currentLocale } from "@contracts/i18n/core";
import { markdownNoteVersions, markdownNotes, type MarkdownNote } from "@db/schema";
import { chat, ollamaRefusal, OllamaError } from "../ai/ollama";
import { diaryPrompt } from "../ai/prompts/diary";
import { noteTidyPrompt } from "../ai/prompts/noteTidy";
import { diaryFor, diaryText } from "../notes/diary";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { noteDerived, searchNotes } from "../queries/noteSearch";
import {
  convertNoteToFolder,
  createNote,
  deleteNote,
  moveNote,
  noteDocument,
  noteTreeItem,
  ownNote,
  renameNote,
  restoreNoteBatch,
  snapshotNote,
} from "../queries/notes";
import { publish } from "../lib/userEvents";
import { t } from "@contracts/i18n";

const id = z.uuid();
const title = z.string().max(NOTE_TITLE_MAX);
/** A name that says something: a folder's, or a title set from the tree. */
const name = z
  .string()
  .trim()
  .min(1, { error: () => t("server.notes.nameRequired") })
  .max(NOTE_TITLE_MAX);
const body = z.string().max(NOTE_BODY_MAX);
const issue = z.object({
  connectionId: z.number().int().positive(),
  issueKey: issueKeyInput,
});
const revision = z.number().int().positive();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const noteDateFilter = z.discriminatedUnion("field", [
  z.object({ field: z.literal("noted"), from: day.optional(), to: day.optional() }),
  z.object({ field: z.enum(["created", "updated"]), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }),
]);

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

const diaryInput = z
  .object({
    fromDay: day,
    toDay: day,
    /** The same period as instants, from the browser (its days): worklogs, plans and mails */
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    mode: z.enum(["summary", "timeline"]),
    folderId: id.nullable().optional(),
  })
  .refine(v => v.fromDay <= v.toDay && (Date.parse(v.toDay) - Date.parse(v.fromDay)) / 86_400_000 < DIARY_MAX_DAYS, { message: t("server.notes.summaryEmpty") });

/** What the model writes back: one Markdown document. */
const modelMarkdown = z.object({ markdown: z.string().trim().min(1).max(NOTE_BODY_MAX) });

/** A model's answer, its failures said in words (slow, unusable, unreachable). */
async function askModel<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (e) {
    if (!(e instanceof OllamaError)) throw e;
    if (e.kind === "slow") throw new TRPCError({ code: "TIMEOUT", message: t("server.ideas.llmSlow") });
    if (e.kind === "bad") throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.ideas.llmBad") });
    throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.ideas.llmUnreachable") });
  }
}

/** The AI copy beside the text, made from its revision now (the text itself untouched). */
async function setAiCopy(userId: number, row: MarkdownNote, markdown: string): Promise<NoteDocument> {
  const [next] = await getDb()
    .update(markdownNotes)
    .set({ aiBody: markdown, aiSourceRevision: row.contentRevision, aiCreatedAt: new Date() })
    .where(and(eq(markdownNotes.id, row.id), eq(markdownNotes.userId, userId)))
    .returning();
  changed(userId, row.id, "version");
  return noteDocument(next);
}

export const notesRouter = createRouter({
  tree: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select({
        id: markdownNotes.id,
        parentId: markdownNotes.parentId,
        kind: markdownNotes.kind,
        hasText: sql<boolean>`btrim(${markdownNotes.body}) <> ''`,
        position: markdownNotes.position,
        title: markdownNotes.title,
        contentRevision: markdownNotes.contentRevision,
        connectionId: markdownNotes.connectionId,
        issueKey: markdownNotes.issueKey,
        notedOn: markdownNotes.notedOn,
        hasAi: sql<boolean>`${markdownNotes.aiBody} IS NOT NULL`,
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
    return rows.map(row => ({ ...row, kind: noteKind(row.kind) }));
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
      z
        .object({
        query: z.string().trim().max(NOTE_SEARCH_MAX),
        // Bounds the browser read from `data:ieri`, `creata:7d`… (contracts/noteQuery.ts).
        dates: z.array(noteDateFilter).max(6).default([]),
        filter: z.enum(NOTE_FILTERS).default("all"),
        issue: issue.optional(),
        cursor: z.string().max(16_000).optional(),
        limit: z.number().int().min(1).max(50).default(30),
      })
        // Words to search, or only dates (the notes of those days).
        .refine(v => v.query.length >= NOTE_SEARCH_MIN || v.dates.length > 0, { message: t("server.notes.searchTooShort") })
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
          notedOn: day.optional(),
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

  /** A folder, at the root or in a folder (never in a note): it only groups. */
  createFolder: protectedProcedure
    .input(z.object({ title: name, parentId: id.nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      const row = await createNote(ctx.user.id, {
        title: input.title,
        body: "",
        parentId: input.parentId,
        issue: null,
        kind: "folder",
      });
      changed(ctx.user.id, row.id, "create");
      return noteTreeItem(row);
    }),

  /** A new title from the tree (a note's or a folder's), over the revision it was shown with. */
  rename: protectedProcedure
    .input(z.object({ id, title: name, expectedRevision: revision }))
    .mutation(async ({ ctx, input }): Promise<NoteUpdated | NoteConflict> => {
      const result = await renameNote(ctx.user.id, input.id, input.title, input.expectedRevision);
      if (result.status === "updated") changed(ctx.user.id, input.id, "content");
      return result;
    }),

  /**
   * The note's own day (a meeting's notes written the day after). Not its
   * content: no revision, so the open editor's next save never conflicts.
   */
  setDate: protectedProcedure
    .input(z.object({ id, notedOn: day }))
    .mutation(async ({ ctx, input }) => {
      const row = await ownNote(getDb(), ctx.user.id, input.id, true);
      if (row.kind !== "note") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.notes.folderText") });
      await getDb()
        .update(markdownNotes)
        .set({ notedOn: input.notedOn })
        .where(and(eq(markdownNotes.id, input.id), eq(markdownNotes.userId, ctx.user.id)));
      changed(ctx.user.id, input.id, "move");
      return { notedOn: input.notedOn };
    }),

  /** Whether the AI actions run here (a local model), or only "Copy for model". */
  llm: protectedProcedure.query(async () => ({ available: (await ollamaRefusal()) === null })),

  /** The diary of a period as one prompt for any model (Claude…): instructions, then the days. */
  diaryPrompt: protectedProcedure.input(diaryInput).mutation(async ({ ctx, input }) => {
    const days = await diaryFor(ctx.user.id, input);
    const markdown = diaryMarkdown(days, { noteChars: 20_000 });
    if (!markdown) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.notes.summaryEmpty") });
    return { prompt: `${diaryInstructions(input.mode, currentLocale(), input.fromDay, input.toDay)}\n\n---\n\n${markdown}\n` };
  }),

  /** "Summary" / "Timeline": the local model writes the period up; the page saves it as a note. */
  summarize: protectedProcedure.input(diaryInput).mutation(async ({ ctx, input, signal }) => {
    const days = await diaryFor(ctx.user.id, input);
    const { markdown, cut } = diaryText(days);
    if (!markdown) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.notes.summaryEmpty") });
    if ((await ollamaRefusal()) !== null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.ideas.llmOff") });
    const answer = await askModel(() =>
      chat(modelMarkdown, diaryPrompt(markdown, input.mode, currentLocale(), input.fromDay, input.toDay), {
        signal,
        numCtx: 12_288,
        numPredict: 3_000,
        timeoutMs: 240_000,
        simulated: { markdown: `## ${input.fromDay}\n\n- ${days.flatMap(d => d.notes.map(n => n.title)).join("\n- ")}` },
      })
    );
    const period = input.fromDay === input.toDay ? input.fromDay : `${input.fromDay} – ${input.toDay}`;
    return {
      title: t(input.mode === "summary" ? "server.notes.summaryTitle" : "server.notes.timelineTitle", { period }),
      markdown: answer.markdown,
      cut,
    };
  }),

  /** "Tidy up with AI": the model's copy goes beside the text (Original | AI), the text itself unchanged. */
  tidy: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input, signal }) => {
    const row = await ownNote(getDb(), ctx.user.id, input.id, true);
    if (row.kind !== "note" || !row.body.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.notes.tidyEmpty") });
    if (row.body.length > TIDY_MAX) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.notes.tidyTooLong", { count: TIDY_MAX }) });
    if ((await ollamaRefusal()) !== null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.ideas.llmOff") });
    const answer = await askModel(() =>
      chat(modelMarkdown, noteTidyPrompt(row.title, row.body, currentLocale()), {
        signal,
        numCtx: 16_384,
        numPredict: Math.ceil(row.body.length / 2.5) + 512,
        timeoutMs: 240_000,
        simulated: { markdown: `## ${row.title || "Note"}\n\n${row.body.trim()}` },
      })
    );
    return setAiCopy(ctx.user.id, row, answer.markdown);
  }),

  /** An AI copy made elsewhere ("Copy for model", then pasted back): the same Original | AI. */
  setAi: protectedProcedure.input(z.object({ id, markdown: body.min(1) })).mutation(async ({ ctx, input }) => {
    const row = await ownNote(getDb(), ctx.user.id, input.id, true);
    if (row.kind !== "note") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.notes.folderText") });
    return setAiCopy(ctx.user.id, row, input.markdown);
  }),

  /** The AI copy becomes the text; the original is kept as a version ("Original before AI"), so Undo restores it. */
  keepAi: protectedProcedure
    .input(z.object({ id, expectedRevision: revision }))
    .mutation(async ({ ctx, input }): Promise<(NoteUpdated & { versionId: string | null }) | NoteConflict> => {
      const result = await getDb().transaction(async (tx): Promise<(NoteUpdated & { versionId: string | null }) | NoteConflict> => {
        const current = await ownNote(tx, ctx.user.id, input.id, true);
        if (current.aiBody === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.notes.noAi") });
        if (current.contentRevision !== input.expectedRevision) return { status: "conflict", current: noteDocument(current) };
        const versionId = await snapshotNote(tx, current, "ai");
        const derived = noteDerived(current.title, current.aiBody);
        const [next] = await tx
          .update(markdownNotes)
          .set({
            body: current.aiBody,
            bodyText: derived.bodyText,
            searchTitle: derived.searchTitle,
            searchText: derived.searchText,
            contentRevision: sql`${markdownNotes.contentRevision} + 1`,
            aiBody: null,
            aiSourceRevision: null,
            aiCreatedAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(markdownNotes.id, input.id), eq(markdownNotes.userId, ctx.user.id), eq(markdownNotes.contentRevision, input.expectedRevision)))
          .returning();
        if (!next) return { status: "conflict", current: noteDocument(await ownNote(tx, ctx.user.id, input.id)) };
        return { status: "updated", note: noteDocument(next), versionId };
      });
      if (result.status === "updated") changed(ctx.user.id, input.id, "content");
      return result;
    }),

  /** The AI copy goes; the text stays as it is. */
  discardAi: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await ownNote(getDb(), ctx.user.id, input.id, true);
    const [next] = await getDb()
      .update(markdownNotes)
      .set({ aiBody: null, aiSourceRevision: null, aiCreatedAt: null })
      .where(and(eq(markdownNotes.id, input.id), eq(markdownNotes.userId, ctx.user.id)))
      .returning();
    changed(ctx.user.id, input.id, "version");
    return noteDocument(next);
  }),

  /** A note with no text that groups others becomes a folder. */
  convertToFolder: protectedProcedure
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      const row = await convertNoteToFolder(ctx.user.id, input.id);
      changed(ctx.user.id, input.id, "content");
      return row;
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
          if (current.kind === "folder" && input.body !== "")
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: t("server.notes.folderText"),
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
      if (input.issue) {
        const note = await ownNote(getDb(), ctx.user.id, input.id);
        if (note.kind === "folder")
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: t("server.notes.folderIssue"),
          });
      }
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
