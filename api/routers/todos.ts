import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, min, or, sql, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueNotes, issues, todos, type Todo } from "@db/schema";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { addDays, dayKey, parseDayKey } from "@contracts/time";
import { t } from "@contracts/i18n";

/**
 * The user's TODO list. "Today" is the user's day as their device says it
 * (a "YYYY-MM-DD" sent with each read), so a TODO planned for a day is due on
 * that day wherever the server runs.
 */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = parseDayKey(v);
    return d !== null && dayKey(d) === v;
  }, { error: () => t("server.todos.badDay") });
const text = z.string().trim().min(1, { error: () => t("server.todos.empty") }).max(500);
const idInput = z.number().int().positive();
const connectionInput = z.number().int().positive().optional();
const excerpt = z.string().trim().max(280);
/** How long done TODOs stay in "Done". */
const DONE_DAYS = 14;
const DONE_MAX = 200;

async function own(userId: number, id: number) {
  const [row] = await getDb()
    .select()
    .from(todos)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.todos.notFound") });
  return row;
}

/** A private note of the user, or NOT_FOUND. */
async function ownNote(userId: number, id: number) {
  const [row] = await getDb()
    .select()
    .from(issueNotes)
    .where(and(eq(issueNotes.id, id), eq(issueNotes.userId, userId)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issueNotes.notFound") });
  return row;
}

type Link = { connectionId: number | null; issueKey: string | null; commentId: string | null; commentExcerpt: string | null; issueNoteId: number | null };

/**
 * What a TODO hangs on, checked: an issue of the user (its connection
 * resolved), a comment on it, or a private note (whose issue it takes).
 */
async function linkOf(
  userId: number,
  input: { issueKey?: string | null; connectionId?: number; commentId?: string; commentExcerpt?: string; issueNoteId?: number },
): Promise<Link> {
  if (input.issueNoteId !== undefined) {
    const n = await ownNote(userId, input.issueNoteId);
    if (input.issueKey && (input.issueKey !== n.issueKey || (input.connectionId !== undefined && input.connectionId !== n.connectionId))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: t("server.todos.noteElsewhere") });
    }
    return { connectionId: n.connectionId, issueKey: n.issueKey, commentId: null, commentExcerpt: null, issueNoteId: n.id };
  }
  if (input.commentId !== undefined && !input.issueKey) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.todos.commentNeedsIssue") });
  if (!input.issueKey) return { connectionId: null, issueKey: null, commentId: null, commentExcerpt: null, issueNoteId: null };
  const conn = await issueConnection(userId, input.issueKey, input.connectionId);
  return {
    connectionId: conn.id,
    issueKey: input.issueKey,
    commentId: input.commentId ?? null,
    commentExcerpt: input.commentId !== undefined ? (input.commentExcerpt ?? "").slice(0, 280) || null : null,
    issueNoteId: null,
  };
}

const open = isNull(todos.doneAt);

/** A TODO as the lists show it: with its issue (title, status) and its note's text when it has them. */
async function rows(where: SQL | undefined, order: SQL[], limit?: number) {
  const q = getDb()
    .select({
      todo: todos,
      summary: issues.summary,
      status: issues.status,
      statusCategory: issues.statusCategory,
      noteBody: issueNotes.body,
    })
    .from(todos)
    .leftJoin(issues, eq(issues.id, todos.itemId))
    .leftJoin(issueNotes, eq(issueNotes.id, todos.issueNoteId))
    .where(where)
    .orderBy(...order);
  const list = await (limit ? q.limit(limit) : q);
  return list.map((r) => ({
    ...r.todo,
    summary: r.summary ?? null,
    status: r.status ?? null,
    statusCategory: r.statusCategory ?? null,
    noteBody: r.noteBody ?? null,
  }));
}

/** Smallest position minus one: a new TODO goes first. */
async function firstPosition(userId: number) {
  const [r] = await getDb().select({ p: min(todos.position) }).from(todos).where(eq(todos.userId, userId));
  return (r?.p ?? 1) - 1;
}

export const todosRouter = createRouter({
  /**
   * A view of the list: today (due today or late, the late first), upcoming
   * (planned after today, by day), someday (no day), done (the last two weeks).
   */
  list: protectedProcedure
    .input(z.object({ view: z.enum(["today", "upcoming", "someday", "done"]), today: day }))
    .query(async ({ ctx, input }) => {
      const mine = eq(todos.userId, ctx.user.id);
      switch (input.view) {
        case "today":
          return rows(and(mine, open, isNotNull(todos.dueOn), lte(todos.dueOn, input.today)), [asc(todos.dueOn), asc(todos.position), asc(todos.id)]);
        case "upcoming":
          return rows(and(mine, open, gt(todos.dueOn, input.today)), [asc(todos.dueOn), asc(todos.position), asc(todos.id)]);
        case "someday":
          return rows(and(mine, open, isNull(todos.dueOn)), [asc(todos.position), asc(todos.id)]);
        case "done": {
          // A valid day (checked by its input).
          const since = addDays(parseDayKey(input.today) ?? new Date(), -DONE_DAYS);
          return rows(and(mine, isNotNull(todos.doneAt), gte(todos.doneAt, since)), [desc(todos.doneAt), desc(todos.id)], DONE_MAX);
        }
      }
    }),

  /** How many in each view, and how many of today's are late. */
  counts: protectedProcedure.input(z.object({ today: day })).query(async ({ ctx, input }) => {
    const [r] = await getDb()
      .select({
        today: sql<number>`count(*) FILTER (WHERE ${todos.dueOn} <= ${input.today})`.mapWith(Number),
        late: sql<number>`count(*) FILTER (WHERE ${todos.dueOn} < ${input.today})`.mapWith(Number),
        upcoming: sql<number>`count(*) FILTER (WHERE ${todos.dueOn} > ${input.today})`.mapWith(Number),
        someday: sql<number>`count(*) FILTER (WHERE ${todos.dueOn} IS NULL)`.mapWith(Number),
      })
      .from(todos)
      .where(and(eq(todos.userId, ctx.user.id), open));
    return r ?? { today: 0, late: 0, upcoming: 0, someday: 0 };
  }),

  /** The open TODOs of an issue (its page, the badges on its comments and notes). */
  forIssue: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: connectionInput })).query(async ({ ctx, input }) => {
    const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
    return rows(and(eq(todos.userId, ctx.user.id), open, eq(todos.connectionId, conn.id), eq(todos.issueKey, input.issueKey)), [
      sql`${todos.dueOn} ASC NULLS LAST`,
      asc(todos.position),
      asc(todos.id),
    ]);
  }),

  add: protectedProcedure
    .input(
      z.object({
        text,
        dueOn: day.nullish(),
        issueKey: issueKeyInput.optional(),
        connectionId: connectionInput,
        commentId: z.string().trim().min(1).max(200).optional(),
        commentExcerpt: excerpt.optional(),
        issueNoteId: idInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const link = await linkOf(ctx.user.id, input);
      const [row] = await getDb()
        .insert(todos)
        .values({ userId: ctx.user.id, text: input.text, dueOn: input.dueOn ?? null, position: await firstPosition(ctx.user.id), ...link })
        .returning();
      return row;
    }),

  /** Rewrite, plan (null: someday), tick or untick, tie to another issue (null: to none). */
  update: protectedProcedure
    .input(
      z.object({
        id: idInput,
        text: text.optional(),
        dueOn: day.nullable().optional(),
        done: z.boolean().optional(),
        issueKey: issueKeyInput.nullable().optional(),
        connectionId: connectionInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await own(ctx.user.id, input.id);
      // Another issue (or none): what hung on the old one (its comment, its note) lets go.
      const relink = input.issueKey !== undefined ? await linkOf(ctx.user.id, { issueKey: input.issueKey, connectionId: input.connectionId }) : null;
      const [next] = await getDb()
        .update(todos)
        .set({
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.dueOn !== undefined ? { dueOn: input.dueOn, reminderSeenOn: null } : {}),
          ...(input.done !== undefined ? { doneAt: input.done ? (row.doneAt ?? new Date()) : null } : {}),
          ...(relink ?? {}),
          updatedAt: new Date(),
        })
        .where(eq(todos.id, row.id))
        .returning();
      return next;
    }),

  /** The order by hand: these TODOs, in this order (the others keep theirs). */
  reorder: protectedProcedure.input(z.object({ ids: z.array(idInput).min(1).max(500) })).mutation(async ({ ctx, input }) => {
    const ids = [...new Set(input.ids)];
    await getDb().transaction(async (tx) => {
      const found = await tx
        .select({ id: todos.id, position: todos.position })
        .from(todos)
        .where(and(eq(todos.userId, ctx.user.id), inArray(todos.id, ids)));
      if (found.length !== ids.length) throw new TRPCError({ code: "NOT_FOUND", message: t("server.todos.notFound") });
      // From the smallest of their places, one each in the new order (two that shared a place no longer do).
      const from = Math.min(...found.map((f) => f.position));
      for (const [i, id] of ids.entries()) await tx.update(todos).set({ position: from + i }).where(eq(todos.id, id));
    });
    return { ok: true };
  }),

  /** Delete. Returns the TODO so "Undo" can put it back as it was. */
  remove: protectedProcedure.input(z.object({ id: idInput })).mutation(async ({ ctx, input }) => {
    const row = await own(ctx.user.id, input.id);
    await getDb().delete(todos).where(eq(todos.id, row.id));
    return row;
  }),

  /**
   * Put back a TODO deleted by mistake. Its links are checked again: a note
   * deleted since leaves it on its issue, an issue no longer reachable leaves
   * it on none; the TODO itself is never lost.
   */
  restore: protectedProcedure
    .input(
      z.object({
        text,
        dueOn: day.nullable(),
        done: z.boolean(),
        position: z.number().int(),
        issueKey: issueKeyInput.nullable(),
        connectionId: z.number().int().positive().nullable(),
        commentId: z.string().trim().min(1).max(200).nullable(),
        commentExcerpt: excerpt.nullable(),
        issueNoteId: idInput.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tries = [
        { issueKey: input.issueKey, connectionId: input.connectionId ?? undefined, commentId: input.commentId ?? undefined, commentExcerpt: input.commentExcerpt ?? undefined, issueNoteId: input.issueNoteId ?? undefined },
        { issueKey: input.issueKey, connectionId: input.connectionId ?? undefined, commentId: input.commentId ?? undefined, commentExcerpt: input.commentExcerpt ?? undefined },
        {},
      ];
      let link: Link | null = null;
      for (const tryLink of tries) {
        try {
          link = await linkOf(ctx.user.id, tryLink);
          break;
        } catch (e) {
          if (!(e instanceof TRPCError) || (e.code !== "NOT_FOUND" && e.code !== "PRECONDITION_FAILED" && e.code !== "CONFLICT")) throw e;
        }
      }
      const [row] = await getDb()
        .insert(todos)
        .values({ userId: ctx.user.id, text: input.text, dueOn: input.dueOn, doneAt: input.done ? new Date() : null, position: input.position, ...(link as Link) })
        .returning();
      return row;
    }),

  /** Today's reminders: open TODOs due today or late, not put away today. */
  reminders: protectedProcedure.input(z.object({ today: day })).query(async ({ ctx, input }) =>
    rows(
      and(
        eq(todos.userId, ctx.user.id),
        open,
        lte(todos.dueOn, input.today),
        or(isNull(todos.reminderSeenOn), sql`${todos.reminderSeenOn} <> ${input.today}`),
      ),
      [asc(todos.dueOn), asc(todos.position), asc(todos.id)],
    ),
  ),

  /** Put a reminder away until tomorrow (it comes back while the TODO stays open and late). */
  dismissReminder: protectedProcedure.input(z.object({ id: idInput, today: day })).mutation(async ({ ctx, input }) => {
    const row = await own(ctx.user.id, input.id);
    await getDb().update(todos).set({ reminderSeenOn: input.today }).where(eq(todos.id, row.id));
    return { ok: true };
  }),
});

export type TodoRow = Todo & { summary: string | null; status: string | null; statusCategory: string | null; noteBody: string | null };
