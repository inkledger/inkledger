// The feedback inbox (FEEDBACK_URL), seen from this server: inkledger's own Worker by
// default, any compatible one otherwise (docs/self-hosting.md). Only feedback/upstream.ts
// calls it, signed with this server's instance key; the page never does.
import { env } from "../lib/env";
import { readCapped } from "../store/body";

const TIMEOUT_MS = 15_000;
/** Its answers are small (a status document): anything larger is refused unread. */
const MAX_ANSWER_BYTES = 512 * 1024;

export class InboxError extends Error {
  readonly code: "off" | "unreachable" | "rejected" | "rate";
  readonly status: number;
  /** Seconds to wait before asking again (a 429's Retry-After). */
  readonly retryAfter: number;
  constructor(code: InboxError["code"], status = 0, detail = "", retryAfter = 0) {
    super(`feedback inbox ${code}${status ? ` ${status}` : ""}${detail ? `: ${detail}` : ""}`);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type InboxAnswer = { status: number; etag: string | null; json: unknown };

/** One call; a 304 answers with no body. Redirects elsewhere are refused. */
export async function callInbox(path: string, init: RequestInit): Promise<InboxAnswer> {
  if (!env.feedbackUrl) throw new InboxError("off");
  let res: Response;
  try {
    res = await fetch(`${env.feedbackUrl}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new InboxError("unreachable");
  }
  if (res.status === 304) {
    await res.body?.cancel().catch(() => undefined);
    return { status: 304, etag: res.headers.get("etag"), json: null };
  }
  const body = await readCapped(res, MAX_ANSWER_BYTES).catch(() => null);
  if (!body) throw new InboxError("unreachable", res.status, "answer");
  let json: unknown = null;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    // not JSON: no detail
  }
  const error = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after") ?? (json as { retryAfter?: unknown } | null)?.retryAfter ?? 0);
    throw new InboxError("rate", 429, "", Number.isFinite(after) && after > 0 ? Math.min(after, 40 * 86_400) : 3600);
  }
  if (!res.ok) throw new InboxError(res.status >= 500 || typeof error !== "string" ? "unreachable" : "rejected", res.status, typeof error === "string" ? error : "");
  return { status: res.status, etag: res.headers.get("etag"), json };
}
