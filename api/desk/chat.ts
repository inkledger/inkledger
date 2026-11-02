// The Desk's chat (docs/work/desk.md, batches 4c and 4d): a conversation with the local
// model about the issues shown on the desk. The context is built here from the issues'
// agent copies (the user's own only); the conversation itself lives in the page.
// The code is never read here: the model asks for tools, this route hands the calls to
// the page, which runs them on the user's machine and posts again with the results.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { containers, issues, type User } from "@db/schema";
import { DESK_MAX_PANES, deskIssues, deskPaneSchema, emptySlotSchema, type DeskPane, type DeskSlot } from "@contracts/desk";
import { DESK_CHAT_PATH, DESK_CHAT_REACH_PATH, type DeskChatIssue, type DeskChatReach, type DeskChatToolCall, type DeskChatWire } from "@contracts/deskChat";
import { CODE_TOOLS, EXTRACTS_CHARS, MAX_TOOL_ROUNDS, TOOL_RESULT_CHARS, type CodeToolName } from "@contracts/codeTools";
import { issueMarkdown } from "@contracts/issueCopy";
import { emptyDoc } from "@contracts/richtext";
import { t } from "@contracts/i18n";
import { currentLocale } from "@contracts/i18n/core";
import { restUser } from "../context";
import { getDb } from "../queries/connection";
import { ownConnection } from "../providers/connections";
import { fromMarkdown } from "../providers/core/richtext";
import { agentCopy } from "../issues/agentCopy";
import { chatModelTools, ollamaRefusal, OllamaError, streamChatPieces, toolCallsInText, withoutThinking, type OllamaToolCall, type OllamaWireMessage } from "../ai/ollama";
import { deskChatSystem, deskChatTools, languageReminder, NO_STEPS_LEFT, type DeskChatCode } from "../ai/prompts/deskChat";
import { pathsOf } from "../routers/projectPaths";
import { createRateLimiter } from "../lib/security";
import { isShuttingDown } from "../lib/shutdown";

/** An issue's share of the context: six issues stay well inside the window asked for. */
const ISSUE_CHARS = 8_000;
/** Six issues at their longest, the instructions and a few turns (tokens). */
const NUM_CTX = 24_576;
/** With code: the issues, the tool rounds (compacted by the page) or the extracts (tokens). */
const NUM_CTX_CODE = 32_768;
/** The turns sent back: the latest ones (an older question falls out first). */
const KEPT_TURNS = 12;
const TURN_CHARS = 12_000;
/** Tool calls in one round, and the size of one call's arguments (chars). */
const CALLS_PER_ROUND = 6;
const CALL_CHARS = 2_000;
/** Everything a request carries (chars): the page compacts old tool results well below. */
const TOTAL_CHARS = 160_000;
/** How often the answer so far goes out drawn as a document (`draft`), while it is written. */
const DRAFT_MS = 150;
/** A tool round's context: the issues as read for its question, for this long. */
const CONTEXT_MS = 120_000;

/** A person asks a few questions a minute; a loop is stopped. */
const limiter = createRateLimiter(12, 60_000);
/** Each question may take up to MAX_TOOL_ROUNDS rounds: counted apart, still bounded. */
const roundLimiter = createRateLimiter(12 * MAX_TOOL_ROUNDS, 60_000);

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


const plain = (text: string) => text.replace(/[*_`[\]<>\\]/g, "");

/**
 * The simulator's model (OLLAMA_SIMULATOR) with code in reach: a scripted round. Tools
 * offered and none run yet: it greps the first repository for the first key; with a
 * result (or extracts) it answers citing the result's first line.
 */
function simulatedCode(context: readonly DeskChatIssue[], current: readonly DeskChatWire[], code: DeskChatCode): string | OllamaToolCall[] | null {
  const key = context[0]?.key ?? "";
  const results = current.filter(m => m.role === "tool");
  if (code.mode === "tools" && code.tools.includes("grep") && code.repos.length && !results.length) return [{ name: "grep", arguments: { repo: code.repos[0], query: key } }];
  const found = results.length ? results[results.length - 1].content : code.mode === "extracts" ? code.extracts : null;
  if (found === null) return null;
  const line = found.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "(nothing)";
  return [
    `## ${key}`,
    "",
    `The code was searched for **${key}**. This is a simulated answer, written without a model.`,
    "",
    `- ${plain(line).slice(0, 200)}`,
    "",
    "Every line above comes from your code, read on your machine.",
  ].join("\n");
}

const label = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(s => !/[\\/]/.test(s) && !s.startsWith("~"));
const toolCall = z.object({ name: z.enum(CODE_TOOLS), arguments: z.record(z.string(), z.unknown()) }).refine(c => JSON.stringify(c.arguments).length <= CALL_CHARS);
const wire = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(TURN_CHARS) }),
  z.object({ role: z.literal("assistant"), content: z.string().max(TURN_CHARS), tool_calls: z.array(toolCall).min(1).max(CALLS_PER_ROUND).optional() }),
  z.object({ role: z.literal("tool"), name: z.enum(CODE_TOOLS), content: z.string().max(TOOL_RESULT_CHARS) }),
]);
const requestSchema = z
  .object({
    panes: z.array(z.union([deskPaneSchema, emptySlotSchema])).max(20),
    messages: z.array(wire).min(1).max(200),
    tools: z.array(z.enum(CODE_TOOLS)).max(CODE_TOOLS.length).optional(),
    repos: z.array(label).max(20).optional(),
    extracts: z.string().max(EXTRACTS_CHARS).optional(),
  })
  .refine(b => wellFormed(b.messages));

/**
 * A conversation that can be sent: it ends with a question or a tool result; an answer
 * says something or calls tools; each call has exactly its result, right after it; the
 * current question took MAX_TOOL_ROUNDS rounds at most; the whole is bounded.
 */
function wellFormed(messages: readonly DeskChatWire[]): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== "user" && last?.role !== "tool") return false;
  if (messages.reduce((n, m) => n + m.content.length + (m.role === "assistant" && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0) > TOTAL_CHARS) return false;
  let owed = 0;
  for (const m of messages) {
    if (m.role === "tool") {
      if (owed === 0) return false;
      owed--;
    } else {
      if (owed > 0) return false;
      if (m.role === "assistant") {
        if (!m.content.trim() && !m.tool_calls) return false;
        owed = m.tool_calls?.length ?? 0;
      }
    }
  }
  return owed === 0 && rounds(currentQuestion(messages)) <= MAX_TOOL_ROUNDS;
}

const lastQuestionAt = (messages: readonly DeskChatWire[]) => messages.map(m => m.role).lastIndexOf("user");
/** The last question and its tool rounds. */
const currentQuestion = (messages: readonly DeskChatWire[]) => messages.slice(Math.max(0, lastQuestionAt(messages)));
const rounds = (current: readonly DeskChatWire[]) => current.filter(m => m.role === "assistant" && m.tool_calls).length;

/** The turns sent to the model: the latest earlier ones (questions and answers alone), then the current question whole. */
function keptMessages(messages: readonly DeskChatWire[]): DeskChatWire[] {
  const at = lastQuestionAt(messages);
  const earlier = messages.slice(0, at).filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls && m.content.trim()));
  const kept = earlier.slice(-(KEPT_TURNS - 1));
  return [...(kept[0]?.role === "assistant" ? kept.slice(1) : kept), ...messages.slice(at)];
}

/** A message in Ollama's shape: tool calls under `function`, a result named by `tool_name`. */
function toOllama(m: DeskChatWire): OllamaWireMessage {
  if (m.role === "tool") return { role: "tool", tool_name: m.name, content: m.content };
  if (m.role === "assistant") return m.tool_calls ? { role: "assistant", content: m.content, tool_calls: m.tool_calls.map(c => ({ function: c })) } : { role: "assistant", content: m.content };
  return { role: "user", content: m.content };
}

const failure = (e: unknown) =>
  e instanceof OllamaError
    ? t(e.kind === "slow" ? "server.ideas.llmSlow" : e.kind === "bad" ? "server.ideas.llmBad" : "server.ideas.llmUnreachable")
    : t("server.ideas.llmUnreachable");

/** The context a question read, kept a short while for its tool rounds (the trackers asked once). */
const contexts = new Map<string, { value: Awaited<ReturnType<typeof deskChatContext>>; until: number }>();
async function roundContext(user: User, desk: { panes: readonly DeskSlot[] }, origin: string, fresh: boolean) {
  const key = `${user.id}:${JSON.stringify(deskIssues(desk).map(p => [p.connectionId, p.key]))}`;
  const now = Date.now();
  const cached = contexts.get(key);
  if (!fresh && cached && cached.until > now) return cached.value;
  const value = await deskChatContext(user, desk, { origin });
  for (const [k, v] of contexts) if (v.until <= now || contexts.size > 50) contexts.delete(k);
  contexts.set(key, { value, until: now + CONTEXT_MS });
  return value;
}

/** What the chat can reach for the issues shown: their projects' repository paths, and the model. */
async function deskChatReach(user: User, panes: readonly DeskSlot[]): Promise<DeskChatReach> {
  const shown = deskIssues({ panes }).slice(0, DESK_MAX_PANES);
  const on = (await ollamaRefusal()) === null;
  const model = { on, tools: on && (await chatModelTools()) };
  if (!shown.length) return { model, projects: [], issues: [] };
  const rows = await getDb()
    .select({ connectionId: issues.connectionId, key: issues.key, summary: issues.summary, containerId: issues.containerId })
    .from(issues)
    .where(and(eq(issues.userId, user.id), inArray(issues.key, shown.map(p => p.key))));
  const mine = shown.flatMap(p => rows.filter(r => r.connectionId === p.connectionId && r.key === p.key));
  const ids = [...new Set(mine.flatMap(r => (r.containerId ? [r.containerId] : [])))];
  const projects = ids.length
    ? await getDb()
        .select({ id: containers.id, key: containers.key, name: containers.name })
        .from(containers)
        .where(and(inArray(containers.id, ids), isNotNull(containers.key)))
        .orderBy(asc(containers.key))
    : [];
  return {
    model,
    projects: await Promise.all(projects.map(async p => ({ containerId: p.id, key: p.key, name: p.name, repos: await pathsOf(user.id, p.id) }))),
    issues: mine.map(r => ({ key: r.key, title: r.summary })),
  };
}

/**
 * POST /api/desk/chat `{ panes, messages, tools?, repos?, extracts? }`: the answer to the
 * conversation's last question (or tool result) as server-sent events: `context` (the
 * issues read), `delta` (each piece written) and now and then `draft` (the answer so far
 * as a document), then `done` (the whole answer, also as a document to draw), or
 * `tool_calls` (the tools the model wants run: the page runs them and asks again), or
 * `error`. The model off: a single `off` event, never an error. The client gone, the
 * request to the model is aborted.
 *
 * POST /api/desk/chat/reach `{ panes }`: the projects of the issues shown with their
 * repository paths, and whether the model is on and can call tools.
 */
export function registerDeskChatRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.post(DESK_CHAT_REACH_PATH, async c => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const parsed = z.object({ panes: z.array(z.union([deskPaneSchema, emptySlotSchema])).max(20) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("server.deskChat.invalid") }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(await deskChatReach(who.user, parsed.data.panes));
  });

  app.post(DESK_CHAT_PATH, async c => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    if (isShuttingDown()) return c.json({ error: t("server.issues.shuttingDown") }, 503);
    const user = who.user;
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: t("server.deskChat.invalid") }, 400);
    const body = parsed.data;
    const messages = keptMessages(body.messages);
    const current = currentQuestion(messages);
    const isRound = current.some(m => m.role === "tool");
    const wait = (isRound ? roundLimiter : limiter).hit(String(user.id));
    if (wait > 0) return c.json({ error: t("server.deskChat.tooMany", { count: wait }) }, 429);
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    if ((await ollamaRefusal()) !== null) return streamSSE(c, stream => stream.writeSSE({ event: "off", data: JSON.stringify({ message: t("server.ideas.llmOff") }) }));
    let context: Awaited<ReturnType<typeof deskChatContext>>;
    try {
      context = await roundContext(user, body, new URL(c.req.url).origin, !isRound);
    } catch (e) {
      if (e instanceof TRPCError && e.code === "NOT_FOUND") return c.json({ error: e.message }, 404);
      throw e;
    }
    const stepsLeft = rounds(current) < MAX_TOOL_ROUNDS;
    const offered: CodeToolName[] = stepsLeft && body.repos?.length ? [...new Set(body.tools ?? [])] : [];
    const code: DeskChatCode = offered.length
      ? { mode: "tools", tools: offered, repos: body.repos ?? [], extracts: body.extracts }
      : body.extracts?.trim()
        ? { mode: "extracts", extracts: body.extracts }
        : rounds(current) > 0
          ? { mode: "tools", tools: [], repos: body.repos ?? [] }
          : { mode: "none" };
    const locale = currentLocale();
    const prompt: OllamaWireMessage[] = [
      { role: "system", content: deskChatSystem(context.markdown, context.issues.map(i => i.key), code, locale) },
      ...messages.map(toOllama),
      ...(stepsLeft ? [] : [{ role: "system" as const, content: NO_STEPS_LEFT }]),
      { role: "system", content: languageReminder(locale) },
    ];
    const question = current[0]?.role === "user" ? current[0].content : "";
    return streamSSE(c, async stream => {
      const upstream = new AbortController();
      stream.onAbort(() => upstream.abort());
      await stream.writeSSE({ event: "context", data: JSON.stringify({ issues: context.issues }) });
      let answer = "";
      let drawnAt = 0;
      const calls: DeskChatToolCall[] = [];
      try {
        const pieces = streamChatPieces(prompt, {
          signal: upstream.signal,
          numCtx: code.mode === "none" ? NUM_CTX : NUM_CTX_CODE,
          numPredict: 2_000,
          tools: offered.length ? deskChatTools(offered) : undefined,
          simulated: simulatedCode(context.issues, current, code) ?? simulatedAnswer(context.issues, question),
        });
        // Only the tools offered, a few a round: anything else the model invents is dropped.
        const take = (asked: readonly OllamaToolCall[]) => {
          for (const call of asked) {
            const name = offered.find(n => n === call.name);
            if (name && calls.length < CALLS_PER_ROUND && JSON.stringify(call.arguments).length <= CALL_CHARS) calls.push({ name, arguments: call.arguments });
          }
        };
        // With tools offered, an answer that opens like JSON may be a call written as text
        // (toolCallsInText): it is held back until the end instead of shown as it comes.
        let held = false;
        for await (const piece of pieces) {
          if (stream.aborted) break;
          if ("toolCalls" in piece) {
            take(piece.toolCalls);
            continue;
          }
          const first = !answer.trim();
          answer += piece.text;
          if (first && offered.length && /^\s*([{[`<])/.test(answer)) held = true;
          if (held || !answer.trim()) continue;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: first ? answer : piece.text }) });
          if (Date.now() - drawnAt >= DRAFT_MS) {
            drawnAt = Date.now();
            await stream.writeSSE({ event: "draft", data: JSON.stringify({ doc: fromMarkdown(answer, "gfm") }) });
          }
        }
        if (stream.aborted || upstream.signal.aborted) return;
        answer = withoutThinking(answer);
        // A call written as text, alone or after a few words of plan (shown so far: the page
        // clears it when the calls come).
        const written = calls.length ? null : toolCallsInText(answer, offered);
        if (written) take(written);
        else if (held) await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: answer }) });
        if (calls.length) {
          await stream.writeSSE({ event: "tool_calls", data: JSON.stringify({ calls }) });
          return;
        }
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
