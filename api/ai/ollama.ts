// The local model behind idea suggestions (docs/work/ideas/triage.md R-2.8, D-2.4):
// Ollama at OLLAMA_URL, an address the admin chose, never one a user typed.
// Plain fetch (R-0.3): the egress guard refuses private addresses, and this one
// is meant to be on this machine or its network.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t } from "@contracts/i18n";
import { env } from "../lib/env";
import { isPrivateAddress } from "../lib/security";

export type OllamaMessage = { role: "system" | "user"; content: string };
/** A turn of a conversation (the Desk's chat): the model's own answers sent back as `assistant`. */
export type OllamaChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Why the model isn't offered, or null when it is. */
export type OllamaRefusal = "unset" | "public" | "unresolved";

const isLoopback = (ip: string) => {
  const lower = ip.toLowerCase().replace(/^::ffff:/, "");
  return lower === "::1" || (isIP(lower) === 4 && lower.startsWith("127."));
};

/** Loopback or private (RFC 1918, CGNAT/tailnet, ULA), for every address the host resolves to. */
async function isLocal(host: string, resolve: (h: string) => Promise<string[]>): Promise<boolean | null> {
  const bare = host.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(bare) ? [bare] : await resolve(bare);
  } catch {
    return null;
  }
  return addresses.length > 0 && addresses.every((a) => isLoopback(a) || isPrivateAddress(a));
}

const defaultResolve = async (h: string) => (await lookup(h, { all: true })).map((r) => r.address);

/** Whether suggestions can be offered with these settings (checked at boot and on demand). */
export async function ollamaRefusal(
  o: { url: string | null; allowPublic: boolean; simulator: string | null } = { url: env.ollamaUrl, allowPublic: env.ollamaAllowPublic, simulator: env.ollamaSimulator },
  resolve = defaultResolve,
): Promise<OllamaRefusal | null> {
  if (o.simulator) return null;
  if (!o.url) return "unset";
  if (o.allowPublic) return null;
  const local = await isLocal(new URL(o.url).hostname, resolve);
  return local === null ? "unresolved" : local ? null : "public";
}

/** A model set up and allowed (R-2.8), else PRECONDITION_FAILED. */
export async function assertModelOn(): Promise<void> {
  if ((await ollamaRefusal()) !== null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.ideas.llmOff") });
}

/** A fixed answer for tests: valid against the schema, or not. */
const SIMULATED = {
  title: "Estimate issues from my history",
  problem: "Show how long an issue will likely take, from similar closed issues.",
  acceptance: ["The issue page shows a range", "The range says how many issues it is based on"],
  outOfScope: ["Team estimates"],
  questions: ["Which statuses count as work?"],
  split: ["Range on the issue page", "Accuracy in Reports"],
  labels: ["estimates"],
  estimateMinutes: 240,
};

export class OllamaError extends Error {
  readonly kind: "bad" | "slow" | "unreachable";
  constructor(kind: "bad" | "slow" | "unreachable", message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * One answer shaped by `schema` (sent as Ollama's `format`), validated before
 * it is returned; an invalid one is an error, never retried (D-2.4).
 */
export async function chat<T>(
  schema: z.ZodType<T>,
  messages: OllamaMessage[],
  o: {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Context window to ask for (tokens): the server default is small and cuts long inputs silently. */
    numCtx?: number;
    /** Most tokens to write back (a whole note, not a summary of it). */
    numPredict?: number;
    /** What the simulator answers for this call (OLLAMA_SIMULATOR): the idea suggestion otherwise. */
    simulated?: unknown;
  } = {}
): Promise<T> {
  let content: string;
  if (env.ollamaSimulator) {
    content = env.ollamaSimulator === "garbage" ? "{ not json" : JSON.stringify(o.simulated ?? SIMULATED);
  } else {
    if (!env.ollamaUrl) throw new OllamaError("unreachable", "OLLAMA_URL is not set");
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 90_000);
    let res: Response;
    try {
      res = await fetch(`${env.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.ollamaModel,
          messages,
          format: z.toJSONSchema(schema),
          stream: false,
          think: false,
          keep_alive: "5m",
          options: { temperature: 0.2, ...(o.numCtx ? { num_ctx: o.numCtx } : {}), ...(o.numPredict ? { num_predict: o.numPredict } : {}) },
        }),
        redirect: "error",
        signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout,
      });
    } catch (e) {
      if (timeout.aborted) throw new OllamaError("slow", "the model took too long");
      throw new OllamaError("unreachable", String(e));
    }
    if (!res.ok) throw new OllamaError("unreachable", `Ollama answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { message?: { content?: unknown } } | null;
    content = typeof body?.message?.content === "string" ? body.message.content : "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new OllamaError("bad", "the answer is not JSON");
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw new OllamaError("bad", "the answer doesn't match the schema");
  return checked.data;
}

/** A model's answer, its failures said in words (slow, unusable, unreachable). */
export async function askModel<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (e) {
    if (!(e instanceof OllamaError)) throw e;
    if (e.kind === "slow") throw new TRPCError({ code: "TIMEOUT", message: t("server.ideas.llmSlow") });
    if (e.kind === "bad") throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.ideas.llmBad") });
    throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.ideas.llmUnreachable") });
  }
}


/** A tool the model asked for, as Ollama streams it (arguments an object, or JSON text). */
export type OllamaToolCall = { name: string; arguments: Record<string, unknown> };
/** A message of a conversation that may hold tool rounds (the Desk's chat, batch 4d). */
export type OllamaWireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { function: OllamaToolCall }[] }
  | { role: "tool"; content: string; tool_name: string };
/** A tool offered to the model (Ollama's `tools`, OpenAI's function shape). */
export type OllamaToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
/** A piece of a streamed answer: text, or the tools the model wants run. */
export type ChatPiece = { text: string } | { toolCalls: OllamaToolCall[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The tool calls a line carries (`message.tool_calls`), arguments read whether object or text. */
function toolCallsOf(value: unknown): OllamaToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const fn = isRecord(item) && isRecord(item.function) ? item.function : null;
    if (!fn || typeof fn.name !== "string") return [];
    let args: unknown = fn.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return [{ name: fn.name, arguments: isRecord(args) ? args : {} }];
  });
}

/**
 * The pieces of a streamed /api/chat answer (NDJSON: one object a line, the last one
 * `done`): its text, and the tool calls when the model asks for tools. Lines and
 * characters may be split anywhere across chunks. An `error` line, a line that isn't
 * JSON or an end before `done` is an error.
 */
export async function* readOllamaPieces(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<ChatPiece> {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (line: string): { pieces: ChatPiece[]; done: boolean } => {
    let value: { message?: { content?: unknown; tool_calls?: unknown }; done?: unknown; error?: unknown };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      throw new OllamaError("bad", "a line of the answer is not JSON");
    }
    if (typeof value.error === "string") throw new OllamaError("unreachable", value.error);
    const content = typeof value.message?.content === "string" ? value.message.content : "";
    const calls = toolCallsOf(value.message?.tool_calls);
    const pieces: ChatPiece[] = [...(content ? [{ text: content }] : []), ...(calls.length ? [{ toolCalls: calls }] : [])];
    return { pieces, done: value.done === true };
  };
  for await (const chunk of "getReader" in body ? chunksOf(body) : body) {
    pending += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (!line) continue;
      const { pieces, done } = parse(line);
      yield* pieces;
      if (done) return;
    }
  }
  const last = (pending + decoder.decode()).trim();
  if (last) {
    const { pieces, done } = parse(last);
    yield* pieces;
    if (done) return;
  }
  throw new OllamaError("unreachable", "the answer ended before the end");
}

/** The text of a streamed /api/chat answer, piece by piece (tool calls left out). */
export async function* readOllamaStream(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const piece of readOllamaPieces(body)) if ("text" in piece) yield piece.text;
}

/** A web stream's chunks; leaving early cancels it (the request to Ollama ends). */
async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The simulator's pace: a piece every few ms, so Stop can be tried (OLLAMA_SIMULATOR). */
const SIMULATED_PIECE_MS = 40;

type StreamOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  numCtx?: number;
  numPredict?: number;
  /** Tools the model may call; its answer may then be tool calls instead of text. */
  tools?: OllamaToolDef[];
  /** What the simulator answers (OLLAMA_SIMULATOR): text word by word, or tool calls. */
  simulated?: string | OllamaToolCall[];
};

/**
 * An answer to a conversation, streamed as the model writes it (the Desk's chat, with
 * OLLAMA_CHAT_MODEL): text pieces, or the tools it wants run. `timeoutMs` bounds the
 * whole answer; `signal` stops it (the client went away).
 */
export async function* streamChatPieces(messages: OllamaWireMessage[], o: StreamOptions = {}): AsyncGenerator<ChatPiece> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 180_000);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  if (env.ollamaSimulator) {
    if (Array.isArray(o.simulated)) {
      await new Promise(resolve => setTimeout(resolve, SIMULATED_PIECE_MS));
      if (!signal.aborted) yield { toolCalls: o.simulated };
      return;
    }
    for (const piece of (o.simulated ?? "").match(/\S+\s*|\s+/g) ?? []) {
      await new Promise(resolve => setTimeout(resolve, SIMULATED_PIECE_MS));
      if (signal.aborted) return;
      yield { text: piece };
    }
    return;
  }
  if (!env.ollamaUrl) throw new OllamaError("unreachable", "OLLAMA_URL is not set");
  let res: Response;
  try {
    res = await fetch(`${env.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.ollamaChatModel,
        messages,
        ...(o.tools?.length ? { tools: o.tools } : {}),
        stream: true,
        think: false,
        keep_alive: "5m",
        options: { temperature: 0.3, ...(o.numCtx ? { num_ctx: o.numCtx } : {}), ...(o.numPredict ? { num_predict: o.numPredict } : {}) },
      }),
      redirect: "error",
      signal,
    });
  } catch (e) {
    if (timeout.aborted) throw new OllamaError("slow", "the model took too long");
    throw new OllamaError("unreachable", String(e));
  }
  if (!res.ok || !res.body) throw new OllamaError("unreachable", `Ollama answered ${res.status}`);
  try {
    yield* readOllamaPieces(res.body);
  } catch (e) {
    if (timeout.aborted) throw new OllamaError("slow", "the model took too long");
    if (signal.aborted) return;
    throw e instanceof OllamaError ? e : new OllamaError("unreachable", String(e));
  }
}

/** A plain-text answer to a conversation, streamed (no tools). */
export async function* streamChat(messages: OllamaChatMessage[], o: Omit<StreamOptions, "tools" | "simulated"> & { simulated?: string } = {}): AsyncGenerator<string> {
  for await (const piece of streamChatPieces(messages, o)) if ("text" in piece) yield piece.text;
}

/** Whether a model can call tools, by model and address: asked once in a while, not each question. */
const toolSupport = new Map<string, { tools: boolean; until: number }>();
const KNOWN_MS = 10 * 60_000;
const UNKNOWN_MS = 30_000;

/**
 * Whether the chat model (OLLAMA_CHAT_MODEL) can call tools: Ollama's /api/show lists
 * `tools` among its capabilities. Unreachable or unknown: no (the chat then sends
 * extracts instead), asked again a little later. The simulator can (`notools`: can't).
 */
export async function chatModelTools(): Promise<boolean> {
  if (env.ollamaSimulator) return env.ollamaSimulator !== "notools";
  if (!env.ollamaUrl) return false;
  const key = `${env.ollamaUrl} ${env.ollamaChatModel}`;
  const known = toolSupport.get(key);
  if (known && known.until > Date.now()) return known.tools;
  let tools = false;
  let ok = false;
  try {
    const res = await fetch(`${env.ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.ollamaChatModel }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    const body = (res.ok ? await res.json().catch(() => null) : null) as { capabilities?: unknown } | null;
    ok = body !== null;
    tools = Array.isArray(body?.capabilities) && body.capabilities.includes("tools");
  } catch {
    // Unreachable now: no tools, asked again soon.
  }
  toolSupport.set(key, { tools, until: Date.now() + (ok ? KNOWN_MS : UNKNOWN_MS) });
  return tools;
}
