import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, min, or, sql, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueNotes, issues, notifications, timers, todoSessions, todos, type Todo } from "@db/schema";
import { myRemoteIds } from "../providers/connections";
import { isClosed } from "@contracts/categories";
import { issueKeyInput } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { act, epochOf, heldElsewhere, pauseTimer, refuse, roundToMinute, elapsedSeconds, startTimerIn, whoOf } from "./timers";
import { beginSession, closeStaleSession, endSession, openSession } from "../queries/todoSessions";
import { addDays, dayKey, parseDayKey } from "@contracts/time";
import { MAX_STEP_TEXT, MAX_TODO_STEPS, TODO_REPEATS, nextOccurrence, parseSteps } from "@contracts/todo";
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
const priority = z.union([z.literal(0), z.literal(1)]);
/** Up to a working week of estimate. */
const estimate = z.number().int().min(60).max(7 * 24 * 3600);
const repeat = z.enum(TODO_REPEATS);
const steps = z
  .array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(MAX_STEP_TEXT), done: z.boolean() }))
  .max(MAX_TODO_STEPS);
/** What the user sets beside the text: all optional, the same on add, update and restore. */
const details = {
  priority: priority.optional(),
  estimateSeconds: estimate.nullable().optional(),
  steps: steps.optional(),
  repeat: repeat.nullable().optional(),
};
const detailsOf = (input: { priority?: 0 | 1; estimateSeconds?: number | null; steps?: z.infer<typeof steps>; repeat?: z.infer<typeof repeat> | null }) => ({
  ...(input.priority !== undefined ? { priority: input.priority } : {}),
  ...(input.estimateSeconds !== undefined ? { estimateSeconds: input.estimateSeconds } : {}),
  ...(input.steps !== undefined ? { steps: JSON.stringify(input.steps) } : {}),
  ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
});
/** Why an issue is suggested as a TODO. */
type SuggestionKind = "assigned" | "mention" | "review" | "comment" | "status" | "news" | "watched" | "doing";
/** The tracker's news that may become a TODO (the rest, a priority or a watch, is just news). */
const NOTICE_KINDS = ["assigned", "mentioned", "commented", "review", "changed"] as const;
const SUGGEST_DAYS = 7;
const MAX_SUGGESTIONS = 12;
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

/** Seconds worked on a TODO, its open stretch counted to now. */
const spentOf = sql<number>`coalesce((SELECT sum(coalesce(s.ended_at, (extract(epoch from now()) * 1000)::bigint) - s.started_at) / 1000 FROM ${todoSessions} s WHERE s.todo_id = ${todos.id}), 0)`.mapWith(
  (v: unknown) => Math.round(Number(v)),
);

/** A TODO as the lists show it: with its issue (title, status), its note's text when it has them, and its time. */
async function rows(where: SQL | undefined, order: SQL[], limit?: number) {
  const q = getDb()
    .select({
      todo: todos,
      summary: issues.summary,
      status: issues.status,
      statusCategory: issues.statusCategory,
      noteBody: issueNotes.body,
      spentSeconds: spentOf,
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
    spentSeconds: r.spentSeconds,
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
        ...details,
        /** A suggestion taken (its key): never suggested again. */
        source: z.string().min(1).max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const link = await linkOf(ctx.user.id, input);
      if (input.source) {
        const [taken] = await getDb().select().from(todos).where(and(eq(todos.userId, ctx.user.id), eq(todos.source, input.source)));
        if (taken) return taken;
      }
      const [row] = await getDb()
        .insert(todos)
        .values({ userId: ctx.user.id, text: input.text, dueOn: input.dueOn ?? null, position: await firstPosition(ctx.user.id), ...link, ...detailsOf(input), source: input.source ?? null })
        .returning();
      return row;
    }),

  /**
   * Rewrite, plan (null: someday), tick or untick, tie to another issue (null:
   * to none), set its details. Ticking a repeating TODO brings the next one
   * (`today` says from when); unticking it takes that one back while untouched.
   * Two ticks at once bring one: only the tick that finds it open does.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: idInput,
        text: text.optional(),
        dueOn: day.nullable().optional(),
        done: z.boolean().optional(),
        today: day.optional(),
        issueKey: issueKeyInput.nullable().optional(),
        connectionId: connectionInput,
        ...details,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await own(ctx.user.id, input.id);
      // Another issue (or none): what hung on the old one (its comment, its note) lets go.
      const relink = input.issueKey !== undefined ? await linkOf(ctx.user.id, { issueKey: input.issueKey, connectionId: input.connectionId }) : null;
      return getDb().transaction(async (tx) => {
        const set = {
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.dueOn !== undefined ? { dueOn: input.dueOn, reminderSeenOn: null } : {}),
          ...(relink ?? {}),
          ...detailsOf(input),
          updatedAt: new Date(),
        };
        const [next] = await tx.update(todos).set(set).where(eq(todos.id, row.id)).returning();
        if (input.done === undefined || !next) return next;
        if (!input.done) {
          const [reopened] = await tx.update(todos).set({ doneAt: null }).where(eq(todos.id, row.id)).returning();
          // The one its tick brought, while still open: away again.
          await tx.delete(todos).where(and(eq(todos.repeatOf, row.id), open));
          return reopened;
        }
        const [ticked] = await tx
          .update(todos)
          .set({ doneAt: new Date() })
          .where(and(eq(todos.id, row.id), open))
          .returning();
        if (!ticked) return next;
        // Done: no more time on it (its issue's timer, if any, is the page's to stop and log).
        const working = await openSession(tx, ctx.user.id);
        if (working?.todoId === ticked.id) await endSession(tx, ctx.user.id, new Date());
        const again = repeat.safeParse(ticked.repeat);
        if (again.success) {
          const today = input.today ?? dayKey(new Date());
          await tx.insert(todos).values({
            userId: ticked.userId,
            text: ticked.text,
            dueOn: nextOccurrence(ticked.dueOn, today, again.data),
            position: ticked.position,
            connectionId: ticked.connectionId,
            issueKey: ticked.issueKey,
            commentId: ticked.commentId,
            commentExcerpt: ticked.commentExcerpt,
            issueNoteId: ticked.issueNoteId,
            priority: ticked.priority,
            estimateSeconds: ticked.estimateSeconds,
            // Its checklist starts again, unticked.
            steps: JSON.stringify(parseSteps(ticked.steps).map((s) => ({ ...s, done: false }))),
            repeat: ticked.repeat,
            repeatOf: ticked.id,
          });
        }
        return ticked;
      });
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
        // Its details as "remove" gave them back (stored form), checked again.
        priority: z.number().int().optional(),
        estimateSeconds: estimate.nullable().optional(),
        steps: z.string().max(20_000).optional(),
        repeat: z.string().nullable().optional(),
        source: z.string().max(300).nullable().optional(),
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
        .values({
          userId: ctx.user.id,
          text: input.text,
          dueOn: input.dueOn,
          doneAt: input.done ? new Date() : null,
          position: input.position,
          ...(link as Link),
          priority: input.priority === 1 ? 1 : 0,
          estimateSeconds: input.estimateSeconds ?? null,
          steps: JSON.stringify(parseSteps(input.steps)),
          repeat: repeat.safeParse(input.repeat).data ?? null,
          source: input.source ?? null,
        })
        .returning();
      return row;
    }),

  /**
   * What the user works on now: the open stretch (its TODO, whether its
   * issue's timer runs with it, since when), or null. A stretch with no timer
   * forgotten from an earlier day is ended first.
   */
  working: protectedProcedure.query(async ({ ctx }) => {
    await closeStaleSession(getDb(), ctx.user.id, new Date());
    const s = await openSession(getDb(), ctx.user.id);
    if (!s) return null;
    const [todo] = s.todoId === null ? [] : await getDb().select().from(todos).where(eq(todos.id, s.todoId));
    return {
      todoId: s.todoId,
      text: todo?.text ?? s.label,
      linked: s.linked === 1,
      startedAt: s.startedAt,
      issueKey: todo?.issueKey ?? null,
      connectionId: todo?.connectionId ?? null,
      serverNow: new Date(),
    };
  }),

  /**
   * Work on a TODO now. Tied to an issue: its timer starts (the real time)
   * and the TODO's time runs beside it. Not tied: only the TODO's time runs,
   * never a worklog, and the running issue timer pauses (its time goes to the
   * log as on any switch: `switchedFrom`). One focus at a time.
   */
  startWork: protectedProcedure
    .input(z.object({ id: idInput, force: z.boolean().optional(), opId: z.string().min(8).max(64).optional(), device: z.string().max(60).optional() }))
    .mutation(async ({ ctx, input }) => {
      const row = await own(ctx.user.id, input.id);
      if (row.doneAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.todos.workDone") });
      const now = new Date();
      const w = whoOf(ctx, input.device);
      const issueKey = row.issueKey;
      if (issueKey !== null && row.connectionId !== null) {
        const connectionId = row.connectionId;
        return act(ctx.user.id, input.opId, async (tx) => {
          const r = await startTimerIn(tx, w, ctx.user.id, connectionId, issueKey, { force: input.force, from: null }, now);
          await beginSession(tx, ctx.user.id, row, true, now);
          return { ...r, linked: true };
        });
      }
      return act(ctx.user.id, input.opId, async (tx) => {
        const running = await tx.select().from(timers).where(and(eq(timers.userId, ctx.user.id), eq(timers.state, "running")));
        for (const r of running) if (heldElsewhere(r, w, now) && !input.force) refuse("held", r);
        let switchedFrom: { issueKey: string; connectionId: number; seconds: number; note: string; stoppedAt: Date } | null = null;
        for (const o of running) {
          switchedFrom = { issueKey: o.issueKey, connectionId: o.connectionId, seconds: roundToMinute(elapsedSeconds(o, now)), note: o.note, stoppedAt: now };
          await pauseTimer(tx, o, now);
        }
        await beginSession(tx, ctx.user.id, row, false, now);
        return { ok: true, switchedFrom, tookOver: false, linked: false, epoch: await epochOf(tx, ctx.user.id) };
      });
    }),

  /**
   * The stretches of TODO time in a period (the open one up to now), for the
   * charts: drawn beside the logged time, never added to it.
   */
  sessions: protectedProcedure
    .input(z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }))
    .query(async ({ ctx, input }) => {
      const from = new Date(input.from);
      const to = new Date(input.to);
      const rows = await getDb()
        .select({ startedAt: todoSessions.startedAt, endedAt: todoSessions.endedAt, linked: todoSessions.linked, label: todoSessions.label })
        .from(todoSessions)
        .where(
          and(
            eq(todoSessions.userId, ctx.user.id),
            lt(todoSessions.startedAt, to),
            or(isNull(todoSessions.endedAt), gt(todoSessions.endedAt, from)),
          ),
        )
        .orderBy(asc(todoSessions.startedAt));
      const now = new Date();
      return rows.map((r) => ({ start: r.startedAt, end: r.endedAt ?? now, linked: r.linked === 1, label: r.label, open: r.endedAt === null }));
    }),

  /** Stop working on a TODO with no timer (a linked one stops with its issue's timer). */
  stopWork: protectedProcedure.mutation(async ({ ctx }) =>
    act(ctx.user.id, undefined, async (tx) => {
      await endSession(tx, ctx.user.id, new Date(), false);
      return { ok: true, epoch: await epochOf(tx, ctx.user.id) };
    }),
  ),

  /**
   * What could become a TODO, from what the catalogue knows (Jira has no inbox
   * of its own): issues just assigned to me, my issues and watched ones with
   * news by someone else (a status change, a comment, an update), the
   * tracker's own inbox where there is one (mentions, comments, reviews), and
   * my issues in progress. Never one already taken (its source) or with an
   * open TODO. The newest first, at most `MAX_SUGGESTIONS`.
   */
  suggestions: protectedProcedure.input(z.object({ today: day })).query(async ({ ctx, input }) => {
    const db = getDb();
    const me = await myRemoteIds(ctx.user.id);
    const since = addDays(parseDayKey(input.today) ?? new Date(), -SUGGEST_DAYS);
    const taken = new Set(
      (await db.select({ source: todos.source }).from(todos).where(and(eq(todos.userId, ctx.user.id), isNotNull(todos.source)))).map((r) => r.source),
    );
    const busy = new Set(
      (await db.select({ c: todos.connectionId, k: todos.issueKey }).from(todos).where(and(eq(todos.userId, ctx.user.id), open, isNotNull(todos.issueKey)))).map(
        (r) => `${r.c}:${r.k}`,
      ),
    );
    type Suggestion = { source: string; kind: SuggestionKind; issueKey: string; connectionId: number; summary: string; status: string; at: Date };
    const out = new Map<string, Suggestion>();
    const offer = (s: Suggestion) => {
      const issue = `${s.connectionId}:${s.issueKey}`;
      if (taken.has(s.source) || busy.has(issue)) return;
      // One per issue: the newest reason.
      const known = out.get(issue);
      if (!known || known.at < s.at) out.set(issue, s);
    };
    const visible = and(eq(issues.userId, ctx.user.id), eq(issues.hidden, 0), isNull(issues.goneAt));
    // The tracker's own news (an inbox, or what the sync saw: assigned to me).
    const notes = await db
      .select({ n: notifications, summary: issues.summary, status: issues.status, category: issues.category })
      .from(notifications)
      .innerJoin(issues, and(eq(issues.userId, notifications.userId), eq(issues.connectionId, notifications.connectionId), eq(issues.key, notifications.issueKey)))
      .where(and(eq(notifications.userId, ctx.user.id), isNull(notifications.dismissedAt), gte(notifications.createdAt, since), inArray(notifications.kind, [...NOTICE_KINDS]), visible))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    for (const { n, summary, status, category } of notes) {
      if (isClosed(category)) continue;
      const kind: SuggestionKind =
        n.kind === "assigned" ? "assigned" : n.kind === "mentioned" ? "mention" : n.kind === "review" ? "review" : n.kind === "commented" ? "comment" : "news";
      offer({ source: `n:${n.dedupe}`, kind, issueKey: n.issueKey, connectionId: n.connectionId, summary, status, at: n.createdAt });
    }
    // Mine or watched, with news by someone else since I last looked.
    if (me.length > 0) {
      const news = await db
        .select()
        .from(issues)
        .where(
          and(
            visible,
            or(inArray(issues.assigneeId, me), eq(issues.watching, 1)),
            isNotNull(issues.othersActivityAt),
            gte(issues.othersActivityAt, since.getTime()),
            or(isNull(issues.seenAt), sql`${issues.othersActivityAt} > ${issues.seenAt}`),
          ),
        )
        .orderBy(desc(issues.othersActivityAt))
        .limit(50);
      for (const i of news) {
        if (isClosed(i.category) || i.othersActivityAt === null) continue;
        const kind: SuggestionKind =
          i.statusChangedAt === i.othersActivityAt ? "status" : i.lastCommentAt === i.othersActivityAt ? "comment" : me.includes(i.assigneeId) ? "news" : "watched";
        offer({ source: `u:${i.connectionId}:${i.key}:${i.othersActivityAt}`, kind, issueKey: i.key, connectionId: i.connectionId, summary: i.summary, status: i.status, at: new Date(i.othersActivityAt) });
      }
      // In progress and mine, with no TODO yet: today's work.
      const doing = await db
        .select()
        .from(issues)
        .where(and(visible, inArray(issues.assigneeId, me), eq(issues.category, "doing")))
        .orderBy(sql`${issues.activityAt} DESC NULLS LAST`)
        .limit(20);
      for (const i of doing)
        offer({ source: `d:${i.connectionId}:${i.key}:${input.today}`, kind: "doing", issueKey: i.key, connectionId: i.connectionId, summary: i.summary, status: i.status, at: new Date(i.activityAt ?? 0) });
    }
    // News first (newest first), then what is in progress.
    return [...out.values()]
      .sort((a, b) => Number(a.kind === "doing") - Number(b.kind === "doing") || b.at.getTime() - a.at.getTime())
      .slice(0, MAX_SUGGESTIONS);
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

export type TodoRow = Todo & { summary: string | null; status: string | null; statusCategory: string | null; noteBody: string | null; spentSeconds: number };
