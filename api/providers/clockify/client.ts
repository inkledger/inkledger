// Clockify's REST API v1 as the sink needs it: every call through the shared
// safe fetch, the personal API key in X-Api-Key (Profile settings → API),
// errors in the layer's words, pages by page / page-size.
import { ProviderError, kindOfStatus, type ProviderErrorKind } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type ClockifyCreds = {
  /** https://api.clockify.me/api/v1 */
  apiBase: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

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
  let message = `Clockify answered ${res.status}`;
  let said = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown; code?: unknown };
      if (typeof body.message === "string") message = `Clockify: ${(said = body.message)}`;
    } catch {
      if (text.trim()) message = `Clockify: ${(said = text.trim().slice(0, 200))}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    // The budget is per second: without a header, a second.
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : 1000, remaining: 0 } });
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
  const res = await safeFetch({
    site: c.apiBase,
    url: path.startsWith("http") ? path : `${trimmed(c.apiBase)}${path}`,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        "X-Api-Key": c.token,
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
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  return { data, headers: res.headers };
}

/** A call that always answers. */
export async function cfOk<T>(c: ClockifyCreds, path: string, init: Call = {}): Promise<T> {
  const r = await cf<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Clockify: nothing at ${path}`);
  return r.data;
}

/** Entries are asked for this many a page (the API's own maximum is 1000). */
export const PAGE_SIZE = 200;

/**
 * Every page of a list (bounded). The API says nothing of the total: a page
 * shorter than the size is the last, so an exact multiple costs one empty
 * request more.
 */
export async function cfPages<T>(c: ClockifyCreds, path: string, o: { pageSize?: number; maxPages?: number } = {}): Promise<T[]> {
  const size = o.pageSize ?? PAGE_SIZE;
  const out: T[] = [];
  for (let page = 1; page <= (o.maxPages ?? 100); page++) {
    const rows = await cfOk<T[]>(c, `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ page: String(page), "page-size": String(size) }).toString()}`);
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}
