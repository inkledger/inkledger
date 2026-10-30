// Ideas in triage (docs/work/ideas/triage.md): captured raw, refined until
// ready, then an issue, an agent's prompt or a mail. Per user; deleted ones wait
// 30 days in the trash.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { connections, containers, ideas } from "@db/schema";
import { t } from "@contracts/i18n";
import { canMove, CAPTURE_MAX, IDEA_ROUTES, IDEA_STATES, splitIdeas, type Criterion, type IdeaRoute, type IdeaState, type Question } from "@contracts/ideas";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";

/** How long a deleted idea can be brought back */
const TRASH_DAYS = 30;

const id = z.number().int().positive();
const title = z.string().trim().min(1, { error: () => t("server.ideas.empty") }).max(200);
const body = z.string().max(20_000);
const state = z.enum(IDEA_STATES);
const route = z.enum(["me", "agent", "ask"]);
const acceptance = z.array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(500) })).max(20);
const questions = z
  .array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(500), answer: z.string().trim().max(2000), blocking: z.boolean() }))
  .max(20);
const labels = z.array(z.string().trim().min(1).max(60)).max(20);
const estimate = z.number().int().min(60).max(30 * 24 * 3600);

type IdeaRecord = typeof ideas.$inferSelect;

/** A stored JSON list read through its input schema: anything else is an empty list. */
function parsed<T>(schema: z.ZodType<T[]>, text: string): T[] {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : [];
  } catch {
    return [];
  }
}

const isState = (s: string): s is IdeaState => (IDEA_STATES as readonly string[]).includes(s);
const isRoute = (r: string | null): r is IdeaRoute => r !== null && (IDEA_ROUTES as readonly string[]).includes(r);

/** An idea as the page shows it: its lists parsed, its project named. */
function rowOf(i: IdeaRecord, container: { id: number; key: string; name: string } | null) {
  return {
    ...i,
    state: isState(i.state) ? i.state : "raw",
    route: isRoute(i.route) ? i.route : null,
    acceptance: parsed<Criterion>(acceptance, i.acceptance),
    questions: parsed<Question>(questions, i.questions),
    labels: parsed<string>(labels, i.labels),
    container,
    source: i.sourceIssueKey !== null && i.sourceConnectionId !== null ? { key: i.sourceIssueKey, connectionId: i.sourceConnectionId } : null,
    promoted: i.promotedIssueKey !== null && i.promotedConnectionId !== null ? { key: i.promotedIssueKey, connectionId: i.promotedConnectionId } : null,
  };
}
export type IdeaRow = ReturnType<typeof rowOf>;

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: t("server.ideas.notFound") });

/** The user's own ideas with their projects, in board order: by state, then position. */
async function rowsOf(userId: number, where: ReturnType<typeof and>) {
  const rows = await getDb()
    .select({ idea: ideas, container: { id: containers.id, key: containers.key, name: containers.name } })
    .from(ideas)
    .leftJoin(containers, eq(containers.id, ideas.containerId))
    .where(and(eq(ideas.userId, userId), where))
    .orderBy(sql`array_position(ARRAY['raw','refining','ready','promoted','discarded'], ${ideas.state})`, asc(ideas.position), asc(ideas.id));
  return rows.map((r) => rowOf(r.idea, r.container));
}

/** One of the user's ideas (a deleted one only when asked), else NOT_FOUND. */
async function ownIdea(userId: number, ideaId: number, deleted = false): Promise<IdeaRow> {
  const [row] = await rowsOf(userId, and(eq(ideas.id, ideaId), deleted ? isNotNull(ideas.deletedAt) : isNull(ideas.deletedAt)));
  if (!row) throw notFound();
  return row;
}

/** A project of one of the user's connections still in use (R-2.9), else NOT_FOUND. */
async function ownContainer(userId: number, containerId: number): Promise<void> {
  const [found] = await getDb()
    .select({ id: containers.id })
    .from(containers)
    .innerJoin(connections, eq(connections.id, containers.connectionId))
    .where(and(eq(containers.id, containerId), eq(connections.userId, userId), isNull(connections.archivedAt)))
    .limit(1);
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: t("server.ideas.noContainer") });
}

/** Deleted ideas older than 30 days are gone for good (R-2.7). */
export async function purgeIdeas(now: number = Date.now()): Promise<number> {
  const gone = await getDb()
    .delete(ideas)
    .where(lt(ideas.deletedAt, new Date(now - TRASH_DAYS * 86_400_000)))
    .returning({ id: ideas.id });
  return gone.length;
}

export const ideasRouter = createRouter({
  list: protectedProcedure
    .input(z.object({ containerId: z.union([id, z.literal("none")]).optional(), states: z.array(state).max(5).optional() }))
    .query(({ ctx, input }) =>
      rowsOf(
        ctx.user.id,
        and(
          isNull(ideas.deletedAt),
          input.containerId === "none" ? isNull(ideas.containerId) : input.containerId !== undefined ? eq(ideas.containerId, input.containerId) : undefined,
          input.states ? inArray(ideas.state, input.states) : undefined,
        ),
      ),
    ),

  counts: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb()
      .select({ state: ideas.state, n: sql<number>`count(*)::int` })
      .from(ideas)
      .where(and(eq(ideas.userId, ctx.user.id), isNull(ideas.deletedAt)))
      .groupBy(ideas.state);
    return Object.fromEntries(IDEA_STATES.map((s) => [s, rows.find((r) => r.state === s)?.n ?? 0])) as Record<IdeaState, number>;
  }),

  get: protectedProcedure.input(z.object({ id })).query(({ ctx, input }) => ownIdea(ctx.user.id, input.id)),

  /** The projects an idea can be filed under: those of the user's connections in use (R-2.9). */
  projects: protectedProcedure.query(({ ctx }) =>
    getDb()
      .select({ id: containers.id, key: containers.key, name: containers.name })
      .from(containers)
      .innerJoin(connections, eq(connections.id, containers.connectionId))
      .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
      .orderBy(asc(containers.key))
      .limit(500),
  ),

  /** One idea per line, at the top of Raw, in the order written (R-2.2). */
  capture: protectedProcedure.input(z.object({ text: z.string().max(20_000), containerId: id.optional() })).mutation(async ({ ctx, input }) => {
    const found = splitIdeas(input.text);
    if (found.length > CAPTURE_MAX) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.ideas.tooMany") });
    if (found.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.ideas.empty") });
    if (input.containerId !== undefined) await ownContainer(ctx.user.id, input.containerId);
    const made = await getDb().transaction(async (tx) => {
      await tx
        .update(ideas)
        .set({ position: sql`${ideas.position} + ${found.length}` })
        .where(and(eq(ideas.userId, ctx.user.id), eq(ideas.state, "raw"), isNull(ideas.deletedAt)));
      return tx
        .insert(ideas)
        .values(found.map((f, n) => ({ userId: ctx.user.id, title: f.title, body: f.body, state: "raw", position: n, containerId: input.containerId ?? null })))
        .returning({ id: ideas.id });
    });
    return rowsOf(ctx.user.id, inArray(ideas.id, made.map((m) => m.id)));
  }),

  update: protectedProcedure
    .input(
      z.object({
        id,
        title: title.optional(),
        body: body.optional(),
        route: route.nullable().optional(),
        containerId: id.nullable().optional(),
        acceptance: acceptance.optional(),
        questions: questions.optional(),
        labels: labels.optional(),
        estimateSeconds: estimate.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ownIdea(ctx.user.id, input.id);
      if (input.containerId != null) await ownContainer(ctx.user.id, input.containerId);
      await getDb()
        .update(ideas)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.route !== undefined ? { route: input.route } : {}),
          ...(input.containerId !== undefined ? { containerId: input.containerId } : {}),
          ...(input.acceptance !== undefined ? { acceptance: JSON.stringify(input.acceptance) } : {}),
          ...(input.questions !== undefined ? { questions: JSON.stringify(input.questions) } : {}),
          ...(input.labels !== undefined ? { labels: JSON.stringify(input.labels) } : {}),
          ...(input.estimateSeconds !== undefined ? { estimateSeconds: input.estimateSeconds } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(ideas.id, input.id), eq(ideas.userId, ctx.user.id)));
      return ownIdea(ctx.user.id, input.id);
    }),

  /** To another state (or another place in its own), as the table allows (R-2.1, R-2.3). */
  move: protectedProcedure
    .input(z.object({ id, state, index: z.number().int().min(0).max(5000), reason: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const idea = await ownIdea(ctx.user.id, input.id);
      const ok = canMove(idea, input.state);
      if (!ok.ok) throw new TRPCError({ code: "BAD_REQUEST", message: t(`server.ideas.move.${ok.reason}`) });
      await getDb().transaction(async (tx) => {
        await tx
          .update(ideas)
          .set({ position: sql`${ideas.position} + 1` })
          .where(and(eq(ideas.userId, ctx.user.id), eq(ideas.state, input.state), isNull(ideas.deletedAt), gte(ideas.position, input.index)));
        await tx
          .update(ideas)
          .set({
            state: input.state,
            position: input.index,
            ...(input.state === "discarded" ? { discardedReason: input.reason ?? null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(ideas.id, input.id));
      });
      return ownIdea(ctx.user.id, input.id);
    }),

  /** A state's ideas in this order (ids not the user's, or elsewhere, are left alone). */
  reorder: protectedProcedure.input(z.object({ state, ids: z.array(id).max(2000) })).mutation(async ({ ctx, input }) => {
    await getDb().transaction(async (tx) => {
      for (const [position, ideaId] of input.ids.entries())
        await tx
          .update(ideas)
          .set({ position })
          .where(and(eq(ideas.id, ideaId), eq(ideas.userId, ctx.user.id), eq(ideas.state, input.state), isNull(ideas.deletedAt)));
    });
    return { ok: true as const };
  }),

  /** To the trash, where Undo finds it for 30 days. */
  remove: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await ownIdea(ctx.user.id, input.id);
    await getDb().update(ideas).set({ deletedAt: new Date() }).where(eq(ideas.id, input.id));
    return { ok: true as const };
  }),

  restore: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await ownIdea(ctx.user.id, input.id, true);
    await getDb().update(ideas).set({ deletedAt: null, updatedAt: new Date() }).where(eq(ideas.id, input.id));
    return ownIdea(ctx.user.id, input.id);
  }),
});
