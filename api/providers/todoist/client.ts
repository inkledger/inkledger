// Todoist's unified API (v1), as the adapter needs it: every call through the
// shared safe fetch (read-only servers, redirects re-checked), the token as a
// Bearer header, cursors instead of pages, errors in the layer's words.
// Todoist's traps live here: ids are opaque strings (the numeric ids of the
// old API only come back through /id_mappings), a list takes at most 200 a
// page, writes often answer 204 with no body, and the rate limit arrives as a
// 429 whose body says how long to wait.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";

export type TodoistCreds = {
  /** https://api.todoist.com (the /api/v1 path is added here) */
  apiBase: string;
  token: string;
};

/** The most a page holds; asking for more is a 400. */
export const PAGE_LIMIT = 200;

export type TodoistUser = { id: string; full_name?: string | null; email?: string | null; avatar_big?: string | null; avatar_medium?: string | null; timezone?: string | null };
export type TodoistCollaborator = { id: string; name?: string | null; email?: string | null };
export type TodoistProject = {
  id: string;
  name: string;
  parent_id?: string | null;
  is_shared: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
  inbox_project?: boolean;
  workspace_id?: string | null;
};
export type TodoistSection = { id: string; project_id: string; name: string; section_order: number; is_archived?: boolean; is_deleted?: boolean };
/** A due date: a day ("2026-10-30"), a floating time ("2026-10-30T09:00:00", the user's own clock) or a fixed instant ("…Z" with `timezone`). */
export type TodoistDue = { date: string; string?: string; timezone?: string | null; is_recurring: boolean; lang?: string };
export type TodoistTask = {
  id: string;
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  content: string;
  description: string;
  /** Names, not ids */
  labels: string[];
  /** 1 is the default ("p4" in the app), 4 is urgent ("p1") */
  priority: number;
  due: TodoistDue | null;
  deadline?: { date: string } | null;
  responsible_uid: string | null;
  added_by_uid?: string | null;
  checked: boolean;
  is_deleted?: boolean;
  added_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  child_order?: number;
};
export type TodoistComment = { id: string; item_id?: string; content: string; posted_uid: string | null; posted_at: string; is_deleted?: boolean };
export type TodoistActivity = {
  id: string;
  object_type: string;
  object_id: string;
  /** added, updated, completed, uncompleted, deleted */
  event_type: string;
  event_date: string;
  parent_project_id?: string | null;
  initiator_id?: string | null;
  extra_data?: {
    content?: string;
    last_content?: string;
    description?: string;
    last_description?: string;
    due_date?: string | null;
    last_due_date?: string | null;
    responsible_uid?: string | null;
    last_responsible_uid?: string | null;
  } | null;
};
export type SyncAnswer = { sync_token: string; full_sync: boolean; items?: TodoistTask[] };

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");
const DEFAULT_WAIT_MS = 60_000;

/** A Todoist answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let text = "";
  try {
    text = (await res.text()).trim();
  } catch {
    // no body
  }
  let message = text.slice(0, 200) || `answered ${res.status}`;
  let retryAfter: number | null = null;
  try {
    const body = JSON.parse(text) as { error?: unknown; error_extra?: { retry_after?: unknown } };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.error_extra?.retry_after === "number") retryAfter = body.error_extra.retry_after;
  } catch {
    // plain text ("Forbidden")
  }
  message = `Todoist: ${message}`;
  if (res.status === 429) {
    // The body says how many seconds; the header, when present, is the same figure.
    const header = Number(res.headers.get("retry-after"));
    const seconds = retryAfter ?? (header > 0 ? header : null);
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: seconds === null ? DEFAULT_WAIT_MS : seconds * 1000, remaining: 0 } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

/** Whether an error says "no such thing for you": gone, never existed, a malformed id, or a project the token lost. */
export const isMissing = (e: unknown) => e instanceof ProviderError && (e.kind === "notFound" || e.kind === "forbidden" || (e.kind === "invalid" && e.status === 400));

type Call = {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  /** Missing (see isMissing) as null */
  missingIsNull?: boolean;
  /** Writes answer 204 with no body: nothing to parse */
  noContent?: boolean;
  intent?: "read" | "write";
};

/** One call. */
export async function td<T>(c: TodoistCreds, path: string, call: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = `${trimmed(c.apiBase)}/api/v1${path}${qs.size ? `?${qs.toString()}` : ""}`;
  const res = await safeFetch({
    site: c.apiBase,
    url,
    init: {
      method: call.method ?? "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${c.token}`, ...(call.body ? { "Content-Type": "application/json" } : {}) },
      ...(call.body ? { body: JSON.stringify(call.body) } : {}),
    },
    ...(call.intent ? { intent: call.intent } : {}),
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if (!res.ok) {
    const err = await refused(res);
    if (call.missingIsNull && isMissing(err)) return null;
    throw err;
  }
  if (call.noContent) return { data: undefined as T, headers: res.headers };
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (cause) {
    throw new ProviderError("incompatible", "Todoist: an answer that isn't JSON", { cause });
  }
  return { data, headers: res.headers };
}

/** A call that always answers. */
export async function tdOk<T>(c: TodoistCreds, path: string, call: Call = {}): Promise<T> {
  const r = await td<T>(c, path, call);
  if (!r) throw new ProviderError("notFound", `Todoist: nothing at ${path}`);
  return r.data;
}

/** A write with no answer body. */
export async function tdDo(c: TodoistCreds, path: string, call: Call = {}): Promise<void> {
  await tdOk<void>(c, path, { method: "POST", ...call, noContent: true });
}

type Listed<T> = { results: T[]; next_cursor: string | null };

/** Every page of a list, by cursor, 200 at a time (or until `max` rows). */
export async function tdAll<T>(c: TodoistCreds, path: string, query: Record<string, string | number | boolean | undefined> = {}, max = Infinity, maxPages = 200): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const page = await tdOk<Listed<T>>(c, path, { query: { limit: PAGE_LIMIT, ...query, ...(cursor ? { cursor } : {}) } });
    rows.push(...page.results);
    if (rows.length >= max) return { rows: rows.slice(0, max), complete: rows.length === max && !page.next_cursor };
    if (!page.next_cursor) return { rows, complete: true };
    cursor = page.next_cursor;
  }
  throw new ProviderError("incompatible", `Todoist: ${path} has no end`);
}

/** The Sync API, asked only for tasks: "*" gives every open task, a token what changed since (completed and deleted ones included). */
export async function tdSync(c: TodoistCreds, syncToken: string): Promise<SyncAnswer> {
  return tdOk<SyncAnswer>(c, "/sync", { method: "POST", body: { sync_token: syncToken, resource_types: ["items"] }, intent: "read" });
}
