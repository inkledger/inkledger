// Toggl Track's API v9, as the adapter needs it: every call through the shared
// safe fetch, the personal API token as Basic auth (`<token>:api_token`),
// errors in the layer's words. Toggl is a hosted service only. Every request
// counts against a per-hour quota (30 on the free plan): the adapter makes as
// few as it can, and a refusal over the quota waits for the quota to reset.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody, trimTrailingSlash } from "../core/http";

export type TogglCreds = {
  /** The API root: https://api.track.toggl.com/api/v9 */
  apiBase: string;
  token: string;
};


/** `<token>:api_token` in Basic auth, as Toggl documents for personal tokens. */
export const basicAuth = (token: string) => `Basic ${Buffer.from(`${token}:api_token`).toString("base64")}`;

export type TogglMe = { id: number; email?: string | null; fullname?: string | null; default_workspace_id?: number | null; timezone?: string | null; image_url?: string | null };

export type TogglWorkspace = { id: number; name: string; premium?: boolean; organization_id?: number };

export type TogglProject = { id: number; workspace_id: number; name: string; active: boolean; client_id?: number | null };

/** A time entry. `duration` is seconds, negative while a timer runs (minus its start as a Unix timestamp), and `stop` is then null. */
export type TogglEntry = {
  id: number;
  workspace_id: number;
  project_id: number | null;
  task_id: number | null;
  billable: boolean;
  /** RFC 3339 */
  start: string;
  stop: string | null;
  duration: number;
  description: string | null;
  tags?: string[] | null;
  user_id?: number;
  uid?: number;
  /** When it last changed */
  at: string;
  /** Set on an entry deleted since the `since` of a feed */
  server_deleted_at?: string | null;
};

/** The answer to a bulk PATCH: ids done, and ids refused with why. */
export type TogglPatchResult = { success?: number[] | null; failure?: { id: number; message: string }[] | null };

const HOUR_MS = 3_600_000;

/** How long Toggl says to wait: Retry-After, or when its hourly quota resets (header, or "in N seconds" in the text). */
function waitMs(headers: Headers, said: string, fallbackMs: number): number {
  const retry = Number(headers.get("retry-after"));
  if (retry > 0) return retry * 1000;
  const resets = Number(headers.get("x-toggl-quota-resets-in"));
  if (resets > 0) return resets * 1000;
  const inText = /(\d+)\s*seconds?/i.exec(said);
  return inText ? Number(inText[1]) * 1000 : fallbackMs;
}

/** A Toggl answer refused, as a ProviderError. */
async function refused(res: Response): Promise<ProviderError> {
  let said = "";
  try {
    said = (await res.text()).trim();
  } catch {
    // no body
  }
  try {
    // Errors come as plain text, a JSON string, or { message }.
    const body: unknown = JSON.parse(said);
    if (typeof body === "string") said = body;
    else if (body && typeof body === "object") {
      const o = body as { message?: unknown; error?: unknown };
      if (typeof o.message === "string") said = o.message;
      else if (typeof o.error === "string") said = o.error;
    }
  } catch {
    // plain text
  }
  const message = `Toggl: ${said.slice(0, 300) || `answered ${res.status}`}`;
  const overQuota = res.headers.get("x-toggl-quota-remaining") === "0" || /hourly limit|rate limit|quota|too many requests/i.test(said);
  // 402 is "Payment Required": the quota on the free plan, but also a feature the plan lacks (tasks): only the first is a wait.
  if (res.status === 429 || (res.status === 402 && overQuota)) {
    const wait = waitMs(res.headers, said, res.status === 402 ? HOUR_MS : 60_000);
    return new ProviderError("rateLimit", message, { status: res.status, rateLimit: { retryAfterMs: wait, remaining: 0, resetAt: Date.now() + wait } });
  }
  if (res.status === 402) return new ProviderError("forbidden", message, { status: 402 });
  if (res.status === 403) {
    // Wrong credentials answer 403, not 401; a locked period answers 403 with its reason.
    if (!said || /incorrect username|password|api token|credentials|not authorized/i.test(said)) return new ProviderError("auth", message, { status: 403 });
    if (/lock/i.test(said)) return new ProviderError("conflict", message, { status: 403 });
    return new ProviderError("forbidden", message, { status: 403 });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: string;
  data?: unknown;
  /** 404 as null (an entry that isn't there) */
  missingIsNull?: boolean;
};

/** One call. The answer may be JSON `null` (Toggl answers an empty project list with it) or empty (a delete). */
export async function toggl<T>(c: TogglCreds, path: string, init: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const body = init.data === undefined ? undefined : JSON.stringify(init.data);
  const res = await safeFetch({
    site: c.apiBase,
    url: `${trimTrailingSlash(c.apiBase)}${path}`,
    init: {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", Authorization: basicAuth(c.token), ...(body ? { "Content-Type": "application/json" } : {}) },
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
  const text = (await res.text()).trim();
  return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

/** A call that always answers. */
export async function togglOk<T>(c: TogglCreds, path: string, init: Call = {}): Promise<T> {
  const r = await toggl<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Toggl: nothing at ${path}`);
  return r.data;
}

/** A path with a query string (undefined values left out). */
export function withQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
  const text = q.toString();
  return text ? `${path}?${text}` : path;
}
