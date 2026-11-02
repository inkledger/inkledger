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

/**
 * The text of a streamed /api/chat answer (NDJSON: one object a line, the last one
 * `done`), piece by piece. Lines and characters may be split anywhere across chunks.
 * An `error` line, a line that isn't JSON or an end before `done` is an error.
 */
export async function* readOllamaStream(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (line: string): { content: string; done: boolean } => {
    let value: { message?: { content?: unknown }; done?: unknown; error?: unknown };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      throw new OllamaError("bad", "a line of the answer is not JSON");
    }
    if (typeof value.error === "string") throw new OllamaError("unreachable", value.error);
    return { content: typeof value.message?.content === "string" ? value.message.content : "", done: value.done === true };
  };
  for await (const chunk of "getReader" in body ? chunksOf(body) : body) {
    pending += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      if (!line) continue;
      const { content, done } = parse(line);
      if (content) yield content;
      if (done) return;
    }
  }
  const last = (pending + decoder.decode()).trim();
  if (last) {
    const { content, done } = parse(last);
    if (content) yield content;
    if (done) return;
  }
  throw new OllamaError("unreachable", "the answer ended before the end");
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

/**
 * A plain-text answer to a conversation, streamed as the model writes it (the Desk's
 * chat). `timeoutMs` bounds the whole answer; `signal` stops it (the client went away).
 * With OLLAMA_SIMULATOR the `simulated` text comes back word by word.
 */
export async function* streamChat(
  messages: OllamaChatMessage[],
  o: { timeoutMs?: number; signal?: AbortSignal; numCtx?: number; numPredict?: number; simulated?: string } = {},
): AsyncGenerator<string> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 180_000);
  const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
  if (env.ollamaSimulator) {
    for (const piece of (o.simulated ?? "").match(/\S+\s*|\s+/g) ?? []) {
      await new Promise(resolve => setTimeout(resolve, SIMULATED_PIECE_MS));
      if (signal.aborted) return;
      yield piece;
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
        model: env.ollamaModel,
        messages,
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
    yield* readOllamaStream(res.body);
  } catch (e) {
    if (timeout.aborted) throw new OllamaError("slow", "the model took too long");
    if (signal.aborted) return;
    throw e instanceof OllamaError ? e : new OllamaError("unreachable", String(e));
  }
}
