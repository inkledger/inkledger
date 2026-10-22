// Gitea's (and Forgejo's) REST API, as the adapter needs it: every call
// through the shared safe fetch (read-only servers, redirects re-checked),
// errors in the layer's words, pages by the Link header.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type GiteaCreds = {
  /** The API root of the server: https://host/api/v1 (maybe under a sub-path: https://host/gitea/api/v1) */
  apiBase: string;
  token: string;
};

const API_SUFFIX = /\/api\/v1\/?$/;

/** The web site for an API root (the server may sit under a sub-path). */
export const webBaseOf = (apiBase: string) => apiBase.replace(API_SUFFIX, "").replace(/\/+$/, "");

/** The API root for the address a person types (the server's web address) or the API's own: /api/v1 once. */
export const apiRootOf = (address: string) => `${webBaseOf(address)}/api/v1`;

export type GiteaUser = { id: number; login: string; login_name?: string; full_name?: string | null; email?: string; avatar_url?: string | null };
export type GiteaLabel = { id?: number; name: string; color?: string; exclusive?: boolean };
export type GiteaRepoMeta = { id: number; name: string; owner: string; full_name: string };
export type GiteaIssue = {
  /** Global id; `number` is the index inside the repository (the one paths and keys use) */
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url: string;
  user?: GiteaUser | null;
  /** Labels, maybe null */
  labels?: GiteaLabel[] | null;
  /** null, not [], when nobody is assigned */
  assignees?: GiteaUser[] | null;
  assignee?: GiteaUser | null;
  repository?: GiteaRepoMeta | null;
  /** Set on pull requests: they live in the issues API too */
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
};
export type GiteaComment = { id: number; body?: string | null; user?: GiteaUser | null; created_at: string; updated_at: string };
/** `time` is in seconds; `created` is when it was logged, written with the server's own UTC offset. */
export type GiteaTrackedTime = { id: number; created: string; time: number; user_id: number; user_name: string; issue_id: number; issue?: GiteaIssue | null };
export type GiteaTimelineEntry = {
  id: number;
  type: string;
  created_at: string;
  user?: GiteaUser | null;
  body?: string;
  label?: GiteaLabel | null;
  old_title?: string;
  new_title?: string;
  old_milestone?: { title: string } | null;
  milestone?: { title: string } | null;
  assignee?: GiteaUser | null;
  removed_assignee?: boolean;
};

/** A Gitea answer refused, as a ProviderError (a rate limit, from a proxy in front of it, with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Gitea answered ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message = `Gitea: ${body.message}`;
  } catch {
    // no JSON body (a refused permission is often an empty 403)
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(res.headers.get("retry-after"));
  // Gitea has no rate limit of its own: a reverse proxy in front of it may answer 429 (or a spent 403) with the usual headers.
  const limited = res.status === 429 || (res.status === 403 && (remaining === "0" || (Number.isFinite(retryAfter) && retryAfter > 0)));
  if (limited) {
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
    return new ProviderError("rateLimit", message, { status: res.status, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined } });
  }
  // Time tracking switched off on a repository is a setting, answered 400 (a permission would be 403).
  if (res.status === 400 && /time tracking disabled/i.test(message)) return new ProviderError("forbidden", message, { status: res.status });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

/** The next page's URL, from a Link header. */
export function nextLink(link: string | null): string | null {
  const m = link
    ?.split(",")
    .map((p) => /<([^>]+)>;\s*rel="next"/.exec(p))
    .find(Boolean);
  return m ? m[1] : null;
}

/**
 * Links are built from the server's ROOT_URL: behind a proxy set up wrong
 * they name another host (localhost:3000). Only the part after /api/v1 is
 * kept, and put back on the API root the connection was made with.
 */
export function rebase(apiBase: string, link: string | null): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    const at = u.pathname.lastIndexOf("/api/v1");
    if (at < 0) return null;
    return `${apiBase.replace(/\/+$/, "")}${u.pathname.slice(at + "/api/v1".length)}${u.search}`;
  } catch {
    return null;
  }
}

export type GiteaResult<T> = { data: T; next: string | null; total: number | null };

/** gitea.com and Codeberg is on the internet and never reaches private addresses; a self-hosted server may be on the user's own network. */
const networkOf = (base: string) => {
  const h = new URL(base).hostname.toLowerCase();
  return ["gitea.com", "codeberg.org"].includes(h) ? ("public" as const) : ("private" as const);
};

/** One call; 404/410 as null when `missingIsNull`. */
export async function gt<T>(c: GiteaCreds, path: string, init: RequestInit & { missingIsNull?: boolean } = {}): Promise<GiteaResult<T> | null> {
  const url = path.startsWith("http") ? path : `${c.apiBase.replace(/\/+$/, "")}${path}`;
  const { missingIsNull, ...rest } = init;
  const res = await safeFetch({
    site: c.apiBase,
    network: networkOf(c.apiBase),
    url,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        Authorization: `token ${c.token}`,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && missingIsNull) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  // Several writes answer 201 where one would expect 200 or 204 (an edit, a subscription): any 2xx is a success.
  const text = res.status === 204 ? "" : await res.text();
  const data = (text ? JSON.parse(text) : undefined) as T;
  const total = Number(res.headers.get("x-total-count"));
  return { data, next: rebase(c.apiBase, nextLink(res.headers.get("link"))), total: res.headers.has("x-total-count") && Number.isFinite(total) ? total : null };
}

/** A call that always answers. */
export async function gtOk<T>(c: GiteaCreds, path: string, init: RequestInit = {}): Promise<T> {
  const r = await gt<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Gitea: nothing at ${path}`);
  return r.data;
}

/** Every page of a list, following the Link header (bounded). */
export async function allPages<T>(c: GiteaCreds, path: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let n = 0; next && n < maxPages; n++) {
    const r: GiteaResult<T[]> | null = await gt<T[]>(c, next);
    out.push(...(r?.data ?? []));
    next = r?.next ?? null;
  }
  return out;
}
