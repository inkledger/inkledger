// The Desk's chat (docs/work/desk.md, batch 4c): a conversation with the local model
// about the issues shown on the desk. The context is built here from the issues'
// agent copies (the user's own only); the conversation itself lives in the page.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { issues, type User } from "@db/schema";
import { DESK_MAX_PANES, deskIssues, deskPaneSchema, emptySlotSchema, type DeskPane, type DeskSlot } from "@contracts/desk";
import { DESK_CHAT_PATH, type DeskChatIssue, type DeskChatTurn } from "@contracts/deskChat";
import { issueMarkdown } from "@contracts/issueCopy";
import { emptyDoc } from "@contracts/richtext";
import { t } from "@contracts/i18n";
import { currentLocale } from "@contracts/i18n/core";
import { restUser } from "../context";
import { getDb } from "../queries/connection";
import { ownConnection } from "../providers/connections";
import { fromMarkdown } from "../providers/core/richtext";
import { agentCopy } from "../issues/agentCopy";
import { ollamaRefusal, OllamaError, streamChat } from "../ai/ollama";
import { deskChatPrompt } from "../ai/prompts/deskChat";
import { createRateLimiter } from "../lib/security";
import { isShuttingDown } from "../lib/shutdown";

/** An issue's share of the context: six issues stay well inside the window asked for. */
const ISSUE_CHARS = 8_000;
/** Six issues at their longest, the instructions and a few turns (tokens). */
const NUM_CTX = 24_576;
/** The turns sent back: the latest ones (an older question falls out first). */
const KEPT_TURNS = 12;
const TURN_CHARS = 12_000;
/** How often the answer so far goes out drawn as a document (`draft`), while it is written. */
const DRAFT_MS = 150;

/** A person asks a few questions a minute; a loop is stopped. */
const limiter = createRateLimiter(12, 60_000);

/**
 * The model's context: every issue shown on the desk (empty slots and parked issues
 * left out), as its agent copy. NOT_FOUND when any of them isn't the user's. An issue
 * whose description can't be read now (the tracker away) goes in with its header alone.
 */
export async function deskChatContext(
  user: User,
  desk: { panes: readonly DeskSlot[]; parked?: readonly DeskPane[] },
  o: { origin: string },
): Promise<{ issues: DeskChatIssue[]; markdown: string }> {
  const seen = new Set<string>();
  const shown = deskIssues(desk)
    .filter(p => !seen.has(`${p.connectionId}:${p.key}`) && seen.add(`${p.connectionId}:${p.key}`))
    .slice(0, DESK_MAX_PANES);
  const notFound = () => new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
  const rows = await Promise.all(
    shown.map(async pane => {
      await ownConnection(user.id, pane.connectionId).catch(() => {
        throw notFound();
      });
      const [row] = await getDb()
        .select({ summary: issues.summary, status: issues.status, issueType: issues.issueType, url: issues.url })
        .from(issues)
        .where(and(eq(issues.userId, user.id), eq(issues.connectionId, pane.connectionId), eq(issues.key, pane.key)))
        .limit(1);
      if (!row) throw notFound();
      return { pane, row };
    }),
  );
  const parts = await Promise.all(
    rows.map(async ({ pane, row }) => {
      const markdown = await agentCopy(user, pane.key, { connectionId: pane.connectionId, minutes: 60, origin: o.origin, depth: 2 })
        .then(copy => copy.markdown)
        .catch(() => issueMarkdown({ key: pane.key, title: row.summary, url: row.url, status: row.status, type: row.issueType || null }, emptyDoc(), [], 2));
      return markdown.length > ISSUE_CHARS ? `${markdown.slice(0, ISSUE_CHARS)}\n\n(cut here: the issue goes on)\n` : markdown;
    }),
  );
  return {
    issues: rows.map(({ pane, row }) => ({ connectionId: pane.connectionId, key: pane.key, title: row.summary })),
    markdown: parts.join("\n---\n\n"),
  };
}

/** The simulator's answer (OLLAMA_SIMULATOR): the same every time, citing every issue. */
export function simulatedAnswer(context: readonly DeskChatIssue[], question: string): string {
  const keys = context.map(i => i.key);
  return [
    `## ${keys.join(", ")}`,
    "",
    `You asked: *${question.replace(/[*_`[\]<>\\]/g, "").slice(0, 120)}*. This is a simulated answer, written without a model.`,
    "",
    ...context.map(i => `- **${i.key}**: ${i.title.replace(/[*_`[\]<>\\]/g, "")}`),
    "",
    "### What to do first",
    "",
    ...keys.map((key, n) => `${n + 1}. Look at ${key} and write down what it needs next.`),
    "",
    "Every issue above comes from your desk; nothing else was read.",
  ].join("\n");
}

const turn = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(TURN_CHARS) });
const requestSchema = z.object({
  panes: z.array(z.union([deskPaneSchema, emptySlotSchema])).max(20),
  messages: z.array(turn).min(1).max(100).refine(list => list[list.length - 1]?.role === "user"),
});

/** The turns sent to the model: the latest ones, starting with a question. */
function keptTurns(messages: readonly DeskChatTurn[]): DeskChatTurn[] {
  const kept = messages.slice(-KEPT_TURNS);
  return kept[0]?.role === "assistant" ? kept.slice(1) : kept;
}

const failure = (e: unknown) =>
  e instanceof OllamaError
    ? t(e.kind === "slow" ? "server.ideas.llmSlow" : e.kind === "bad" ? "server.ideas.llmBad" : "server.ideas.llmUnreachable")
    : t("server.ideas.llmUnreachable");

/**
 * POST /api/desk/chat `{ panes, messages }`: the answer to the conversation's last
 * question as server-sent events: `context` (the issues read), `delta` (each piece
 * written) and now and then `draft` (the answer so far as a document), then `done`
 * (the whole answer, also as a document to draw) or `error`. The model off: a single
 * `off` event, never an error. The client gone, the request to the model is aborted.
 */
export function registerDeskChatRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.post(DESK_CHAT_PATH, async c => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    if (isShuttingDown()) return c.json({ error: t("server.issues.shuttingDown") }, 503);
    const user = who.user;
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("server.deskChat.invalid") }, 400);
    const wait = limiter.hit(String(user.id));
    if (wait > 0) return c.json({ error: t("server.deskChat.tooMany", { count: wait }) }, 429);
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    if ((await ollamaRefusal()) !== null) return streamSSE(c, stream => stream.writeSSE({ event: "off", data: JSON.stringify({ message: t("server.ideas.llmOff") }) }));
    let context: Awaited<ReturnType<typeof deskChatContext>>;
    try {
      context = await deskChatContext(user, parsed.data, { origin: new URL(c.req.url).origin });
    } catch (e) {
      if (e instanceof TRPCError && e.code === "NOT_FOUND") return c.json({ error: e.message }, 404);
      throw e;
    }
    const conversation = keptTurns(parsed.data.messages);
    const locale = currentLocale();
    return streamSSE(c, async stream => {
      const upstream = new AbortController();
      stream.onAbort(() => upstream.abort());
      await stream.writeSSE({ event: "context", data: JSON.stringify({ issues: context.issues }) });
      let answer = "";
      let drawnAt = 0;
      try {
        const pieces = streamChat(deskChatPrompt(context.markdown, conversation, locale), {
          signal: upstream.signal,
          numCtx: NUM_CTX,
          numPredict: 2_000,
          simulated: simulatedAnswer(context.issues, conversation[conversation.length - 1].content),
        });
        for await (const text of pieces) {
          if (stream.aborted) break;
          answer += text;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text }) });
          if (Date.now() - drawnAt >= DRAFT_MS) {
            drawnAt = Date.now();
            await stream.writeSSE({ event: "draft", data: JSON.stringify({ doc: fromMarkdown(answer, "gfm") }) });
          }
        }
        if (stream.aborted || upstream.signal.aborted) return;
        if (!answer.trim()) throw new OllamaError("bad", "an empty answer");
        await stream.writeSSE({ event: "done", data: JSON.stringify({ markdown: answer, doc: fromMarkdown(answer, "gfm") }) });
      } catch (e) {
        if (stream.aborted) return;
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: failure(e) }) });
      } finally {
        upstream.abort();
      }
    });
  });
}
