// Ideas in triage (docs/work/ideas/triage.md): captured raw, refined until
// ready, then an issue, an agent's prompt or a mail. Per user; deleted ones wait
// 30 days in the trash.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { connections, containers, ideas, issues } from "@db/schema";
import { t } from "@contracts/i18n";
import { askMailUrl, canMove, CAPTURE_MAX, handoffPrompt, IDEA_ROUTES, IDEA_STATES, splitIdeas, ideaSuggestionSchema, type Criterion, type IdeaRoute, type IdeaState, type Question } from "@contracts/ideas";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueKeyInput } from "../lib/inputs";
import { agentCopy } from "../issues/agentCopy";
import { chat, ollamaRefusal, OllamaError } from "../ai/ollama";
import { ideaPrompt } from "../ai/prompts/idea";
import { env } from "../lib/env";
import { currentLocale } from "@contracts/i18n/core";

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

type Linked = { key: string | null; summary: string | null; url: string | null; goneAt: Date | null } | null;

/**
 * An idea as the page shows it: its lists parsed, its project named, the issues
 * it came from and became read from the catalogue (their key follows a rename).
 */
function rowOf(i: IdeaRecord, container: { id: number; key: string; name: string } | null, source: Linked, promoted: Linked) {
  return {
    ...i,
    state: isState(i.state) ? i.state : "raw",
    route: isRoute(i.route) ? i.route : null,
    acceptance: parsed<Criterion>(acceptance, i.acceptance),
    questions: parsed<Question>(questions, i.questions),
    labels: parsed<string>(labels, i.labels),
    container,
    source:
      i.sourceIssueKey !== null && i.sourceConnectionId !== null
        ? { key: source?.key ?? i.sourceIssueKey, connectionId: i.sourceConnectionId, summary: source?.summary ?? null }
        : null,
    promoted:
      i.promotedIssueKey !== null && i.promotedConnectionId !== null
        ? { key: promoted?.key ?? i.promotedIssueKey, connectionId: i.promotedConnectionId, summary: promoted?.summary ?? null, url: promoted?.url ?? null, gone: !promoted?.key || promoted.goneAt !== null }
        : null,
  };
}
export type IdeaRow = ReturnType<typeof rowOf>;

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: t("server.ideas.notFound") });

/** The user's own ideas with their projects, in board order: by state, then position. */
async function rowsOf(userId: number, where: ReturnType<typeof and>) {
  const source = alias(issues, "source_issue");
  const promoted = alias(issues, "promoted_issue");
  const rows = await getDb()
    .select({
      idea: ideas,
      container: { id: containers.id, key: containers.key, name: containers.name },
      source: { key: source.key, summary: source.summary, url: source.url, goneAt: source.goneAt },
      promoted: { key: promoted.key, summary: promoted.summary, url: promoted.url, goneAt: promoted.goneAt },
    })
    .from(ideas)
    .leftJoin(containers, eq(containers.id, ideas.containerId))
    .leftJoin(source, eq(source.id, ideas.sourceItemId))
    .leftJoin(promoted, eq(promoted.id, ideas.promotedItemId))
    .where(and(eq(ideas.userId, userId), where))
    .orderBy(sql`array_position(ARRAY['raw','refining','ready','promoted','discarded'], ${ideas.state})`, asc(ideas.position), asc(ideas.id));
  return rows.map((r) => rowOf(r.idea, r.container, r.source, r.promoted));
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

/** An issue of the user's in the catalogue, on a connection in use (by its key, on its connection when given), else NOT_FOUND. */
async function ownIssue(userId: number, issueKey: string, connectionId: number | undefined) {
  const rows = await getDb()
    .select({ id: issues.id, key: issues.key, summary: issues.summary, connectionId: issues.connectionId })
    .from(issues)
    .innerJoin(connections, eq(connections.id, issues.connectionId))
    .where(
      and(
        eq(issues.userId, userId),
        eq(issues.key, issueKey),
        isNull(connections.archivedAt),
        connectionId !== undefined ? eq(issues.connectionId, connectionId) : undefined,
      ),
    )
    .limit(2);
  if (rows.length > 1) throw new TRPCError({ code: "CONFLICT", message: t("server.connections.ambiguousKey", { key: issueKey }) });
  const issue = rows[0];
  if (!issue || issue.connectionId === null) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
  return { ...issue, connectionId: issue.connectionId };
}

/** The issue's open idea (not promoted, discarded or deleted), if any (R-2.4). */
async function openIdeaOf(userId: number, connectionId: number, issueKey: string) {
  const [row] = await getDb()
    .select({ id: ideas.id, state: ideas.state })
    .from(ideas)
    .where(
      and(
        eq(ideas.userId, userId),
        eq(ideas.sourceConnectionId, connectionId),
        eq(ideas.sourceIssueKey, issueKey),
        isNull(ideas.deletedAt),
        sql`${ideas.state} NOT IN ('promoted', 'discarded')`,
      ),
    )
    .limit(1);
  return row ? { id: row.id, state: isState(row.state) ? row.state : "raw" } : null;
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

  /** A vague issue to triage, nothing written to its tracker (R-2.4): its open idea, made when there is none. */
  fromIssue: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: id.optional() })).mutation(async ({ ctx, input }) => {
    const issue = await ownIssue(ctx.user.id, input.issueKey, input.connectionId);
    const open = await openIdeaOf(ctx.user.id, issue.connectionId, issue.key);
    if (open) return ownIdea(ctx.user.id, open.id);
    // At the top of Raw; a second request racing this one finds the one the unique index lets in.
    const made = await getDb().transaction(async (tx) => {
      await tx
        .update(ideas)
        .set({ position: sql`${ideas.position} + 1` })
        .where(and(eq(ideas.userId, ctx.user.id), eq(ideas.state, "raw"), isNull(ideas.deletedAt)));
      return tx
        .insert(ideas)
        .values({ userId: ctx.user.id, title: issue.summary.slice(0, 200) || issue.key, state: "raw", position: 0, sourceConnectionId: issue.connectionId, sourceItemId: issue.id, sourceIssueKey: issue.key })
        .onConflictDoNothing()
        .returning({ id: ideas.id });
    });
    const ideaId = made[0]?.id ?? (await openIdeaOf(ctx.user.id, issue.connectionId, issue.key))?.id;
    if (ideaId === undefined) throw notFound();
    return ownIdea(ctx.user.id, ideaId);
  }),

  /** The issue's open idea, for its page's chip (R-2.10). */
  forIssue: protectedProcedure.input(z.object({ issueKey: issueKeyInput, connectionId: id.optional() })).query(async ({ ctx, input }) => {
    const issue = await ownIssue(ctx.user.id, input.issueKey, input.connectionId);
    return openIdeaOf(ctx.user.id, issue.connectionId, issue.key);
  }),

  /** The issue it became, once created through the usual dialog (R-2.5): it must be one of mine, in the catalogue. */
  linkPromoted: protectedProcedure.input(z.object({ id, issueKey: issueKeyInput, connectionId: id })).mutation(async ({ ctx, input }) => {
    const idea = await ownIdea(ctx.user.id, input.id);
    if (idea.state === "promoted" || idea.state === "discarded") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.ideas.move.terminal") });
    const [issue] = await getDb()
      .select({ id: issues.id, key: issues.key })
      .from(issues)
      .where(and(eq(issues.userId, ctx.user.id), eq(issues.connectionId, input.connectionId), eq(issues.key, input.issueKey), isNull(issues.goneAt)))
      .limit(1);
    if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
    await getDb()
      .update(ideas)
      .set({ state: "promoted", promotedConnectionId: input.connectionId, promotedItemId: issue.id, promotedIssueKey: issue.key, promotedAt: new Date(), position: 0, updatedAt: new Date() })
      .where(eq(ideas.id, input.id));
    return ownIdea(ctx.user.id, input.id);
  }),

  /**
   * The idea as a prompt for a coding agent (R-2.6): made here, never sent.
   * Its issue (the one it became, else the one it came from) goes in as
   * copied for an agent, links valid `minutes` (docs/work/ideas/issue-copy.md R-6.8);
   * an issue its tracker can't give now is left out, the prompt still comes.
   */
  handoff: protectedProcedure.input(z.object({ id, minutes: z.number().int().min(5).max(1440).optional() })).query(async ({ ctx, input }) => {
    const idea = await ownIdea(ctx.user.id, input.id);
    const linked = idea.promoted ?? idea.source;
    const issueText = linked
      ? await agentCopy(ctx.user, linked.key, { connectionId: linked.connectionId, minutes: input.minutes, origin: new URL(ctx.req.url).origin, depth: 3 })
          .then((c) => c.markdown)
          .catch(() => null)
      : null;
    return handoffPrompt(idea, idea.promoted?.url ? { key: idea.promoted.key, url: idea.promoted.url } : null, issueText);
  }),

  /** Whether "Suggest" is offered (R-2.8): a local model configured, on a local address unless allowed. */
  llm: protectedProcedure.query(async () => {
    const available = (await ollamaRefusal()) === null;
    return { available, model: available ? (env.ollamaSimulator ? "simulator" : env.ollamaModel) : null };
  }),

  /** What the local model suggests for the idea (R-2.8): nothing is saved here, each field is used by hand. */
  suggest: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input, signal }) => {
    const idea = await ownIdea(ctx.user.id, input.id);
    if ((await ollamaRefusal()) !== null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.ideas.llmOff") });
    try {
      return await chat(ideaSuggestionSchema, ideaPrompt(idea, currentLocale()), { timeoutMs: 90_000, signal });
    } catch (e) {
      if (!(e instanceof OllamaError)) throw e;
      if (e.kind === "slow") throw new TRPCError({ code: "TIMEOUT", message: t("server.ideas.llmSlow") });
      if (e.kind === "bad") throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.ideas.llmBad") });
      throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.ideas.llmUnreachable") });
    }
  }),

  /** A mail link asking its open questions (R-2.6): the user's mail program sends it, if they want. */
  askMail: protectedProcedure.input(z.object({ id, to: z.string().trim().email().max(320).nullable() })).query(async ({ ctx, input }) => ({
    url: askMailUrl(await ownIdea(ctx.user.id, input.id), input.to),
  })),

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
