// Everhour's REST API as the time sink needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), the personal API key in
// X-Api-Key, errors in the layer's words, lists paged by `page` and `limit`.
// Dates are plain days (YYYY-MM-DD, the user's own), times whole seconds.
import { ProviderError, kindOfStatus, mustAnswer, readRefusal, retryAfterMs } from "../core/errors";
import { jsonCall, trimTrailingSlash } from "../core/http";
import { collectPages } from "../core/paging";

type EverhourCreds = {
  /** The API root: https://api.everhour.com */
  apiBase: string;
  token: string;
};


/** Everhour versions its API by header; 1.2 is the one the documentation describes. */
const API_VERSION = "1.2";
/** A page of a list: the documented maximum is not known, so a modest one. */
export const PAGE_SIZE = 200;

export type EverhourUser = { id: number; name?: string | null; email?: string | null; headline?: string | null; avatarUrl?: string | null; role?: string; status?: string };

/** A task as a time record names it: its id is the integration's prefix and the tracker's id ("ji:10001"). */
export type EverhourTaskRef = { id: string; name?: string; number?: string; url?: string };

/** One user's time on one task on one day. */
export type EverhourTimeRecord = {
  /** A plain day, no time and no zone */
  date: string;
  /** Seconds */
  time: number;
  user: number;
  task?: EverhourTaskRef;
  comment?: string | null;
  /** The period is locked (a locked timesheet, approved time) */
  locked?: boolean;
  history?: { id?: number; time?: number; previousTime?: number; createdAt?: string }[];
};

export type EverhourTimer = { status: "active" | "stopped"; duration?: number; startedAt?: string; task?: EverhourTaskRef; user?: { id: number } };

/** An Everhour answer refused, as a ProviderError (a rate limit with when to retry; a locked period as a conflict). */
async function refused(res: Response): Promise<ProviderError> {
  const { message } = await readRefusal<{ message?: unknown; error?: unknown }>(res, "Everhour", (body) =>
    typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : undefined,
  );
  if (res.status === 429) {
    // The documented limit is 20 requests per 10 seconds per key: a short wait if none is said.
    const waitMs = retryAfterMs(res.headers, 10_000);
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0 } });
  }
  // A locked timesheet or approved time is refused with 403: a lock, not a missing permission.
  if (res.status === 403 && /\block(ed)?\b|\bapproved\b|\bclosed\b/i.test(message)) return new ProviderError("conflict", message, { status: 403 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = RequestInit & {
  /** 404 as null (a task Everhour doesn't have) */
  missingIsNull?: boolean;
  intent?: "read" | "write";
};

/** One call. */
export async function eh<T>(c: EverhourCreds, path: string, init: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const { missingIsNull, intent, ...rest } = init;
  const res = await jsonCall({
    site: c.apiBase,
    url: `${trimTrailingSlash(c.apiBase)}${path}`,
    init: rest,
    headers: { "X-Api-Key": c.token, "X-Accept-Version": API_VERSION },
    intent,
    missing: missingIsNull ? [404] : [],
    refused,
  });
  if (!res) return null;
  const text = res.status === 204 ? "" : await res.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

/** A call that always answers. */
export const ehOk = <T>(c: EverhourCreds, path: string, init: Call = {}): Promise<T> => mustAnswer(eh<T>(c, path, init), "Everhour", path);

/** Every page of a list (bounded: 50 pages), until one comes back empty (a service may cap `limit` below what was asked, so a short page isn't the end). */
export function ehPages<T>(c: EverhourCreds, path: string, maxPages = 50): Promise<T[]> {
  return collectPages<T, number>(
    1,
    async (page) => {
      const q = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(page) });
      const rows = await ehOk<T[]>(c, `${path}${path.includes("?") ? "&" : "?"}${q.toString()}`);
      return { rows, next: rows.length === 0 ? null : page + 1 };
    },
    maxPages,
    () => new ProviderError("incompatible", `Everhour: ${path} has more than ${maxPages} pages`),
  );
}
