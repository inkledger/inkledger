// Notion's REST API (version 1, dated 2022-06-28), as the adapter needs it:
// every call through the shared safe fetch (read-only servers, redirects
// re-checked), the integration token as a Bearer token and the API version in
// a header Notion refuses to answer without, errors in the layer's words.
// Notion answers every error as JSON ({ object: "error", status, code,
// message }); a lost or unshared page is a 404 (object_not_found), never a 403.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";

/** The version of the API the adapter is written against; a newer one changes databases into data sources. */
export const NOTION_VERSION = "2022-06-28";

export type NotionCreds = {
  /** https://api.notion.com/v1 */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

export type NotionRichText = {
  type: "text" | "mention" | "equation";
  text?: { content: string; link: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean; color?: string };
  plain_text: string;
  href?: string | null;
};

export type NotionUser = {
  object: "user";
  id: string;
  type?: "person" | "bot";
  name?: string | null;
  avatar_url?: string | null;
  person?: { email?: string };
  bot?: { owner?: { type: "user"; user: NotionUser } | { type: "workspace"; workspace: true }; workspace_name?: string | null };
};

export type NotionOption = { id: string; name: string; color?: string };
export type NotionGroup = { id: string; name: string; color?: string; option_ids: string[] };

/** A property of a page: its value, under the key of its type. */
export type NotionValue = {
  id: string;
  type: string;
  title?: NotionRichText[];
  status?: NotionOption | null;
  select?: NotionOption | null;
  people?: NotionUser[];
  date?: { start: string; end: string | null; time_zone: string | null } | null;
  multi_select?: NotionOption[];
};

export type NotionPage = {
  object: "page";
  id: string;
  created_time: string;
  /** Rounded to the minute */
  last_edited_time: string;
  archived: boolean;
  in_trash?: boolean;
  url: string;
  parent: { type: "database_id"; database_id: string } | { type: "page_id"; page_id: string } | { type: "workspace"; workspace: true };
  properties: Record<string, NotionValue>;
};

/** A property of a database: its schema. */
export type NotionColumn = {
  id: string;
  name: string;
  type: string;
  status?: { options: NotionOption[]; groups: NotionGroup[] };
  select?: { options: NotionOption[] };
};

export type NotionDatabase = {
  object: "database";
  id: string;
  title: NotionRichText[];
  url: string;
  properties: Record<string, NotionColumn>;
};

export type NotionComment = {
  object: "comment";
  id: string;
  parent: { type: "page_id"; page_id: string } | { type: "block_id"; block_id: string };
  discussion_id: string;
  created_time: string;
  last_edited_time: string;
  created_by: { object: "user"; id: string };
  rich_text: NotionRichText[];
};

export type NotionBlock = {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  archived?: boolean;
  /** The block's content, under the key of its type: rich_text for the text ones */
  [type: string]: unknown;
};

type Results<T> = { object: "list"; results: T[]; next_cursor: string | null; has_more: boolean };

/** A Notion answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let code = "";
  let message = `answered ${res.status}`;
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // no JSON body (a gateway's page)
  }
  message = `Notion: ${message.slice(0, 300)}`;
  if (res.status === 429 || code === "rate_limited") {
    // Retry-After is in seconds; an average of 3 requests a second is the documented budget.
    const seconds = Number(res.headers.get("retry-after"));
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: seconds > 0 ? seconds * 1000 : 1000, remaining: 0 } });
  }
  if (res.status === 401) return new ProviderError("auth", message, { status: 401 });
  if (res.status === 403) return new ProviderError("forbidden", message, { status: 403 });
  if (code === "object_not_found") return new ProviderError("notFound", message, { status: 404 });
  if (code === "conflict_error" || res.status === 409) return new ProviderError("conflict", message, { status: res.status });
  // service_unavailable, gateway_timeout, internal_server_error
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  /** A page, database or user that isn't there for this integration (deleted, never shared with it) as null */
  missingIsNull?: boolean;
  intent?: "read" | "write";
};

/** One call. */
export async function nt<T>(c: NotionCreds, path: string, call: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = `${trimmed(c.apiBase)}${path}${qs.size ? `?${qs.toString()}` : ""}`;
  const res = await safeFetch({
    site: c.apiBase,
    url,
    init: {
      method: call.method ?? "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${c.token}`, "Notion-Version": NOTION_VERSION, ...(call.body ? { "Content-Type": "application/json" } : {}) },
      ...(call.body ? { body: JSON.stringify(call.body) } : {}),
    },
    // A query is a POST that only reads.
    ...(call.intent ? { intent: call.intent } : {}),
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if (!res.ok) {
    const err = await refused(res);
    if (call.missingIsNull && err.kind === "notFound") return null;
    throw err;
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (cause) {
    throw new ProviderError("incompatible", "Notion: an answer that isn't JSON", { cause });
  }
  return { data, headers: res.headers };
}

/** A call that always answers. */
export async function ntOk<T>(c: NotionCreds, path: string, call: Call = {}): Promise<T> {
  const r = await nt<T>(c, path, call);
  if (!r) throw new ProviderError("notFound", `Notion: nothing at ${path}`);
  return r.data;
}

/** The page size Notion allows at most. */
export const PAGE_SIZE = 100;

/** One page of a list, by cursor (GET lists take it in the query, queries in the body). */
export async function ntList<T>(c: NotionCreds, path: string, call: Call, cursor: string | null, size = PAGE_SIZE): Promise<{ results: T[]; next: string | null }> {
  const post = call.method === "POST";
  const r = await ntOk<Results<T>>(c, path, {
    ...call,
    ...(post ? { body: { ...call.body, page_size: size, ...(cursor ? { start_cursor: cursor } : {}) } } : { query: { ...call.query, page_size: size, ...(cursor ? { start_cursor: cursor } : {}) } }),
  });
  return { results: r.results, next: r.has_more ? r.next_cursor : null };
}

/** Every page of a list. */
export async function ntAll<T>(c: NotionCreds, path: string, call: Call = {}, maxPages = 100): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < maxPages; n++) {
    const page: { results: T[]; next: string | null } = await ntList<T>(c, path, call, cursor);
    out.push(...page.results);
    if (!page.next) break;
    cursor = page.next;
  }
  return out;
}

/** The ids of a page or database as the API writes them (dashed) from the 32 hex characters of a URL. */
export function dashed(id: string): string {
  const h = id.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
