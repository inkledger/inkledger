// Trello's REST API (version 1), as the adapter needs it: every call through
// the shared safe fetch (read-only servers, redirects re-checked), the API key
// and the member's token in the Authorization header (Trello also takes them
// as query parameters, which would put the token in every URL and log), errors
// in the layer's words. Trello answers errors in plain text more often than in
// JSON, and uses 401 both for a bad token and for a card the token can't see.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";

export type TrelloCreds = {
  /** https://api.trello.com (the version goes in the path) */
  apiBase: string;
  key: string;
  token: string;
};

const trimmed = (apiBase: string) => apiBase.replace(/\/+$/, "");

/** The connection's secret holds both halves: "<api key>:<token>". */
export function splitSecret(secret: string): { key: string; token: string } | null {
  const at = secret.indexOf(":");
  const key = secret.slice(0, at).trim();
  const token = secret.slice(at + 1).trim();
  return at > 0 && /^[A-Za-z0-9]+$/.test(key) && /^[A-Za-z0-9_-]+$/.test(token) ? { key, token } : null;
}

export type TrelloMember = { id: string; username?: string; fullName?: string | null; avatarUrl?: string | null; email?: string | null };
export type TrelloLabel = { id: string; name?: string | null; color?: string | null };
export type TrelloList = { id: string; name: string; closed: boolean; pos: number; idBoard: string };
export type TrelloBoard = { id: string; name: string; shortLink: string; url: string; closed: boolean; lists?: TrelloList[] };

export type TrelloCard = {
  /** 24 hex characters; the first 8 are the creation time in seconds */
  id: string;
  /** The number on the board: changes when the card moves to another board */
  idShort: number;
  /** 8 characters, unique on the whole service, kept through every move */
  shortLink: string;
  shortUrl: string;
  url: string;
  name: string;
  desc?: string;
  /** Archived */
  closed: boolean;
  idList: string;
  idBoard: string;
  idMembers: string[];
  members?: TrelloMember[];
  labels?: TrelloLabel[];
  /** An instant (UTC), not a date */
  due?: string | null;
  dueComplete?: boolean;
  /** A date, stored as an instant */
  start?: string | null;
  dateLastActivity: string;
  subscribed?: boolean | null;
};

export type TrelloAction = {
  id: string;
  type: string;
  date: string;
  idMemberCreator: string;
  memberCreator?: TrelloMember | null;
  /** The member an action is about (added to a card, removed from it) */
  member?: TrelloMember | null;
  data: {
    text?: string;
    dateLastEdited?: string;
    card?: { id: string; shortLink?: string; idShort?: number; name?: string; desc?: string; due?: string | null; closed?: boolean; dueComplete?: boolean };
    board?: { id: string; name?: string; shortLink?: string };
    list?: { id: string; name: string };
    listBefore?: { id: string; name: string };
    listAfter?: { id: string; name: string };
    old?: { name?: string; desc?: string; due?: string | null; closed?: boolean; dueComplete?: boolean; idList?: string; pos?: number };
    idMember?: string;
    label?: { id: string; name?: string; color?: string };
  };
};

/** Fields asked of a card: everything RemoteIssue needs, nothing of its attachments or checklists. */
export const CARD_FIELDS = "name,desc,closed,idList,idBoard,idShort,shortLink,shortUrl,url,idMembers,labels,due,dueComplete,start,dateLastActivity,subscribed";

/** A Trello answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let text = "";
  try {
    text = (await res.text()).trim();
  } catch {
    // no body
  }
  let message = text.slice(0, 200) || `answered ${res.status}`;
  let code = "";
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") message = body.message;
    if (typeof body.error === "string") code = body.error;
  } catch {
    // plain text, as most Trello errors are ("invalid token", "The requested resource was not found.")
  }
  message = `Trello: ${message}`;
  if (res.status === 429 || /LIMIT_EXCEEDED/.test(code)) {
    // Two budgets (per token, per key), each with its window in ms: the empty one sets the wait.
    const budget = (which: "token" | "key") => ({
      interval: Number(res.headers.get(`x-rate-limit-api-${which}-interval-ms`)),
      remaining: Number(res.headers.get(`x-rate-limit-api-${which}-remaining`)),
    });
    const empty = [budget("token"), budget("key")].filter((b) => b.interval > 0 && b.remaining === 0);
    const waitMs = empty.length ? Math.max(...empty.map((b) => b.interval)) : 10_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0 } });
  }
  if (res.status === 401) {
    // "invalid token" / "invalid key" are the credentials; "unauthorized card permission requested" is one resource.
    return new ProviderError(/^unauthorized .*permission/i.test(text) ? "forbidden" : "auth", message, { status: 401 });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

/** Whether an error says "no such thing for you": gone, never existed, malformed id, or not visible to this token. */
export const isMissing = (e: unknown) =>
  e instanceof ProviderError && (e.kind === "notFound" || (e.kind === "forbidden" && e.status === 401) || (e.kind === "invalid" && e.status === 400 && /invalid id/i.test(e.message)));

type Call = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  /** Missing (see isMissing) as null */
  missingIsNull?: boolean;
  intent?: "read" | "write";
};

const authorization = (c: TrelloCreds) => `OAuth oauth_consumer_key="${c.key}", oauth_token="${c.token}"`;

/** One call. */
export async function tr<T>(c: TrelloCreds, path: string, call: Call = {}): Promise<{ data: T; headers: Headers } | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const url = `${trimmed(c.apiBase)}/1${path}${qs.size ? `?${qs.toString()}` : ""}`;
  const res = await safeFetch({
    site: c.apiBase,
    url,
    init: {
      method: call.method ?? "GET",
      headers: { Accept: "application/json", Authorization: authorization(c), ...(call.body ? { "Content-Type": "application/json" } : {}) },
      ...(call.body ? { body: JSON.stringify(call.body) } : {}),
    },
    ...(call.intent ? { intent: call.intent } : {}),
    network: "public",
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if (!res.ok) {
    const err = await refused(res);
    if (call.missingIsNull && isMissing(err)) return null;
    throw err;
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (cause) {
    throw new ProviderError("incompatible", "Trello: an answer that isn't JSON", { cause });
  }
  return { data, headers: res.headers };
}

/** A call that always answers. */
export async function trOk<T>(c: TrelloCreds, path: string, call: Call = {}): Promise<T> {
  const r = await tr<T>(c, path, call);
  if (!r) throw new ProviderError("notFound", `Trello: nothing at ${path}`);
  return r.data;
}

/** Actions are listed newest first, a page at a time, by `before` (the id of the last action seen). */
export async function trActions(c: TrelloCreds, path: string, query: Record<string, string>, maxPages = 50): Promise<TrelloAction[]> {
  const out: TrelloAction[] = [];
  const limit = 100;
  let before: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const page: TrelloAction[] = await trOk<TrelloAction[]>(c, path, { query: { ...query, limit, ...(before ? { before } : {}) } });
    out.push(...page);
    if (page.length < limit) break;
    before = page[page.length - 1].id;
  }
  return out;
}

/** The creation time inside a Trello id (its first 8 hex characters are seconds since the epoch), in ms; null when the id isn't one. */
export function createdAtOfId(id: string): number | null {
  return /^[0-9a-f]{24}$/.test(id) ? parseInt(id.slice(0, 8), 16) * 1000 : null;
}
