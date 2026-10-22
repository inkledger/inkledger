// Plane's REST API v1, as the adapter needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), the personal token in
// X-API-Key, errors in the layer's words, lists by cursor ("per_page:page:offset").
// Plane cloud answers on api.plane.so and shows its pages on app.plane.so; a
// self-hosted Plane answers and shows on one host.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type PlaneCreds = {
  /** The server's root (no /api/v1): https://api.plane.so, or https://host[/prefix] */
  root: string;
  /** The workspace's slug; null until it is known (only /users/me/ works without it) */
  workspace: string | null;
  token: string;
};

const CLOUD_API = "api.plane.so";
const CLOUD_WEB = "https://app.plane.so";

/**
 * The server and the workspace a connection's address means. The address is
 * the API root, optionally ending in the workspace slug (the connect form has
 * one field: https://api.plane.so/acme); the `workspace` option wins when set,
 * and then any path that is left is a prefix the server is served under.
 */
export function addressOf(baseUrl: string, workspaceOption: string | null): { root: string; workspace: string | null } {
  const url = new URL(baseUrl);
  const segments = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/api(?:\/v1)?$/, "")
    .split("/")
    .filter(Boolean);
  let workspace = workspaceOption;
  if (workspace) {
    if (segments.at(-1)?.toLowerCase() === workspace.toLowerCase()) segments.pop();
  } else if (segments.length > 0) workspace = segments.pop() ?? null;
  return { root: `${url.origin}${segments.length ? `/${segments.join("/")}` : ""}`, workspace };
}

/** Where Plane's pages open for a server root (the cloud's API host is not its web host). */
export const webBaseOf = (root: string) => (new URL(root).hostname === CLOUD_API ? CLOUD_WEB : root.replace(/\/+$/, ""));

/** A service on the internet never reaches private addresses; a self-hosted server may be on the user's network. */
const networkOf = (root: string) => (new URL(root).hostname === CLOUD_API ? ("public" as const) : ("private" as const));

// ---------- Shapes (as Plane's documentation shows them) ----------

export type PlaneUser = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  email?: string | null;
  /** A full link on the cloud; a path on the server on some self-hosted ones */
  avatar?: string | null;
  avatar_url?: string | null;
  is_bot?: boolean;
};
export type PlaneStateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled" | "triage";
export type PlaneState = { id: string; name: string; color?: string | null; group: PlaneStateGroup; sequence?: number | null; default?: boolean; project?: string };
export type PlaneLabel = { id: string; name: string; color?: string | null };
export type PlaneProject = { id: string; identifier: string; name: string; archived_at?: string | null; deleted_at?: string | null; workspace?: string };

export type PlaneIssue = {
  /** A uuid, stable for the item's life; the number people see is `sequence_id`, counted per project */
  id: string;
  sequence_id: number;
  name: string;
  /** "<p></p>" on an item with no description */
  description_html?: string | null;
  description_stripped?: string | null;
  priority?: "urgent" | "high" | "medium" | "low" | "none" | null;
  /** An object with `expand=state`, else the state's uuid */
  state: PlaneState | string;
  /** Objects with `expand=assignees`, else uuids */
  assignees: (PlaneUser | string)[];
  labels: (PlaneLabel | string)[];
  /** The project's uuid */
  project: string;
  parent?: string | null;
  created_by?: PlaneUser | string | null;
  /** Plain dates (no time, no zone) */
  start_date?: string | null;
  target_date?: string | null;
  estimate_point?: number | string | null;
  /** UTC, with microseconds: 2026-10-21T08:30:00.123456Z */
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  is_draft?: boolean;
};

export type PlaneComment = { id: string; comment_html?: string | null; comment_stripped?: string | null; actor?: PlaneUser | string | null; created_at: string; updated_at: string };
export type PlaneActivity = {
  id: string;
  created_at: string;
  /** created | updated | deleted */
  verb: string;
  /** Null when the activity is the item's creation */
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  old_identifier?: string | null;
  new_identifier?: string | null;
  actor?: PlaneUser | string | null;
};
export type PlaneWorklog = {
  id: string;
  /** Minutes: Plane keeps whole minutes */
  duration: number;
  description?: string | null;
  logged_by: string;
  /** The entry's day as a plain date, when Plane gives one; else the day it was created */
  logged_at?: string | null;
  created_at: string;
  updated_at: string;
};
export type PlaneSearchHit = { id: string; name: string; sequence_id: number; project__identifier: string; project_id: string; workspace__slug?: string };

/** A paginated list: the cursor is always present, whether there is a next page is `next_page_results`. */
export type PlanePage<T> = { results: T[]; next_cursor?: string | null; next_page_results?: boolean; total_results?: number };

// ---------- Calls ----------

/** A Plane answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Plane answered ${res.status}`;
  let fields: Record<string, string> | undefined;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.error === "string") message = `Plane: ${body.error}`;
      else if (typeof body.detail === "string") message = `Plane: ${body.detail}`;
      else if (res.status === 400) {
        // Validation errors come as { field: ["This field is required."] }.
        const entries = Object.entries(body).filter(([, v]) => Array.isArray(v) || typeof v === "string");
        if (entries.length) {
          fields = Object.fromEntries(entries.map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
          message = `Plane: ${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join("; ")}`;
        }
      }
      // A throttled call says how long in its text: "Expected available in 30 seconds."
      if (res.status === 429 && typeof body.detail === "string") {
        const m = /available in (\d+) second/i.exec(body.detail);
        if (m) return rateLimited(message, Number(m[1]) * 1000, res);
      }
    } catch {
      if (text.trim()) message = `Plane: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) return rateLimited(message, null, res);
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status, ...(fields ? { fields } : {}) });
}

/** 60 calls a minute per key: a spent quota says when it comes back (Retry-After, else X-RateLimit-Reset in epoch seconds). */
function rateLimited(message: string, textWaitMs: number | null, res: Response): ProviderError {
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const waitMs = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : (textWaitMs ?? 60_000);
  return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, ...(reset > 0 ? { resetAt: reset * 1000 } : {}) } });
}

type Call = RequestInit & {
  /** 404 as null (an item that isn't there, or a deleted one) */
  missingIsNull?: boolean;
  /** 403 as null too: for lookups, where a project the user left reads as not there */
  forbiddenIsNull?: boolean;
};

/** One call. `path` starts after /api/v1. */
export async function plane<T>(c: PlaneCreds, path: string, init: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const { missingIsNull, forbiddenIsNull, ...rest } = init;
  const res = await safeFetch({
    site: c.root,
    url: `${c.root.replace(/\/+$/, "")}/api/v1${path}`,
    init: { ...rest, headers: { Accept: "application/json", "X-API-Key": c.token, ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(rest.headers as Record<string, string> | undefined) } },
    network: networkOf(c.root),
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 && missingIsNull) || (res.status === 403 && forbiddenIsNull)) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  return { data: (res.status === 204 ? undefined : await res.json()) as T, headers: res.headers };
}

/** A call that always answers. */
export async function planeOk<T>(c: PlaneCreds, path: string, init: Call = {}): Promise<T> {
  const r = await plane<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Plane: nothing at ${path}`);
  return r.data;
}

/** The workspace's path, for calls that need it. */
export function inWorkspace(c: PlaneCreds, rest: string): string {
  if (!c.workspace) throw new ProviderError("invalid", "Plane: the workspace is not set (add its slug to the connection's address, https://api.plane.so/<workspace>, or to its options)");
  return `/workspaces/${encodeURIComponent(c.workspace)}${rest}`;
}

export const withQuery = (path: string, params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
};

/** Plane never gives more than this many per page, whatever per_page asks. */
export const MAX_PER_PAGE = 100;

/** One page of a list (an old server may answer a bare array: one page). */
export async function planePage<T>(c: PlaneCreds, path: string, cursor: string | null, perPage = MAX_PER_PAGE): Promise<{ results: T[]; next: string | null }> {
  const r = await planeOk<PlanePage<T> | T[]>(c, withQuery(path, { per_page: Math.min(perPage, MAX_PER_PAGE), cursor }));
  if (Array.isArray(r)) return { results: r, next: null };
  // next_cursor is there on the last page too: only next_page_results says there is more.
  return { results: r.results ?? [], next: r.next_page_results && r.next_cursor ? r.next_cursor : null };
}

/** Every page of a list (bounded: 50 pages of 100). */
export async function planeAll<T>(c: PlaneCreds, path: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < maxPages; n++) {
    const p: { results: T[]; next: string | null } = await planePage<T>(c, path, cursor);
    out.push(...p.results);
    if (!p.next) break;
    cursor = p.next;
  }
  return out;
}

/** What an issue is asked with: objects for its state, people, labels and author instead of uuids. */
export const EXPAND = "state,assignees,labels,created_by";
