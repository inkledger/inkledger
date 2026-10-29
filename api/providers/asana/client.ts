// Asana's REST API 1.0, as the adapter needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), the personal access
// token as a Bearer, errors in the layer's words, pages by `next_page.offset`.
// Asana is a hosted service only, so every call goes to the public internet.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody, trimTrailingSlash } from "../core/http";

export type AsanaCreds = {
  /** The API root: https://app.asana.com/api/1.0 */
  apiBase: string;
  token: string;
};


/** The web site for an API root (links): the same host without /api/1.0. */
export const webBaseOf = (apiBase: string) => trimTrailingSlash(apiBase).replace(/\/api\/1\.0$/, "");

/** Asana answers a bare record unless asked for its fields: these are what the adapter reads. */
export const USER_FIELDS = "name,email,photo.image_128x128,workspaces.name";
export const TASK_FIELDS = [
  "name",
  "notes",
  "html_notes",
  "completed",
  "completed_at",
  "created_at",
  "modified_at",
  "due_on",
  "due_at",
  "start_on",
  "resource_subtype",
  "permalink_url",
  "actual_time_minutes",
  "assignee.name",
  "assignee.photo.image_128x128",
  "created_by.name",
  "created_by.photo.image_128x128",
  "memberships.project.name",
  "memberships.section.name",
  "parent.name",
  "tags.name",
  "workspace.name",
].join(",");
export const STORY_FIELDS = "type,resource_subtype,created_at,created_by.name,created_by.photo.image_128x128,html_text,text,old_name,new_name,old_section.gid,old_section.name,new_section.gid,new_section.name,old_dates,new_dates,assignee.name";
export const ENTRY_FIELDS = "duration_minutes,entered_on,description,created_at,created_by.name,task,attributable_to.name,billable_status,approval_status";

/** A compact reference: Asana's answer for anything not asked in full. */
export type AsanaRef = { gid: string; resource_type?: string; name?: string | null };
export type AsanaUser = { gid: string; name?: string | null; email?: string | null; photo?: { image_128x128?: string | null } | null; workspaces?: AsanaRef[] };

export type AsanaTask = {
  /** A string, always: ids pass 2^53 */
  gid: string;
  name: string;
  notes?: string | null;
  html_notes?: string | null;
  completed: boolean;
  completed_at?: string | null;
  created_at: string;
  modified_at: string;
  /** A plain date: no time, no zone */
  due_on?: string | null;
  /** A UTC instant: set instead of due_on when the due date has a time */
  due_at?: string | null;
  start_on?: string | null;
  resource_subtype?: string;
  permalink_url: string;
  actual_time_minutes?: number | null;
  assignee?: AsanaUser | null;
  created_by?: AsanaUser | null;
  /** A subtask carries none: it sits in its parent's projects */
  memberships?: { project?: AsanaRef | null; section?: AsanaRef | null }[];
  parent?: AsanaRef | null;
  tags?: AsanaRef[];
  workspace?: AsanaRef | null;
};

export type AsanaStory = {
  gid: string;
  type: "comment" | "system";
  resource_subtype?: string;
  created_at: string;
  created_by?: AsanaUser | null;
  /** Wrapped in <body>…</body> */
  html_text?: string | null;
  text?: string | null;
  old_name?: string | null;
  new_name?: string | null;
  old_section?: AsanaRef | null;
  new_section?: AsanaRef | null;
  old_dates?: { due_on?: string | null } | null;
  new_dates?: { due_on?: string | null } | null;
  assignee?: AsanaRef | null;
};

export type AsanaEntry = {
  gid: string;
  /** Whole minutes */
  duration_minutes: number;
  /** A date, in no zone */
  entered_on: string;
  description?: string | null;
  created_at?: string | null;
  created_by?: AsanaUser | null;
  task?: AsanaRef | null;
  attributable_to?: AsanaRef | null;
  billable_status?: "billable" | "nonBillable" | "notApplicable" | null;
  approval_status?: "draft" | "submitted" | "approved" | "rejected" | null;
};

/** An Asana answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Asana answered ${res.status}`;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { errors?: { message?: unknown }[] };
      const said = body.errors?.map((e) => (typeof e.message === "string" ? e.message : "")).filter(Boolean);
      if (said?.length) message = `Asana: ${said.join("; ")}`;
    } catch {
      if (text.trim()) message = `Asana: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    // Retry-After is in seconds (a plan's per-minute quota, or too many calls at once).
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 60_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Date.now() + waitMs } });
  }
  // A page token Asana no longer takes: read the pass again.
  if (res.status === 400 && /\boffset\b/i.test(message)) return new ProviderError("invalidCheckpoint", message, { status: 400 });
  // Payment required: a feature of a paid plan (search, time tracking), the account may not use it.
  if (res.status === 402) return new ProviderError("forbidden", message, { status: 402 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: string;
  /** Sent as { data } */
  data?: unknown;
  /** 404/410 as null (a task that is not there, or was deleted) */
  missingIsNull?: boolean;
};

export type Answer<T> = { data: T; next: string | null; headers: Headers };

/** One call. */
export async function asana<T>(c: AsanaCreds, path: string, init: Call = {}): Promise<Answer<T> | null> {
  const body = init.data === undefined ? undefined : JSON.stringify({ data: init.data });
  const res = await safeFetch({
    site: c.apiBase,
    url: `${trimTrailingSlash(c.apiBase)}${path}`,
    init: {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${c.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
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
  if (res.status === 204) return { data: undefined as T, next: null, headers: res.headers };
  const json = (await res.json()) as { data?: T; next_page?: { offset?: string } | null };
  if (json.data === undefined) throw new ProviderError("incompatible", "Asana: an answer with no data");
  return { data: json.data, next: json.next_page?.offset ?? null, headers: res.headers };
}

/** A call that always answers. */
export async function asanaOk<T>(c: AsanaCreds, path: string, init: Call = {}): Promise<T> {
  const r = await asana<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Asana: nothing at ${path}`);
  return r.data;
}

const joined = (path: string, params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).flatMap(([k, v]): [string, string][] => (v === undefined ? [] : [[k, String(v)]])));
  return `${path}${path.includes("?") ? "&" : "?"}${q.toString()}`;
};

/** One page of a list: `limit` records from `offset` (null: the first), and the offset of the next page. */
export function asanaPage<T>(c: AsanaCreds, path: string, o: { limit: number; offset?: string | null; params?: Record<string, string | number | undefined> }): Promise<Answer<T[]> | null> {
  return asana<T[]>(c, joined(path, { ...o.params, limit: o.limit, offset: o.offset ?? undefined }));
}

/** Every page of a list (bounded: 50 pages of 100). */
export async function asanaPages<T>(c: AsanaCreds, path: string, params: Record<string, string | number | undefined> = {}, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let offset: string | null = null;
  for (let n = 0; n < maxPages; n++) {
    const r: Answer<T[]> | null = await asanaPage<T>(c, path, { limit: 100, offset, params });
    out.push(...(r?.data ?? []));
    offset = r?.next ?? null;
    if (!offset) break;
  }
  return out;
}
