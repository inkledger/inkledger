// Linear's GraphQL API, as the adapter needs it: every call through the
// shared safe fetch (read-only servers, redirects re-checked), errors in the
// layer's words. Linear's traps live here: failures that arrive as HTTP 200
// with an `errors` array, rate limits that arrive as HTTP 400 (RATELIMITED),
// a personal key sent as is while an OAuth token needs Bearer, cursors
// instead of pages.
import { ProviderError, kindOfStatus, type RateLimit } from "../core/errors";
import { safeFetch } from "../core/http";

export type LinearCreds = {
  /** The API root, https://api.linear.app (the /graphql path is added here) */
  apiBase: string;
  token: string;
  /** An OAuth access token (Bearer) rather than a personal API key (sent as is) */
  oauth: boolean;
};

/** Where a pass or list is in a Relay connection. */
export type PageInfo = { hasNextPage: boolean; endCursor: string | null };
export type Connection<T> = { nodes: T[]; pageInfo: PageInfo };

export type LinearUser = { id: string; name: string; displayName?: string | null; email?: string | null; avatarUrl?: string | null };
export type LinearStateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
export type LinearState = { id: string; name: string; type: LinearStateType; color?: string | null; position?: number | null };
export type LinearTeam = { id: string; key: string; name: string };
export type LinearIssue = {
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low */
  priority: number;
  /** Points on the team's scale, not time */
  estimate?: number | null;
  /** A date without a zone (YYYY-MM-DD) */
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  trashed?: boolean | null;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  state: LinearState;
  team: LinearTeam;
  assignee?: LinearUser | null;
  creator?: LinearUser | null;
  parent?: { id: string; identifier: string } | null;
  labels?: Connection<{ name: string }> | null;
};
export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Null for a comment written by an integration */
  user?: LinearUser | null;
  botActor?: { id?: string | null; name?: string | null; avatarUrl?: string | null } | null;
};

/** Fields of an issue every list and lookup reads (labels capped: a nested connection weighs on the complexity budget). */
export const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id identifier number title url priority estimate dueDate createdAt updatedAt archivedAt trashed startedAt completedAt canceledAt
  state { id name type color position }
  team { id key name }
  assignee { id name displayName email avatarUrl }
  creator { id name displayName email avatarUrl }
  parent { id identifier }
  labels(first: 20) { nodes { name } }
}`;

type GraphQLError = { message?: string; extensions?: { type?: string; code?: string; userError?: boolean } };
type Answer<T> = { data?: T | null; errors?: GraphQLError[] };

/** A moment from a header: Linear counts in epoch seconds (milliseconds tolerated). */
const resetMs = (h: string | null): number | undefined => {
  const n = Number(h);
  if (!h || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
};

/** What the rate-limit headers say: requests and complexity are two budgets; the exhausted one sets the wait. */
export function rateLimitOf(headers: Headers): RateLimit {
  const num = (name: string) => {
    const n = Number(headers.get(name));
    return headers.get(name) !== null && Number.isFinite(n) ? n : undefined;
  };
  const reqLeft = num("x-ratelimit-requests-remaining");
  const cxLeft = num("x-ratelimit-complexity-remaining");
  const reqReset = resetMs(headers.get("x-ratelimit-requests-reset"));
  const cxReset = resetMs(headers.get("x-ratelimit-complexity-reset"));
  const spent = [reqLeft === 0 ? reqReset : undefined, cxLeft === 0 ? cxReset : undefined].filter((n): n is number => n !== undefined);
  const retryAfter = Number(headers.get("retry-after"));
  const resetAt = spent.length ? Math.max(...spent) : (reqReset ?? cxReset);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : resetAt ? Math.max(0, resetAt - Date.now()) : 60_000;
  const remaining = reqLeft ?? cxLeft;
  return { retryAfterMs, ...(remaining !== undefined ? { remaining } : {}), ...(resetAt ? { resetAt } : {}) };
}

/** An answer refused, as a ProviderError. */
function refused(status: number, headers: Headers, body: Answer<unknown> | null): ProviderError {
  const first = body?.errors?.[0];
  const type = (first?.extensions?.type ?? "").toLowerCase();
  const code = first?.extensions?.code ?? "";
  const message = `Linear: ${first?.message ?? `answered ${status}`}`;
  // A spent budget answers 400 with RATELIMITED (or 429): a wait, not a refusal.
  if (status === 429 || code === "RATELIMITED" || type === "ratelimited") return new ProviderError("rateLimit", message, { status, rateLimit: rateLimitOf(headers) });
  if (status === 401 || type === "authentication error" || code === "AUTHENTICATION_ERROR") return new ProviderError("auth", message, { status });
  if (status === 403 || type === "forbidden" || code === "FORBIDDEN") return new ProviderError("forbidden", message, { status });
  if (/entity not found/i.test(first?.message ?? "")) return new ProviderError("notFound", message, { status });
  if (status >= 500) return new ProviderError("unavailable", message, { status });
  return new ProviderError(status === 404 ? "notFound" : kindOfStatus(status === 200 ? 400 : status), message, { status });
}

/** One operation; the data, and the headers (budgets) it came with. `missingIsNull`: "Entity not found" as null data. */
export async function gqlRaw<T>(c: LinearCreds, operationName: string, query: string, variables: Record<string, unknown> = {}, o: { write?: boolean; missingIsNull?: boolean } = {}): Promise<{ data: T | null; headers: Headers }> {
  const site = c.apiBase.replace(/\/+$/, "").replace(/\/graphql$/, "");
  const res = await safeFetch({
    site,
    url: `${site}/graphql`,
    // Every GraphQL call is a POST: reads say so, or a read-only server would refuse them all.
    intent: o.write ? "write" : "read",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A personal API key goes as is; "Bearer" is for OAuth tokens only.
        Authorization: c.oauth ? `Bearer ${c.token}` : c.token,
      },
      body: JSON.stringify({ operationName, query, variables }),
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  let body: Answer<T> | null = null;
  try {
    body = (await res.json()) as Answer<T>;
  } catch {
    // no JSON body
  }
  if (body?.errors?.length || !res.ok) {
    const err = refused(res.status, res.headers, body);
    if (err.kind === "notFound" && o.missingIsNull) return { data: null, headers: res.headers };
    throw err;
  }
  if (!body || body.data === undefined) throw new ProviderError("incompatible", "Linear answered without data", { status: res.status });
  return { data: body.data, headers: res.headers };
}

/** A call that always answers with data. */
export async function gql<T>(c: LinearCreds, operationName: string, query: string, variables: Record<string, unknown> = {}, o: { write?: boolean } = {}): Promise<T> {
  const r = await gqlRaw<T>(c, operationName, query, variables, o);
  if (r.data === null) throw new ProviderError("notFound", `Linear: nothing for ${operationName}`);
  return r.data;
}

/** Every node of a connection, following cursors (bounded: 50 pages). */
export async function allNodes<T>(read: (after: string | null) => Promise<Connection<T>>): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let n = 0; n < 50; n++) {
    const page: Connection<T> = await read(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}
