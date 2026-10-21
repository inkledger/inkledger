// GitLab's REST API v4 and the one GraphQL endpoint it needs (timelogs), as the
// adapter needs them: every call through the shared safe fetch (read-only
// servers, redirects re-checked), the personal token in PRIVATE-TOKEN, errors
// in the layer's words, pages by the Link header.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";
import { nextLink } from "../github/client";

export type GitLabCreds = {
  /** The API root: https://gitlab.com/api/v4, or a self-hosted https://host[/prefix]/api/v4 */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

/** The web site for an API root (links, avatars): the same host without /api/v4. */
export const webBaseOf = (apiBase: string) => trimmed(apiBase).replace(/\/api\/v4$/, "");

/** The API root for the address a person types (the server's web address) or the API's own: /api/v4 once. */
export const apiRootOf = (address: string) => `${webBaseOf(address)}/api/v4`;

/** GraphQL lives next to v4, not under it. */
const graphqlUrl = (apiBase: string) => `${trimmed(apiBase).replace(/\/v4$/, "")}/graphql`;

export type GitLabUser = { id: number; username: string; name?: string | null; avatar_url?: string | null; email?: string | null };

export type GitLabIssue = {
  /** Unique on the whole instance; the number people see is `iid`, unique only within the project */
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  /** "opened" or "closed" (not "open") */
  state: "opened" | "closed";
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  labels: string[];
  assignees?: GitLabUser[];
  author?: GitLabUser | null;
  /** A plain date: no time, no zone */
  due_date?: string | null;
  web_url: string;
  references: { short: string; relative: string; full: string };
  /** The id of the issue this one was moved to (it stays here, closed) */
  moved_to_id?: number | null;
  issue_type?: string;
  time_stats?: { time_estimate?: number; total_time_spent?: number };
  confidential?: boolean;
};

export type GitLabNote = { id: number; body: string; author: GitLabUser; created_at: string; updated_at: string; system: boolean };
export type GitLabLabelEvent = { id: number; user?: GitLabUser | null; created_at: string; label: { id: number; name: string } | null; action: "add" | "remove" };
export type GitLabStateEvent = { id: number; user?: GitLabUser | null; created_at: string; state: string };
export type GitLabMilestoneEvent = { id: number; user?: GitLabUser | null; created_at: string; milestone: { id: number; title: string } | null; action: "add" | "remove" };

/** A GitLab answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `GitLab answered ${res.status}`;
  let fields: Record<string, string> | undefined;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: unknown; error_description?: unknown };
      if (typeof body.message === "string") message = `GitLab: ${body.message}`;
      else if (body.message && typeof body.message === "object") {
        // Validation errors come as { field: ["is invalid"] }.
        fields = Object.fromEntries(Object.entries(body.message).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
        message = `GitLab: ${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join("; ")}`;
      } else if (typeof body.error === "string") message = `GitLab: ${body.error}${typeof body.error_description === "string" ? ` (${body.error_description})` : ""}`;
    } catch {
      // A limit answers plain text ("Retry later").
      if (text.trim()) message = `GitLab: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("ratelimit-reset"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: reset > 0 ? reset * 1000 : undefined } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status, ...(fields ? { fields } : {}) });
}

type Call = RequestInit & {
  /** 404/410 as null (a project or issue that isn't there, or isn't visible: GitLab answers 404 for both) */
  missingIsNull?: boolean;
  /** Statuses that are a success with no body (304 on subscribing twice) */
  accept?: number[];
  intent?: "read" | "write";
};

/** GitLab.com is on the internet and never reaches private addresses; a self-hosted server may be on the user's own network. */
const networkOf = (base: string) => {
  const h = new URL(base).hostname.toLowerCase();
  return ["gitlab.com"].includes(h) ? ("public" as const) : ("private" as const);
};

/** One call. */
export async function gl<T>(c: GitLabCreds, path: string, init: Call = {}): Promise<{ data: T; next: string | null; headers: Headers } | null> {
  const { missingIsNull, accept, intent, ...rest } = init;
  const url = path.startsWith("http") ? path : `${trimmed(c.apiBase)}${path}`;
  const res = await safeFetch({
    site: c.apiBase,
    network: networkOf(c.apiBase),
    url,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        "PRIVATE-TOKEN": c.token,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    },
    ...(intent ? { intent } : {}),
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && missingIsNull) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (accept?.includes(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    return { data: undefined as T, next: null, headers: res.headers };
  }
  if (!res.ok) throw await refused(res);
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  return { data, next: nextLink(res.headers.get("link")), headers: res.headers };
}

/** A call that always answers. */
export async function glOk<T>(c: GitLabCreds, path: string, init: Call = {}): Promise<T> {
  const r = await gl<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `GitLab: nothing at ${path}`);
  return r.data;
}

/** Every page of a list (bounded: 50 pages of 100). */
export async function glPages<T>(c: GitLabCreds, path: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let n = 0; next && n < maxPages; n++) {
    const r: { data: T[]; next: string | null } | null = await gl<T[]>(c, next);
    out.push(...(r?.data ?? []));
    next = r?.next ?? null;
  }
  return out;
}

/** GraphQL answers 200 with `errors`: a query is a read, though it is a POST. */
export async function gql<T>(c: GitLabCreds, operationName: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await safeFetch({
    site: c.apiBase,
    network: networkOf(c.apiBase),
    url: graphqlUrl(c.apiBase),
    init: { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "PRIVATE-TOKEN": c.token }, body: JSON.stringify({ operationName, query, variables }) },
    intent: "read",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if (!res.ok) throw await refused(res);
  const body = (await res.json()) as { data?: T | null; errors?: { message?: string }[] };
  if (body.errors?.length && !body.data) throw new ProviderError("invalid", `GitLab: ${body.errors.map((e) => e.message ?? "error").join("; ")}`);
  if (!body.data) throw new ProviderError("incompatible", "GitLab: GraphQL answered neither data nor errors");
  return body.data;
}

/** gid://gitlab/Issue/42 */
export const gidOf = (type: "Issue" | "Project" | "Timelog" | "User", id: number | string) => `gid://gitlab/${type}/${id}`;
/** The number at the end of a global id. */
export const idOfGid = (gid: string) => /\/(\d+)$/.exec(gid)?.[1] ?? gid;

export const ISSUE_BY_ID = `query IssueById($id: IssueID!) { issue(id: $id) { id iid webUrl project { id fullPath } } }`;
const TIMELOG_FIELDS = `id spentAt timeSpent summary user { id username } issue { id iid webUrl project { id fullPath } }`;
export const ISSUE_TIMELOGS = `query IssueTimelogs($id: IssueID!, $after: String) { issue(id: $id) { timelogs(first: 100, after: $after) { nodes { ${TIMELOG_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
export const USER_TIMELOGS = `query UserTimelogs($username: String!, $startDate: Time!, $endDate: Time!, $after: String) { timelogs(username: $username, startDate: $startDate, endDate: $endDate, first: 100, after: $after) { nodes { ${TIMELOG_FIELDS} } pageInfo { hasNextPage endCursor } } }`;

export type GitLabTimelog = {
  id: string;
  /** ISO 8601 with an offset ("2026-10-14T08:30:00+00:00") */
  spentAt: string;
  /** Seconds */
  timeSpent: number;
  summary?: string | null;
  user: { id: string; username: string };
  issue: { id: string; iid: string; webUrl: string; project: { id: string; fullPath: string } } | null;
};
export type TimelogPage = { nodes: GitLabTimelog[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
