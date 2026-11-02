// Basecamp 3/4's API, as the adapter needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), the OAuth token pasted
// by the user as a Bearer, a User-Agent with a contact (Basecamp refuses calls
// without one), errors in the layer's words, pages by the Link header.
// Basecamp is a hosted service only, so every call goes to the public internet.
// An account's API lives under https://3.basecampapi.com/<account id>.
import { ProviderError, kindOfStatus, mustAnswer, readRefusal, retryAfterMs } from "../core/errors";
import { GONE, jsonCall, trimTrailingSlash } from "../core/http";
import { collectPages } from "../core/paging";

/** Where the accounts of a token are listed (a different host from the API). */
export const LAUNCHPAD = "https://launchpad.37signals.com";
const USER_AGENT = "inkledger (https://github.com/inkledger/inkledger)";

export type BcCreds = {
  /** The account's API root: https://3.basecampapi.com/<account id> */
  apiBase: string;
  token: string;
};


/** The web site of an API host (links): 3.basecampapi.com -> 3.basecamp.com. */
export const webHostOf = (apiBase: string) => new URL(apiBase).host.replace(/basecampapi\.com$/, "basecamp.com");

export type BcPerson = { id: number; name?: string | null; email_address?: string | null; avatar_url?: string | null };
type BcRef = { id: number; title?: string | null; name?: string | null; type?: string; app_url?: string | null };

/** A to-do, or a card of a card table: both are "recordings" in a project (the bucket). */
export type BcRecording = {
  id: number;
  /** active | archived | trashed: a trashed recording is still answered, with this status */
  status: "active" | "archived" | "trashed";
  created_at: string;
  /** With the account's own UTC offset (2026-10-21T10:00:00.000+02:00), not in UTC */
  updated_at: string;
  type: string;
  /** A card's title; a to-do's title is its content */
  title?: string | null;
  /** A to-do's title (plain text); a card's body (HTML) */
  content?: string | null;
  /** A to-do's body (HTML) */
  description?: string | null;
  app_url: string;
  completed?: boolean;
  /** A plain date */
  due_on?: string | null;
  starts_on?: string | null;
  assignees?: BcPerson[];
  creator?: BcPerson | null;
  bucket: BcRef;
  /** A to-do's list, or a card's column */
  parent?: BcRef | null;
  completion?: { created_at?: string | null } | null;
};

export type BcColumn = { id: number; title: string; type: string };
export type BcCardTable = { id: number; title?: string; lists: BcColumn[] };
export type BcProject = { id: number; name: string; status?: string; dock?: { id: number; name: string; enabled?: boolean }[] };
export type BcAssignment = { id: number; type: string; bucket: BcRef; completed?: boolean };
export type BcAssignments = { priorities?: BcAssignment[]; non_priorities?: BcAssignment[] };
export type BcComment = { id: number; content: string; created_at: string; updated_at?: string | null; creator?: BcPerson | null };
export type BcEvent = { id: number; action: string; created_at: string; creator?: BcPerson | null; details?: { added_person_ids?: number[]; removed_person_ids?: number[]; notified_recipient_ids?: number[] } | null };
export type BcEntry = {
  id: number;
  status?: string;
  /** A plain date, in the account's zone */
  date: string;
  /** A decimal string with two digits ("1.33"), or "H:MM" */
  hours: string;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  person?: BcPerson | null;
  creator?: BcPerson | null;
  parent?: BcRef | null;
  bucket?: BcRef | null;
};
export type BcAccount = { product: string; id: number; name?: string; href?: string };
export type BcAuthorization = { identity?: { id: number; email_address?: string }; accounts?: BcAccount[] };

/** A Basecamp answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  const { message } = await readRefusal<{ error?: unknown; errors?: unknown }>(res, "Basecamp", (body) => {
    const said = typeof body.error === "string" ? body.error : Array.isArray(body.errors) ? body.errors.filter((e): e is string => typeof e === "string").join("; ") : "";
    return said || undefined;
  });
  if (res.status === 429) {
    // 50 requests per 10 seconds per IP; Retry-After is in seconds.
    const waitMs = retryAfterMs(res.headers, 10_000);
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0, resetAt: Date.now() + waitMs } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = {
  method?: string;
  json?: unknown;
  /** 404 (and 410) as null: a record that is not there */
  missingIsNull?: boolean;
  /** Another host than the account's (the launchpad) */
  site?: string;
};

export type Answer<T> = { data: T; next: string | null; total: number | null };

/** The next page's address, only when it is on the same server (a Link is data from the network). */
function nextOf(res: Response, apiBase: string): string | null {
  const m = /<([^>]+)>\s*;\s*rel="next"/i.exec(res.headers.get("link") ?? "");
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[1], apiBase);
  } catch {
    throw new ProviderError("incompatible", "Basecamp: a next page that is not an address");
  }
  if (url.origin !== new URL(apiBase).origin) throw new ProviderError("incompatible", "Basecamp: a next page on another server");
  return url.toString();
}

/** One call. `path` is under the account (/projects.json) or a full address already on the server (a next page). */
export async function bc<T>(c: BcCreds, path: string, init: Call = {}): Promise<Answer<T> | null> {
  const site = init.site ?? c.apiBase;
  const url = /^https?:\/\//.test(path) ? path : `${trimTrailingSlash(site)}${path}`;
  // A full address (a next page, kept in a page token) is only ever followed on the server itself, with the token.
  if (new URL(url).origin !== new URL(site).origin) throw new ProviderError("incompatible", "Basecamp: an address on another server");
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const res = await jsonCall({
    site,
    url,
    init: { method: init.method ?? "GET", ...(body ? { body, headers: { "Content-Type": "application/json; charset=utf-8" } } : {}) },
    headers: { Authorization: `Bearer ${c.token}`, "User-Agent": USER_AGENT },
    missing: init.missingIsNull ? GONE : [],
    refused,
  });
  if (!res) return null;
  const next = init.site ? null : nextOf(res, c.apiBase);
  const total = Number(res.headers.get("x-total-count"));
  if (res.status === 204 || res.headers.get("content-length") === "0") return { data: undefined as T, next, total: Number.isFinite(total) && total > 0 ? total : null };
  return { data: (await res.json()) as T, next, total: Number.isFinite(total) && total > 0 ? total : null };
}

/** A call that always answers. */
export const bcOk = <T>(c: BcCreds, path: string, init: Call = {}): Promise<T> => mustAnswer(bc<T>(c, path, init), "Basecamp", path);

export const joined = (path: string, params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).flatMap(([k, v]): [string, string][] => (v === undefined ? [] : [[k, String(v)]])));
  const text = q.toString();
  return text ? `${path}${path.includes("?") ? "&" : "?"}${text}` : path;
};

/** Every page of a list (bounded: 100 pages). */
export function bcPages<T>(c: BcCreds, path: string, maxPages = 100): Promise<T[]> {
  return collectPages<T, string>(
    path,
    async (at) => {
      const r = await bc<T[]>(c, at);
      return { rows: r?.data ?? [], next: r?.next || null };
    },
    maxPages,
  );
}
