// Clockify's REST API v1 as the sink needs it: every call through the shared
// safe fetch, the personal API key in X-Api-Key (Profile settings → API),
// errors in the layer's words, pages by page / page-size.
import { ProviderError, kindOfStatus, mustAnswer, readRefusal, retryAfterMs, type ProviderErrorKind } from "../core/errors";
import { jsonCall, trimTrailingSlash } from "../core/http";
import { collectPages } from "../core/paging";

export type ClockifyCreds = {
  /** https://api.clockify.me/api/v1 */
  apiBase: string;
  token: string;
};


export type ClockifyUser = {
  id: string;
  email?: string | null;
  name?: string | null;
  profilePicture?: string | null;
  activeWorkspace?: string | null;
  defaultWorkspace?: string | null;
  settings?: { timeZone?: string | null } | null;
};

export type ClockifyWorkspace = { id: string; name: string };
export type ClockifyProject = { id: string; name: string; clientName?: string | null; archived?: boolean; billable?: boolean; workspaceId?: string };
export type ClockifyTask = { id: string; name: string; projectId: string; status?: "ACTIVE" | "DONE" };

/** An entry as the API prints it: instants in UTC to the second, the duration as ISO 8601 ("PT1H30M"), `end` null while a timer runs. */
export type ClockifyEntry = {
  id: string;
  description?: string | null;
  userId: string;
  billable?: boolean | null;
  projectId?: string | null;
  taskId?: string | null;
  workspaceId?: string;
  tagIds?: string[] | null;
  timeInterval: { start: string; end?: string | null; duration?: string | null };
  isLocked?: boolean | null;
};

export type ClockifyApproval = {
  id: string;
  owner?: { userId?: string };
  status?: { state?: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN_SUBMISSION" | "WITHDRAWN_APPROVAL" };
  dateRange?: { start: string; end: string };
};

/** Locked and approved entries answer with the reason in the message, under a 400 or a 403. */
const LOCKED = /lock|approved|submitted|closed period/i;

/** A Clockify answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  const { message, said } = await readRefusal<{ message?: unknown; code?: unknown }>(res, "Clockify", (body) => (typeof body.message === "string" ? body.message : undefined));
  if (res.status === 429) {
    // The budget is per second: without a header, a second.
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: retryAfterMs(res.headers, 1000), remaining: 0 } });
  }
  const kind: ProviderErrorKind = (res.status === 400 || res.status === 403) && LOCKED.test(said) ? "conflict" : kindOfStatus(res.status);
  return new ProviderError(kind, message, { status: res.status });
}

type Call = RequestInit & {
  /** 404 as null (an entry that is not there) */
  missingIsNull?: boolean;
};

/** One call. */
export async function cf<T>(c: ClockifyCreds, path: string, init: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const { missingIsNull, ...rest } = init;
  const res = await jsonCall({
    site: c.apiBase,
    url: path.startsWith("http") ? path : `${trimTrailingSlash(c.apiBase)}${path}`,
    init: rest,
    headers: { "X-Api-Key": c.token },
    missing: missingIsNull ? [404] : [],
    refused,
  });
  if (!res) return null;
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  return { data, headers: res.headers };
}

/** A call that always answers. */
export const cfOk = <T>(c: ClockifyCreds, path: string, init: Call = {}): Promise<T> => mustAnswer(cf<T>(c, path, init), "Clockify", path);

/** Entries are asked for this many a page (the API's own maximum is 1000). */
export const PAGE_SIZE = 200;

/**
 * Every page of a list (bounded). The API says nothing of the total: a page
 * shorter than the size is the last, so an exact multiple costs one empty
 * request more.
 */
export function cfPages<T>(c: ClockifyCreds, path: string, o: { pageSize?: number; maxPages?: number } = {}): Promise<T[]> {
  const size = o.pageSize ?? PAGE_SIZE;
  return collectPages<T, number>(
    1,
    async (page) => {
      const rows = await cfOk<T[]>(c, `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ page: String(page), "page-size": String(size) }).toString()}`);
      return { rows, next: rows.length < size ? null : page + 1 };
    },
    o.maxPages ?? 100,
  );
}
