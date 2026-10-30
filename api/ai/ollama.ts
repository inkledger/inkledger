// The local model behind idea suggestions (docs/work/ideas/triage.md R-2.8, D-2.4):
// Ollama at OLLAMA_URL, an address the admin chose, never one a user typed.
// Plain fetch (R-0.3): the egress guard refuses private addresses, and this one
// is meant to be on this machine or its network.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { env } from "../lib/env";
import { isPrivateAddress } from "../lib/security";

export type OllamaMessage = { role: "system" | "user"; content: string };

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
