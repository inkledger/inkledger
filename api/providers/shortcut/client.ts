// Shortcut's REST API v3, as the adapter needs it: every call through the
// shared safe fetch (read-only servers, redirects re-checked), the personal
// token in `Shortcut-Token`, errors in the layer's words. Its traps live
// here: search pages of at most 25 whose `next` is a path (with /api/v3 in
// it) rather than a URL, the budget of 200 requests a minute answered with a
// 429 and Retry-After, and validation errors as a list of messages.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";

export type ShortcutCreds = {
  /** The API host: https://api.app.shortcut.com (a trailing /api/v3 is tolerated; the path is added here) */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "").replace(/\/api\/v3$/, "");
/** Where every v3 path starts. */
export const rootOf = (apiBase: string) => `${trimmed(apiBase)}/api/v3`;

/** A search returns at most this many results a page. */
export const SEARCH_PAGE_MAX = 25;
const SEARCH_PATH = "/api/v3/search/stories";

/** The current member: GET /member has its names at the top level, unlike /members. */
export type ShortcutMe = { id: string; name: string; mention_name: string; role?: string; workspace2?: { url_slug?: string } };
/** A member of the workspace (GET /members): names are in the profile. */
export type ShortcutMember = {
  id: string;
  disabled?: boolean;
  profile: { name?: string | null; mention_name: string; email_address?: string | null; display_icon?: { url?: string | null } | null; deactivated?: boolean };
};
/** type: backlog, unstarted, started or done; there is no "cancelled" */
export type ShortcutState = { id: number; name: string; type: string; position?: number; color?: string | null };
export type ShortcutWorkflow = { id: number; name: string; states: ShortcutState[]; default_state_id?: number };
export type ShortcutLabel = { id: number; name: string };
export type ShortcutStory = {
  id: number;
  name: string;
  description?: string | null;
  story_type: string;
  app_url: string;
  workflow_id: number;
  workflow_state_id: number;
  owner_ids: string[];
  follower_ids?: string[];
  requested_by_id?: string | null;
  labels?: ShortcutLabel[];
  /** A date-time, midnight UTC of the day chosen */
  deadline?: string | null;
  /** Points on the workspace's scale, not time */
  estimate?: number | null;
  archived: boolean;
  started?: boolean;
  completed?: boolean;
  started_at?: string | null;
  completed_at?: string | null;
  moved_at?: string | null;
  created_at: string;
  /** Null on a story never changed since it was created */
  updated_at?: string | null;
  parent_story_id?: number | null;
  iteration_id?: number | null;
};
export type ShortcutComment = {
  id: number;
  /** Null for a comment from an integration */
  author_id?: string | null;
  text?: string | null;
  created_at: string;
  updated_at?: string | null;
  /** Soft-deleted comments are still listed */
  deleted?: boolean;
  external_id?: string | null;
};
export type ShortcutSearch = { total: number; data: ShortcutStory[]; next: string | null };
export type ShortcutRef = { id: number | string; entity_type: string; name?: string };
export type ShortcutChanges = Record<string, { old?: unknown; new?: unknown; adds?: unknown[]; removes?: unknown[] }>;
export type ShortcutHistory = {
  id: string;
  changed_at: string;
  member_id?: string | null;
  actions: { id?: number; entity_type: string; action: string; changes?: ShortcutChanges }[];
  references?: ShortcutRef[];
};

/** A Shortcut answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Shortcut answered ${res.status}`;
  let text = "";
  try {
    text = await res.text();
    const body = JSON.parse(text) as { message?: unknown; errors?: unknown };
    const errors = Array.isArray(body.errors) ? body.errors.filter((e): e is string => typeof e === "string") : [];
    if (typeof body.message === "string") message = `Shortcut: ${[body.message, ...errors].join(": ")}`;
    else if (errors.length) message = `Shortcut: ${errors.join("; ")}`;
  } catch {
    if (text.trim()) message = `Shortcut: ${text.trim().slice(0, 200)}`;
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Date.now() + waitMs } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = RequestInit & {
  /** 404/410 as null (a story that was deleted, or isn't visible) */
  missingIsNull?: boolean;
  intent?: "read" | "write";
};

/** One call: the path under /api/v3 (or a path already starting with it). */
export async function sc<T>(c: ShortcutCreds, path: string, init: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const { missingIsNull, intent, ...rest } = init;
  const site = trimmed(c.apiBase);
  const url = path.startsWith("/api/v3/") ? `${site}${path}` : `${rootOf(c.apiBase)}${path}`;
  const res = await safeFetch({
    site,
    url,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        "Shortcut-Token": c.token,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    },
    ...(intent ? { intent } : {}),
    // Shortcut is a service on the internet: never a private address.
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && missingIsNull) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) throw await refused(res);
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  return { data, headers: res.headers };
}

/** A call that always answers. */
export async function scOk<T>(c: ShortcutCreds, path: string, init: Call = {}): Promise<T> {
  const r = await sc<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Shortcut: nothing at ${path}`);
  return r.data;
}

/**
 * The path a search's `next` points to, kept only when it is the search
 * endpoint of this API (a token read back from a checkpoint is data, never a
 * place to send the credentials).
 */
export function searchPathOf(c: ShortcutCreds, next: string): string | null {
  let path = next;
  if (/^https?:\/\//.test(next)) {
    const u = new URL(next);
    if (u.origin !== new URL(trimmed(c.apiBase)).origin) return null;
    path = `${u.pathname}${u.search}`;
  }
  return path.startsWith(`${SEARCH_PATH}?`) ? path : null;
}

/** One page of a story search: a query (first page) or the `next` path of the page before. */
export async function scSearch(c: ShortcutCreds, at: { query: string; pageSize: number } | { next: string }): Promise<ShortcutSearch> {
  let path: string;
  if ("next" in at) {
    const safe = searchPathOf(c, at.next);
    if (!safe) throw new ProviderError("invalidCheckpoint", "Shortcut: a page token that is not a search page");
    path = safe;
  } else {
    path = `${SEARCH_PATH}?${new URLSearchParams({ query: at.query, page_size: String(Math.min(SEARCH_PAGE_MAX, Math.max(1, at.pageSize))) }).toString()}`;
  }
  const r = await scOk<ShortcutSearch>(c, path);
  return { total: r.total, data: r.data ?? [], next: r.next ?? null };
}
