// Microsoft Graph v1.0 (Planner), as the adapter needs it: every call through
// the shared safe fetch (read-only servers, redirects re-checked), the access
// token as a Bearer, errors in the layer's words, lists by @odata.nextLink.
// Graph is a hosted service only, so every call goes to the public internet.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";

export type PlannerCreds = {
  /** The API root: https://graph.microsoft.com/v1.0 */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

/** Where Planner's pages open (links): not on Graph's host. */
export const WEB_BASE = "https://planner.cloud.microsoft";

export type GraphUser = { id: string; displayName?: string | null; mail?: string | null; userPrincipalName?: string | null };

export type PlannerTask = {
  id: string;
  /** The revision, to send back as If-Match: changes with every change of the task */
  "@odata.etag"?: string;
  planId: string;
  bucketId?: string | null;
  title: string;
  /** 0 not started, 50 in progress, 100 completed: the only values the apps use, any 0-100 is accepted */
  percentComplete: number;
  /** 0-10: 0-1 urgent, 2-4 important, 5-7 medium, 8-10 low */
  priority?: number;
  /** A UTC instant: the apps store a picked day as that day at midnight UTC */
  startDateTime?: string | null;
  dueDateTime?: string | null;
  createdDateTime?: string | null;
  completedDateTime?: string | null;
  createdBy?: { user?: { id?: string | null } | null } | null;
  /** Keyed by user id */
  assignments?: Record<string, unknown>;
  /** { category1: true, … }: names live in the plan's details */
  appliedCategories?: Record<string, boolean>;
  hasDescription?: boolean;
};

export type PlannerDetails = { id: string; description?: string | null; "@odata.etag"?: string };
export type PlannerPlan = { id: string; title?: string | null; owner?: string | null };
export type PlannerBucket = { id: string; name: string; planId: string; orderHint?: string };
export type PlannerPlanDetails = { id: string; categoryDescriptions?: Record<string, string | null> };

/** A Graph answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Microsoft Graph answered ${res.status}`;
  let code = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === "string") code = body.error.code;
      if (typeof body.error?.message === "string" && body.error.message) message = `Microsoft Graph: ${body.error.message}`;
    } catch {
      if (text.trim()) message = `Microsoft Graph: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429 || ((res.status === 503 || res.status === 504) && res.headers.has("retry-after"))) {
    // Retry-After in seconds; none: wait a while, as Graph asks for a back-off.
    const seconds = Number(res.headers.get("retry-after"));
    const waitMs = seconds > 0 ? seconds * 1000 : 30_000;
    return new ProviderError("rateLimit", message, { status: res.status, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Date.now() + waitMs } });
  }
  // A skip token Graph no longer takes: read the pass again.
  if (res.status === 400 && /skiptoken/i.test(`${code} ${message}`)) return new ProviderError("invalidCheckpoint", message, { status: 400 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: string;
  body?: unknown;
  /** Sent as If-Match: Planner refuses a change without the revision it was read at */
  etag?: string;
  /** Prefer: return=representation, or a change answers 204 with nothing */
  representation?: boolean;
  /** 404/410 as null (a task that is not there, or was deleted) */
  missingIsNull?: boolean;
};

export type Answer<T> = { data: T; next: string | null };

/** One call; `path` is relative to the API root, or an absolute @odata.nextLink of the same origin. */
export async function graph<T>(c: PlannerCreds, path: string, init: Call = {}): Promise<Answer<T> | null> {
  const base = trimmed(c.apiBase);
  let url = `${base}${path}`;
  if (/^https?:\/\//i.test(path)) {
    // A next link on another origin would carry the token there.
    if (new URL(path).origin !== new URL(base).origin) throw new ProviderError("incompatible", "Microsoft Graph: a next link to another host");
    url = path;
  }
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  const res = await safeFetch({
    site: c.apiBase,
    url,
    init: {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${c.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(init.etag ? { "If-Match": init.etag } : {}),
        ...(init.representation ? { Prefer: "return=representation" } : {}),
      },
      ...(body ? { body } : {}),
    },
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && init.missingIsNull) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) throw await refused(res);
  if (res.status === 204) return { data: undefined as T, next: null };
  const json = (await res.json()) as { value?: unknown; "@odata.nextLink"?: string };
  // A list is { value: [...] }; a single record is the record itself.
  return { data: (Array.isArray(json.value) ? json.value : json) as T, next: json["@odata.nextLink"] ?? null };
}

/** A call that always answers. */
export async function graphOk<T>(c: PlannerCreds, path: string, init: Call = {}): Promise<T> {
  const r = await graph<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Microsoft Graph: nothing at ${path}`);
  return r.data;
}

/** One page of a list, and the link of the next. */
export const graphPage = <T>(c: PlannerCreds, path: string): Promise<Answer<T[]> | null> => graph<T[]>(c, path);

/** Every page of a list (bounded). */
export async function graphPages<T>(c: PlannerCreds, path: string, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let n = 0; n < maxPages && next; n++) {
    const r: Answer<T[]> | null = await graph<T[]>(c, next);
    out.push(...(r?.data ?? []));
    next = r?.next ?? null;
  }
  return out;
}
