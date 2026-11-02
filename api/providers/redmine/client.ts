// Redmine's REST API (JSON), as the adapter needs it: every call through the
// shared safe fetch (read-only servers, redirects re-checked, a self-hosted
// server may sit on the user's network), the personal key in X-Redmine-API-Key,
// errors in the layer's words. Written from Redmine's documentation, not yet
// run on a real server (SPIKES.md). Traps this file answers:
// - the format is the `.json` suffix, not the Accept header: without it Redmine answers HTML;
// - lists page by offset/limit, `limit` is capped at 100 whatever was asked, and `total_count` ends them;
// - a write answers 201 with the record (create) or 204 with nothing (update, delete): the adapter reads again;
// - validation answers 422 `{ errors: ["Hours is invalid"] }`: messages, not field ids;
// - there is no built-in rate limit, a proxy in front may answer 429 (Retry-After).
import { ProviderError, kindOfStatus, mustAnswer, readRefusal, retryAfterMs } from "../core/errors";
import { GONE, jsonCall } from "../core/http";

export type RedmineCreds = {
  /** The site root, with its sub-URI if it has one: https://redmine.example.com, https://host/redmine */
  apiBase: string;
  /** The user's API access key (My account → API access key) */
  token: string;
};

const trimmed = (apiBase: string) => apiBase.trim().replace(/\/+$/, "");

/** Redmine's API lives at the site root: the web site is the same address. */
export const webBaseOf = (apiBase: string) => trimmed(apiBase);

/** A user, group or other record as Redmine refers to it: id and name only. */
export type RmRef = { id: number; name?: string };
export type RmUser = { id: number; login?: string; firstname?: string; lastname?: string; name?: string; mail?: string };
/** `is_closed` comes with the status list (and the allowed ones), not always with the issue's own status. */
export type RmStatus = { id: number; name: string; is_closed?: boolean };

export type RmJournalDetail = { property: string; name: string; old_value?: string | null; new_value?: string | null };
export type RmJournal = { id: number; user?: RmRef | null; notes?: string | null; created_on: string; private_notes?: boolean; details?: RmJournalDetail[] };

export type RmIssue = {
  /** Unique on the whole server (not per project): the number people see */
  id: number;
  project: RmRef;
  tracker?: RmRef;
  status: RmRef & { is_closed?: boolean };
  priority?: RmRef;
  author?: RmRef;
  /** A user, or a group */
  assigned_to?: RmRef;
  parent?: { id: number };
  subject: string;
  description?: string | null;
  /** Plain dates: no time, no zone */
  start_date?: string | null;
  due_date?: string | null;
  estimated_hours?: number | null;
  /** Absent when the user may not see time entries */
  spent_hours?: number | null;
  custom_fields?: { id: number; name: string; value?: string | string[] | null }[];
  /** UTC, "2026-10-14T08:30:00Z" */
  created_on?: string;
  updated_on?: string;
  closed_on?: string | null;
  journals?: RmJournal[];
  /** Redmine 5.0+, with include=allowed_statuses */
  allowed_statuses?: RmStatus[];
};

export type RmTimeEntry = {
  id: number;
  project?: RmRef;
  /** Only its id; absent for time logged on the project itself */
  issue?: { id: number } | null;
  user: RmRef;
  activity?: RmRef;
  /** Decimal hours, two places */
  hours: number;
  comments?: string | null;
  /** A plain date, as the user typed it */
  spent_on: string;
  created_on?: string;
  updated_on?: string;
};

export type RmProject = { id: number; name: string; identifier: string; parent?: RmRef | null; time_entry_activities?: (RmRef & { active?: boolean })[] };
export type RmActivity = RmRef & { is_default?: boolean; active?: boolean };

/** A refused answer as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  // A proxy's limit or an error page is not JSON: its text, without the tags.
  const { message } = await readRefusal<{ errors?: unknown; error?: unknown }>(
    res,
    "Redmine",
    (body) => (Array.isArray(body.errors) && body.errors.length > 0 ? body.errors.map(String).join("; ") : typeof body.error === "string" ? body.error : undefined),
    { plain: true },
  );
  if (res.status === 429) {
    // A proxy's reset is epoch seconds (or seconds to wait): both seen.
    const waitMs = retryAfterMs(res.headers, 30_000, { httpDate: true, reset: "x-ratelimit-reset", resetMayBeDelta: true });
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, ...(res.headers.has("x-ratelimit-remaining") && Number.isFinite(remaining) ? { remaining } : {}) } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = RequestInit & {
  /** 404/410 as null (an issue or entry that isn't there) */
  missingIsNull?: boolean;
  /** 403 as null as well: Redmine answers 403, not 404, for an issue the user may not see */
  hiddenIsNull?: boolean;
  intent?: "read" | "write";
};

/** One call; `data` is undefined for an answer with no body (204). */
export async function rd<T>(c: RedmineCreds, path: string, init: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const { missingIsNull, hiddenIsNull, intent, ...rest } = init;
  const res = await jsonCall({
    site: c.apiBase,
    url: `${trimmed(c.apiBase)}${path}`,
    init: rest,
    headers: { "X-Redmine-API-Key": c.token },
    intent,
    // A self-hosted server may be on the user's own network.
    network: "private",
    missing: [...(missingIsNull ? GONE : []), ...(hiddenIsNull ? [403] : [])],
    refused,
  });
  if (!res) return null;
  if (res.status === 204) return { data: undefined as T, headers: res.headers };
  const text = await res.text();
  if (!text.trim()) return { data: undefined as T, headers: res.headers };
  try {
    return { data: JSON.parse(text) as T, headers: res.headers };
  } catch (cause) {
    // HTML where JSON was asked: a wrong address, the REST API switched off, or a login page.
    throw new ProviderError("incompatible", "Redmine answered something that is not JSON (check the address and that the REST web service is enabled)", { cause });
  }
}

/** A call that always answers. */
export const rdOk = <T>(c: RedmineCreds, path: string, init: Call = {}): Promise<T> => mustAnswer(rd<T>(c, path, init), "Redmine", path);

/** `path` with the paging parameters added (path may already have a query string). */
export const paged = (path: string, limit: number, offset: number) => `${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`;

/** A list answer: the rows under `key`, and how many there are in all. */
export type Listed<T> = Record<string, T[] | number | undefined> & { total_count?: number };

/** Every page of a list (limit tops out at 100), `offset` by what came back, ending on `total_count` or an empty page; bounded. null when the path is a 404. */
export async function rdPages<T>(c: RedmineCreds, path: string, key: string, opts: { maxPages?: number; missingIsNull?: boolean } = {}): Promise<T[] | null> {
  const out: T[] = [];
  let offset = 0;
  for (let n = 0; n < (opts.maxPages ?? 50); n++) {
    const r = await rd<Listed<T>>(c, paged(path, 100, offset), { missingIsNull: opts.missingIsNull });
    if (r === null) return null;
    const rows = (r.data?.[key] as T[] | undefined) ?? [];
    out.push(...rows);
    offset += rows.length;
    if (rows.length === 0 || (typeof r.data?.total_count === "number" && offset >= r.data.total_count)) return out;
  }
  return out;
}
