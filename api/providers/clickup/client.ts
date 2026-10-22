// ClickUp's API v2, as the adapter needs it: every call through the shared safe
// fetch (read-only servers, redirects re-checked), the personal token sent as
// the whole Authorization header (no "Bearer": that is for OAuth), errors in
// the layer's words, rate-limit headers read. ClickUp is a hosted service only,
// so every call goes to the public internet.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type ClickUpCreds = {
  /** The API root: https://api.clickup.com/api/v2 */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

/** The web site for an API root (links): api.clickup.com is app.clickup.com. */
export function webBaseOf(apiBase: string): string {
  try {
    const u = new URL(trimmed(apiBase));
    return `${u.protocol}//${u.host.replace(/^api\./, "app.")}`;
  } catch {
    return trimmed(apiBase);
  }
}

/** A user: ids are numbers in most answers, strings in some. */
export type ClickUpUser = { id: number | string; username?: string | null; email?: string | null; color?: string | null; initials?: string | null; profilePicture?: string | null };

export type ClickUpStatus = { id?: string; status: string; color?: string | null; orderindex?: number | string | null; type: string };

export type ClickUpTask = {
  /** A string, alphanumeric: not a number */
  id: string;
  /** Present when the workspace has custom task ids on */
  custom_id?: string | null;
  custom_item_id?: number | null;
  name: string;
  description?: string | null;
  markdown_description?: string | null;
  status: ClickUpStatus;
  /** Every date is Unix milliseconds, as a string */
  date_created?: string | null;
  date_updated?: string | null;
  date_closed?: string | null;
  date_done?: string | null;
  creator?: ClickUpUser | null;
  assignees?: ClickUpUser[];
  watchers?: ClickUpUser[];
  tags?: { name: string }[];
  /** The parent task's id */
  parent?: string | null;
  priority?: { id?: string; priority: string; orderindex?: string | null } | null;
  due_date?: string | null;
  /** The due date carries a time of day, else it is a day */
  due_date_time?: boolean | null;
  start_date?: string | null;
  /** Milliseconds */
  time_estimate?: number | null;
  time_spent?: number | null;
  team_id?: string | null;
  url: string;
  /** The home list */
  list?: { id: string; name?: string | null; access?: boolean } | null;
  /** The folder; hidden for a list that has none */
  folder?: { id: string; name?: string | null; hidden?: boolean } | null;
  space?: { id: string } | null;
};

export type ClickUpList = { id: string; name: string; statuses?: ClickUpStatus[] };
export type ClickUpSpace = { id: string; name: string; statuses?: ClickUpStatus[] };
export type ClickUpTeam = { id: string; name: string };

export type ClickUpBlock = { text?: string; type?: string; attributes?: Record<string, unknown>; user?: { username?: string | null; id?: number | string }; image?: { url?: string } };
export type ClickUpComment = {
  id: string;
  /** The rich form: a list of blocks */
  comment?: ClickUpBlock[];
  comment_text?: string | null;
  user?: ClickUpUser | null;
  date: string;
};

export type ClickUpEntry = {
  id: string;
  /** The task, or "0" / null for time on no task */
  task?: { id: string; custom_id?: string | null; name?: string | null } | string | null;
  wid?: string | null;
  user?: ClickUpUser | null;
  billable?: boolean | null;
  /** Unix milliseconds, as strings */
  start: string;
  end?: string | null;
  /** Milliseconds; negative while the timer runs */
  duration: string;
  description?: string | null;
  /** When it last changed */
  at?: string | null;
};

type Refusal = { err?: unknown; ECODE?: unknown };

/** ECODEs of a 401 that is about the resource, not the token: the team (workspace) of the call is not the token's. */
const TEAM_NOT_AUTHORIZED = /^OAUTH_02[37]$/;

/** A ClickUp answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `ClickUp answered ${res.status}`;
  let ecode = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as Refusal;
      if (typeof body.err === "string" && body.err) message = `ClickUp: ${body.err}`;
      if (typeof body.ECODE === "string") ecode = body.ECODE;
    } catch {
      if (text.trim()) message = `ClickUp: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    // X-RateLimit-Reset is a Unix time in seconds; no Retry-After.
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000;
    const waitMs = Math.max(1000, resetAt - Date.now());
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt } });
  }
  // A 401 about a team the token doesn't belong to: not the token failing, the thing being out of reach.
  if (res.status === 401 && TEAM_NOT_AUTHORIZED.test(ecode)) return new ProviderError("forbidden", message, { status: 401 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: string;
  data?: unknown;
  /** 404/410 as null (a task that is not there, or was deleted) */
  missingIsNull?: boolean;
};

export type Answer<T> = { data: T; headers: Headers };

/** One call. */
export async function clickup<T>(c: ClickUpCreds, path: string, init: Call = {}): Promise<Answer<T> | null> {
  const body = init.data === undefined ? undefined : JSON.stringify(init.data);
  const res = await safeFetch({
    site: c.apiBase,
    url: `${trimmed(c.apiBase)}${path}`,
    init: {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", Authorization: c.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body } : {}),
    },
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && init.missingIsNull) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  if (res.status === 204) return { data: undefined as T, headers: res.headers };
  return { data: (await res.json()) as T, headers: res.headers };
}

/** A call that always answers. */
export async function clickupOk<T>(c: ClickUpCreds, path: string, init: Call = {}): Promise<T> {
  const r = await clickup<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `ClickUp: nothing at ${path}`);
  return r.data;
}

/** A path with its query: an array parameter is written name[]=a&name[]=b, as ClickUp reads it. */
export function withQuery(path: string, params: Record<string, string | number | boolean | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) q.append(`${k}[]`, item);
    else q.append(k, String(v));
  }
  const text = q.toString();
  return text ? `${path}${path.includes("?") ? "&" : "?"}${text}` : path;
}
