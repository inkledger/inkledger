// GitHub's REST API, as the adapter needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), errors in the
// layer's words, pages by the Link header.
import { createHash } from "node:crypto";
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type GitHubCreds = {
  /** The API root: https://api.github.com, or a GitHub Enterprise Server's https://host/api/v3 */
  apiBase: string;
  token: string;
};

/** The web site for an API root: github.com, or the Enterprise host. */
export const webBaseOf = (apiBase: string) => (/^https:\/\/api\.github\.com\/?$/.test(apiBase) ? "https://github.com" : apiBase.replace(/\/api\/v3\/?$/, ""));

export type GitHubUser = { id: number; login: string; name?: string | null; avatar_url?: string | null };
export type GitHubLabel = string | { name?: string };
export type GitHubIssue = {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | null;
  html_url: string;
  repository_url: string;
  repository?: { id: number; node_id: string; full_name: string; name: string };
  labels: GitHubLabel[];
  assignees?: GitHubUser[];
  user?: GitHubUser | null;
  milestone?: { title?: string; due_on?: string | null } | null;
  locked?: boolean;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
};
export type GitHubComment = { id: number; body?: string | null; user?: GitHubUser | null; created_at: string; updated_at: string };

/** A GitHub answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `GitHub answered ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message = `GitHub: ${body.message}`;
  } catch {
    // no JSON body
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(res.headers.get("retry-after"));
  // A spent quota answers 403 (primary) or 429 (secondary): both are waits, not refusals.
  const limited = res.status === 429 || (res.status === 403 && (remaining === "0" || Number.isFinite(retryAfter) && retryAfter > 0));
  if (limited) {
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
    return new ProviderError("rateLimit", message, { status: res.status, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Number.isFinite(reset) ? reset * 1000 : undefined } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

/** The next page's URL, from a Link header. */
export function nextLink(link: string | null): string | null {
  const m = link?.split(",").map((p) => /<([^>]+)>;\s*rel="next"/.exec(p)).find(Boolean);
  return m ? m[1] : null;
}

/**
 * Pages read before, by who read them (a hash of the token) and URL, with
 * their ETag: asked again with If-None-Match, an unchanged page answers 304
 * and costs nothing of the rate limit (spike github-etag). Bounded.
 */
const READ = new Map<string, { etag: string; data: unknown; next: string | null }>();
const READ_MAX = 500;

/** One call; 404/410 as null when `missingIsNull`. */
export async function gh<T>(c: GitHubCreds, path: string, init: RequestInit & { missingIsNull?: boolean } = {}): Promise<{ data: T; next: string | null } | null> {
  const url = path.startsWith("http") ? path : `${c.apiBase.replace(/\/+$/, "")}${path}`;
  const reads = (init.method ?? "GET").toUpperCase() === "GET";
  const key = reads ? `${createHash("sha256").update(c.token).digest("hex").slice(0, 16)} ${url}` : "";
  const known = reads ? READ.get(key) : undefined;
  const res = await safeFetch({
    site: c.apiBase,
    url,
    init: {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${c.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(known ? { "If-None-Match": known.etag } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if (res.status === 304 && known) return { data: known.data as T, next: known.next };
  if ((res.status === 404 || res.status === 410) && init.missingIsNull) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  // 204 No Content, 205 Reset Content (a thread marked read): nothing to read.
  const data = (res.status === 204 || res.status === 205 ? undefined : await res.json()) as T;
  const next = nextLink(res.headers.get("link"));
  const etag = res.headers.get("etag");
  if (reads && etag) {
    READ.delete(key);
    READ.set(key, { etag, data, next });
    // The oldest goes first.
    if (READ.size > READ_MAX) READ.delete(READ.keys().next().value!);
  }
  return { data, next };
}

/** A call that always answers. */
export async function ghOk<T>(c: GitHubCreds, path: string, init: RequestInit = {}): Promise<T> {
  const r = await gh<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `GitHub: nothing at ${path}`);
  return r.data;
}
