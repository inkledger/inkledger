// YouTrack's REST API, as the adapter needs it: every call through the shared
// safe fetch (read-only servers, redirects re-checked), errors in the layer's
// words. Written from the API's documentation, not yet run on a real account
// (docs/dev/spikes.md, "YouTrack"). Traps this file answers:
// - without `fields` YouTrack answers only ids: every call names its fields;
// - lists are cut by `$top` (default 42, a server cap below what was asked) and
//   have no Link header or total: pages by `$skip`, ending on an empty page;
// - timestamps are epoch milliseconds, users' avatars may be relative paths.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, discardBody } from "../core/http";

export type YouTrackCreds = {
  /** The service root, with or without /api: https://x.youtrack.cloud, https://host/youtrack/api */
  apiBase: string;
  /** A permanent token (perm:...) */
  token: string;
};

/** The REST root for a configured base: /api appended once. */
export const apiRootOf = (base: string) => {
  const b = base.trim().replace(/\/+$/, "");
  return /\/api$/.test(b) ? b : `${b}/api`;
};
/** The web site for a base: where people see issues (no /api). */
export const webBaseOf = (base: string) => apiRootOf(base).replace(/\/api$/, "");

export type YtUser = { id: string; login?: string; name?: string; fullName?: string; email?: string; avatarUrl?: string | null; guest?: boolean };
/** A value of a custom field: a bundle element, a user, a period, a date (ms), text or a list of them. */
export type YtFieldValue = {
  $type?: string;
  id?: string;
  name?: string;
  login?: string;
  fullName?: string;
  avatarUrl?: string | null;
  isResolved?: boolean;
  ordinal?: number;
  minutes?: number;
  presentation?: string;
  text?: string;
};
export type YtBundleValue = { id: string; name: string; isResolved?: boolean; ordinal?: number };
export type YtCustomField = {
  $type: string;
  name: string;
  value?: YtFieldValue | YtFieldValue[] | number | string | null;
  /** State-machine fields: the events that can be sent now */
  possibleEvents?: { id: string; presentation?: string }[];
  projectCustomField?: { id?: string; bundle?: { values?: YtBundleValue[] } };
};
export type YtIssue = {
  id: string;
  idReadable: string;
  summary?: string;
  description?: string | null;
  created?: number;
  updated?: number;
  resolved?: number | null;
  project?: { id: string; shortName: string; name?: string };
  reporter?: YtUser | null;
  tags?: { id?: string; name: string }[];
  customFields?: YtCustomField[];
};
export type YtComment = { id: string; text?: string | null; author?: YtUser | null; created?: number; updated?: number; deleted?: boolean };
export type YtWorkItem = {
  id: string;
  /** The work date: a timestamp at 00:00 UTC of the day */
  date?: number;
  duration?: { minutes?: number; presentation?: string };
  text?: string | null;
  author?: YtUser | null;
  creator?: YtUser | null;
  created?: number;
  updated?: number;
  type?: { id: string; name?: string } | null;
  issue?: { id: string; idReadable?: string };
};
export type YtActivity = {
  id: string;
  timestamp: number;
  author?: YtUser | null;
  category?: { id: string };
  /** customField.fieldType.id is the field's kind, "state[1]" for the State (its name is localized) */
  field?: { id?: string; name?: string; customField?: { fieldType?: { id?: string } | null } | null } | null;
  added?: unknown;
  removed?: unknown;
};

const USER_FIELDS = "id,login,name,fullName,email,avatarUrl,guest";
const PERSON = "id,login,fullName,avatarUrl";
export const FIELDS = {
  user: USER_FIELDS,
  issue:
    `id,idReadable,summary,created,updated,resolved,project(id,shortName,name),reporter(${PERSON}),tags(id,name),` +
    `customFields($type,name,value($type,id,name,login,fullName,avatarUrl,isResolved,ordinal,minutes,presentation),possibleEvents(id,presentation),projectCustomField(id,bundle(values(id,name,isResolved,ordinal))))`,
  description: "id,description",
  comment: `id,text,created,updated,deleted,author(${PERSON})`,
  workItem: `id,date,duration(minutes),text,created,updated,author(${PERSON}),type(id,name),issue(id,idReadable)`,
  activity: "id,timestamp,category(id),field(id,name,customField(fieldType(id))),author(id,login,fullName),added(id,name,login,fullName,presentation,text),removed(id,name,login,fullName,presentation,text)",
};

/** A refused answer as a ProviderError: YouTrack explains in error_description; a spent quota is a wait. */
async function refused(res: Response): Promise<ProviderError> {
  let message = `YouTrack answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    const why = body.error_description ?? body.error;
    if (why) message = `YouTrack: ${why}`;
  } catch {
    // no JSON body
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    const secs = Number(retry);
    const at = retry && !Number.isFinite(secs) ? Date.parse(retry) : NaN;
    const waitMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : Number.isFinite(at) ? Math.max(0, at - Date.now()) : 30_000;
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, ...(Number.isFinite(remaining) && res.headers.has("x-ratelimit-remaining") ? { remaining } : {}) } });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

/** YouTrack Cloud (*.youtrack.cloud, *.myjetbrains.com) is on the internet and never reaches private addresses; a self-hosted server may be on the user's own network. */
const networkOf = (base: string) => {
  const h = new URL(base).hostname.toLowerCase();
  return /\.(youtrack\.cloud|myjetbrains\.com)$/.test(h) ? ("public" as const) : ("private" as const);
};

/** One call; 404/410 as null when `missingIsNull`. */
export async function yt<T>(c: YouTrackCreds, path: string, init: RequestInit & { missingIsNull?: boolean } = {}): Promise<T | null> {
  const root = apiRootOf(c.apiBase);
  const { missingIsNull, ...rest } = init;
  const res = await safeFetch({
    site: root,
    network: networkOf(root),
    url: `${root}${path}`,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${c.token}`,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && missingIsNull) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A call that always answers. */
export async function ytOk<T>(c: YouTrackCreds, path: string, init: RequestInit = {}): Promise<T> {
  const r = await yt<T>(c, path, init);
  if (r === null) throw new ProviderError("notFound", `YouTrack: nothing at ${path}`);
  return r;
}

/** `path` with the paging parameters added (path may already have a query string). */
export const paged = (path: string, top: number, skip: number) => `${path}${path.includes("?") ? "&" : "?"}$top=${top}&$skip=${skip}`;

/** Every page of a list, `$skip` by what came back (a server may cut pages below `$top`), ending on an empty page; bounded. */
export async function allPages<T>(c: YouTrackCreds, path: string, opts: { top?: number; maxPages?: number; missingIsNull?: boolean } = {}): Promise<T[] | null> {
  const top = opts.top ?? 100;
  const out: T[] = [];
  let skip = 0;
  for (let n = 0; n < (opts.maxPages ?? 100); n++) {
    const page = await yt<T[]>(c, paged(path, top, skip), { missingIsNull: opts.missingIsNull });
    if (page === null) return null;
    if (page.length === 0) return out;
    out.push(...page);
    skip += page.length;
  }
  return out;
}
