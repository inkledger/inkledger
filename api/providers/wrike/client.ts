// Wrike's REST API v4, as the adapter needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), the permanent token as
// a bearer, errors in the layer's words, lists by `nextPageToken`. Wrike is a
// hosted service only (one API host per data center), so every call goes to
// the public internet.
//
// Wrike's habits: every answer is { kind, data: [...] }, even for one record;
// the values of a filter or of `fields` are JSON in the query string; writes
// are form-encoded; ids are long strings, and the number in a task's link is
// another id (the "API v2" one) that /ids converts.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";

export type WrikeCreds = {
  /** The API root of the account's data center: https://www.wrike.com/api/v4 */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

/** The web site for an API root (links): the same host without /api/v4. */
export const webBaseOf = (apiBase: string) => trimmed(apiBase).replace(/\/api\/v4$/, "");

/** A task comes with a small set of fields; the rest is asked for by name. */
export const TASK_FIELDS = ["parentIds", "superTaskIds", "responsibleIds", "authorIds", "effortAllocation"] as const;

export type WrikeGroup = "Active" | "Completed" | "Deferred" | "Cancelled";

export type WrikeTask = {
  /** The API id: stable, 16 letters and digits. The number in the task's link is not it. */
  id: string;
  accountId?: string;
  title: string;
  status: WrikeGroup;
  /** The custom status within the task's workflow; its group is `status` */
  customStatusId?: string;
  importance?: "High" | "Normal" | "Low";
  createdDate: string;
  updatedDate: string;
  completedDate?: string | null;
  /** Floating local times, no zone: "2026-11-05T17:00:00" */
  dates?: { type?: string; start?: string; due?: string; duration?: number } | null;
  /** WsTask, or RbTask when the task is in the recycle bin (it still answers) */
  scope?: "WsTask" | "RbTask";
  permalink: string;
  description?: string;
  parentIds?: string[];
  superTaskIds?: string[];
  responsibleIds?: string[];
  authorIds?: string[];
  followerIds?: string[];
  /** Minutes */
  effortAllocation?: { totalEffort?: number | null } | null;
};

export type WrikeContact = {
  id: string;
  firstName?: string;
  lastName?: string;
  type?: string;
  avatarUrl?: string | null;
  deleted?: boolean;
  profiles?: { accountId?: string; email?: string; role?: string }[];
};

export type WrikeFolder = { id: string; title: string; scope?: string; project?: Record<string, unknown> | null };

export type WrikeCustomStatus = { id: string; name: string; group: WrikeGroup; hidden?: boolean; standard?: boolean; color?: string };
export type WrikeWorkflow = { id: string; name: string; hidden?: boolean; customStatuses: WrikeCustomStatus[] };

export type WrikeComment = { id: string; authorId: string; text: string; createdDate: string; updatedDate?: string; taskId?: string };

export type WrikeTimelog = {
  id: string;
  taskId: string;
  userId: string;
  categoryId?: string | null;
  billingType?: "Billable" | "NonBillable";
  /** Decimal hours */
  hours: number;
  /** A day, in no zone */
  trackedDate: string;
  createdDate?: string;
  updatedDate?: string;
  comment?: string;
  approvalStatus?: "Draft" | "Pending" | "Approved" | "Rejected";
};

export type WrikeCategory = { id: string; name: string; hidden?: boolean };

/** A Wrike answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Wrike answered ${res.status}`;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { error?: unknown; errorDescription?: unknown };
      const said = [body.error, body.errorDescription].filter((v): v is string => typeof v === "string" && v !== "");
      if (said.length) message = `Wrike: ${said.join(": ")}`;
    } catch {
      if (text.trim()) message = `Wrike: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    // Retry-After in seconds; Wrike limits per minute and per token, so a minute is the fallback.
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 60_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Date.now() + waitMs } });
  }
  // A page token Wrike no longer takes: read the pass again.
  if (res.status === 400 && /nextPageToken/i.test(message)) return new ProviderError("invalidCheckpoint", message, { status: 400 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: string;
  /** Query parameters; a list or an object is written as JSON, as Wrike reads it */
  query?: Record<string, unknown>;
  /** The same kinds of values, form-encoded in the body */
  form?: Record<string, unknown>;
  /** 404/410 as null (a task that is not there) */
  missingIsNull?: boolean;
};

export type Answer<T> = { data: T[]; next: string | null };

const asText = (v: unknown): string => (typeof v === "number" || typeof v === "boolean" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v));
const encoded = (p: Record<string, unknown>) => new URLSearchParams(Object.entries(p).flatMap(([k, v]): [string, string][] => (v === undefined || v === null ? [] : [[k, asText(v)]]))).toString();

/** One call. */
export async function wrike<T>(c: WrikeCreds, path: string, init: Call = {}): Promise<Answer<T> | null> {
  const q = init.query ? encoded(init.query) : "";
  const body = init.form ? encoded(init.form) : undefined;
  const res = await safeFetch({
    site: c.apiBase,
    url: `${trimmed(c.apiBase)}${path}${q ? `?${q}` : ""}`,
    init: {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", Authorization: `bearer ${c.token}`, ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      ...(body !== undefined ? { body } : {}),
    },
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && init.missingIsNull) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) throw await refused(res);
  const json = (await res.json()) as { data?: T[]; nextPageToken?: string };
  if (!Array.isArray(json.data)) throw new ProviderError("incompatible", "Wrike: an answer with no data list");
  return { data: json.data, next: json.nextPageToken ?? null };
}

/** A call that always answers, with its list. */
export async function wrikeList<T>(c: WrikeCreds, path: string, init: Call = {}): Promise<T[]> {
  const r = await wrike<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Wrike: nothing at ${path}`);
  return r.data;
}

/** A call for one record (Wrike answers a list of one). */
export async function wrikeOne<T>(c: WrikeCreds, path: string, init: Call = {}): Promise<T> {
  const [one] = await wrikeList<T>(c, path, init);
  if (one === undefined) throw new ProviderError("notFound", `Wrike: nothing at ${path}`);
  return one;
}

/** A date-time as Wrike's filters take it: UTC, whole seconds (milliseconds are refused). */
export const wrikeInstant = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Records by id, at most a hundred ids to a call; the ones Wrike doesn't give back are absent. */
export async function wrikeByIds<T>(c: WrikeCreds, path: string, ids: string[], query: Record<string, unknown> = {}): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const r = await wrike<T>(c, `${path}/${unique.slice(i, i + 100).map(encodeURIComponent).join(",")}`, { query, missingIsNull: true });
    out.push(...(r?.data ?? []));
  }
  return out;
}
