// Harvest's API v2 as the adapter needs it: every call through the shared safe
// fetch (read-only servers, redirects re-checked), a personal access token as
// a Bearer plus the account id in Harvest-Account-Id, a User-Agent (Harvest
// refuses calls without one), errors in the layer's words, pages by
// page/next_page. The budget is 100 requests per 15 seconds, then 429.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type HarvestCreds = {
  /** https://api.harvestapp.com/v2 */
  apiBase: string;
  token: string;
  /** The Harvest account the token is used on (a token can reach several) */
  accountId: string;
};

/** Harvest asks every client to say who it is, with a contact. */
export const USER_AGENT = "inkledger (https://github.com/inkledger/inkledger)";

export type HarvestUser = { id: number; first_name?: string; last_name?: string; email?: string; avatar_url?: string | null; timezone?: string; is_active?: boolean; is_contractor?: boolean };

export type HarvestCompany = {
  name?: string;
  /** Timestamp accounts keep a start and an end per entry; the others only the length */
  wants_timestamp_timers: boolean;
  time_format?: "decimal" | "hours_minutes";
  plan_type?: string;
};

export type HarvestExternalReference = { id: string; group_id?: string | null; account_id?: string | null; permalink?: string | null };

export type HarvestTimeEntry = {
  id: number;
  /** A date with no time and no zone */
  spent_date: string;
  /** Decimal hours; running timers show what has passed so far */
  hours: number;
  rounded_hours?: number;
  notes: string | null;
  is_locked: boolean;
  locked_reason?: string | null;
  /** Approved through Timesheet Approval */
  is_closed: boolean;
  /** Invoiced */
  is_billed: boolean;
  is_running: boolean;
  timer_started_at?: string | null;
  /** "8:30am", only on timestamp accounts */
  started_time?: string | null;
  ended_time?: string | null;
  billable: boolean;
  created_at: string;
  updated_at: string;
  user: { id: number; name?: string };
  project: { id: number; name: string; code?: string | null };
  task: { id: number; name: string };
  client?: { id: number; name: string } | null;
  external_reference?: HarvestExternalReference | null;
};

export type HarvestProjectAssignment = {
  id: number;
  is_active: boolean;
  project: { id: number; name: string; code?: string | null };
  client?: { id: number; name: string } | null;
  task_assignments: { id: number; is_active: boolean; billable?: boolean; task: { id: number; name: string } }[];
};

type Pager = { next_page: number | null };

/** A locked, approved or invoiced entry refuses changes with a plain 422. */
const LOCKED = /locked|closed|approved|invoice|billed/i;

/** A Harvest answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Harvest answered ${res.status}`;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: unknown; error_description?: unknown };
      if (typeof body.message === "string") message = `Harvest: ${body.message}`;
      else if (typeof body.error_description === "string") message = `Harvest: ${body.error_description}`;
      else if (typeof body.error === "string") message = `Harvest: ${body.error}`;
    } catch {
      if (text.trim()) message = `Harvest: ${text.trim().slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    // 100 calls per 15 seconds: without a header, wait out the window.
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 15_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Date.now() + waitMs } });
  }
  // A refusal to change what is locked is a conflict (read it again), not a malformed call.
  if (res.status === 422 && LOCKED.test(message)) return new ProviderError("conflict", message, { status: 422 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = RequestInit & {
  /** 404 as null (an entry that is gone) */
  missingIsNull?: boolean;
};

/** One call: the parsed answer, null for an accepted 404, undefined for an empty body. */
export async function hv<T>(c: HarvestCreds, path: string, init: Call = {}): Promise<T | null> {
  const { missingIsNull, ...rest } = init;
  const res = await safeFetch({
    site: c.apiBase,
    url: `${c.apiBase.replace(/\/+$/, "")}${path}`,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${c.token}`,
        "Harvest-Account-Id": c.accountId,
        "User-Agent": USER_AGENT,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if (res.status === 404 && missingIsNull) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  // DELETE answers 200 with nothing in it.
  const text = await res.text();
  return (text.trim() ? JSON.parse(text) : undefined) as T;
}

/** A call that always answers. */
export async function hvOk<T>(c: HarvestCreds, path: string, init: Call = {}): Promise<T> {
  const r = await hv<T>(c, path, init);
  if (r === null) throw new ProviderError("notFound", `Harvest: nothing at ${path}`);
  return r;
}

export const PER_PAGE = 100;

const withQuery = (path: string, params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const text = q.toString();
  return text ? `${path}${path.includes("?") ? "&" : "?"}${text}` : path;
};

/** One page of a list: `key` names the array in the answer; next is the following page number or null. */
export async function hvPage<T>(c: HarvestCreds, path: string, key: string, page: number, params: Record<string, string | number | undefined> = {}): Promise<{ items: T[]; next: number | null }> {
  const r = await hvOk<Record<string, unknown> & Pager>(c, withQuery(path, { ...params, page, per_page: PER_PAGE }));
  const items = r[key];
  if (!Array.isArray(items)) throw new ProviderError("incompatible", `Harvest: no "${key}" list in the answer`);
  return { items: items as T[], next: typeof r.next_page === "number" ? r.next_page : null };
}

/** Every page of a list (bounded: 50 pages of 100). */
export async function hvPages<T>(c: HarvestCreds, path: string, key: string, params: Record<string, string | number | undefined> = {}, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let page: number | null = 1;
  for (let n = 0; page !== null && n < maxPages; n++) {
    const r: { items: T[]; next: number | null } = await hvPage<T>(c, path, key, page, params);
    out.push(...r.items);
    page = r.next;
  }
  return out;
}
