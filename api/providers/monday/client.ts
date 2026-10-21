// monday.com's GraphQL API (v2), as the adapter needs it: every call through
// the shared safe fetch, errors in the layer's words. monday's traps live
// here: failures that arrive as HTTP 200 with an `errors` array (and, on
// older paths, a flat {error_code, error_message}), a complexity budget that
// is a wait and not a refusal, a personal token sent as is while an OAuth
// token needs Bearer, an API-Version header that pins the schema, ids that
// are strings in GraphQL and numbers inside column values, cursors that
// expire, and page numbers for boards, updates and activity logs.
import { ProviderError, kindOfStatus, type RateLimit } from "../core/errors";
import { safeFetch } from "../core/http";

/** The schema version asked for (monday keeps each for about a year); a request without the header gets the "current" one, which moves. */
export const API_VERSION = "2025-07";

export type MondayCreds = {
  /** The API endpoint, https://api.monday.com/v2 (GraphQL is the only thing there) */
  apiBase: string;
  token: string;
  /** An OAuth access token (Bearer) rather than a personal API token (sent as is) */
  oauth: boolean;
};

export type MondayUser = { id: string; name: string; email?: string | null; photo_thumb_small?: string | null };
export type MondayColumn = { id: string; title: string; type: string; settings_str?: string | null };
/** "board" is a normal board; a subitems board is hidden and holds the subitems of another; a document is a doc, with no items. */
export type MondayBoardType = "board" | "sub_items_board" | "document";
export type MondayBoard = {
  id: string;
  name: string;
  type?: MondayBoardType | null;
  /** The main workspace has no id and no name here */
  workspace?: { id: string | null; name: string | null } | null;
  columns: MondayColumn[];
};
export type MondayColumnValue = {
  id: string;
  type: string;
  /** What the cell shows, as text */
  text?: string | null;
  /** The cell's JSON, as a string (null for an empty cell) */
  value?: string | null;
};
export type MondayItem = {
  id: string;
  name: string;
  /** deleted items still answer by id */
  state: "active" | "archived" | "deleted";
  url: string;
  created_at: string;
  updated_at: string;
  creator?: MondayUser | null;
  board?: MondayBoard | null;
  group?: { id: string; title: string } | null;
  parent_item?: { id: string; board?: { id: string } | null } | null;
  column_values: MondayColumnValue[];
};
export type MondayUpdate = {
  id: string;
  body: string;
  text_body?: string | null;
  created_at: string;
  updated_at: string;
  creator?: MondayUser | null;
  replies?: MondayUpdate[] | null;
};
export type MondayActivity = {
  id: string;
  event: string;
  /** JSON, as a string */
  data: string;
  /** 17 digits: a Unix time in tenths of a microsecond, as a string */
  created_at: string;
  user_id?: string | null;
};

const USER_FIELDS = "id name email photo_thumb_small";

/** Fields of an item every list and lookup reads. */
export const ITEM_FIELDS = `fragment ItemFields on Item {
  id name state url created_at updated_at
  creator { ${USER_FIELDS} }
  board { id name type workspace { id name } columns { id title type settings_str } }
  group { id title }
  parent_item { id board { id } }
  column_values { id type text value }
}`;

export const UPDATE_FIELDS = `id body text_body created_at updated_at creator { ${USER_FIELDS} }`;

type GraphQLError = { message?: string; extensions?: { code?: string; status_code?: number; retry_in_seconds?: number } };
/** Both shapes monday answers failures in: the GraphQL one, and the flat one of older paths. */
type Answer<T> = { data?: T | null; errors?: GraphQLError[]; error_code?: string; error_message?: string; status_code?: number; account_id?: number };

/** What a refusal says: code and message, whichever shape it came in. */
function describe(body: Answer<unknown> | null): { code: string; message: string; retryIn?: number } {
  const first = body?.errors?.[0];
  return { code: first?.extensions?.code ?? body?.error_code ?? "", message: first?.message ?? body?.error_message ?? "", retryIn: first?.extensions?.retry_in_seconds };
}

const NOT_FOUND = new Set(["ResourceNotFoundException", "InvalidBoardIdException", "InvalidItemIdException", "ItemNotFound"]);
const INVALID = new Set(["InvalidArgumentException", "InvalidColumnIdException", "ColumnValueException", "CreateBoardException", "maxComplexityExceeded", "ComplexityException", "argumentLiteralsIncompatible", "missingRequiredArguments", "undefinedField"]);
const RATE = new Set(["COMPLEXITY_BUDGET_EXHAUSTED", "RateLimitExceeded", "DAILY_LIMIT_EXCEEDED", "IP_RATE_LIMIT_EXCEEDED", "Rate Limit Exceeded"]);

/** The wait a rate-limit answer asks for: monday's `retry_in_seconds`, else Retry-After, else a minute (a daily limit: until the day resets, an hour at least). */
export function rateLimitOf(headers: Headers, retryIn: number | undefined, code: string): RateLimit {
  const after = Number(headers.get("retry-after"));
  const secs = retryIn !== undefined && retryIn > 0 ? retryIn : Number.isFinite(after) && after > 0 ? after : undefined;
  const retryAfterMs = secs !== undefined ? secs * 1000 : code === "DAILY_LIMIT_EXCEEDED" ? 3_600_000 : 60_000;
  return { retryAfterMs, remaining: 0, resetAt: Date.now() + retryAfterMs };
}

/** An answer refused, as a ProviderError. */
function refused(status: number, headers: Headers, body: Answer<unknown> | null): ProviderError {
  const { code, message: said, retryIn } = describe(body);
  const message = `monday: ${said || `answered ${status}`}`;
  if (status === 429 || RATE.has(code)) return new ProviderError("rateLimit", message, { status, rateLimit: rateLimitOf(headers, retryIn, code) });
  // A bad token is a 401 (or "Not Authenticated"); the same exception name on a mutation is a missing permission.
  if (status === 401 || /not authenticated/i.test(said)) return new ProviderError("auth", message, { status });
  if (code === "UserUnauthorizedException" || status === 403) return new ProviderError("forbidden", message, { status });
  if (/cursor/i.test(code) || /cursor.*(invalid|expired)/i.test(said)) return new ProviderError("invalidCheckpoint", message, { status });
  if (NOT_FOUND.has(code) || status === 404) return new ProviderError("notFound", message, { status });
  if (INVALID.has(code)) return new ProviderError("invalid", message, { status });
  if (status >= 500) return new ProviderError("unavailable", message, { status });
  return new ProviderError(kindOfStatus(status === 200 ? 400 : status), message, { status });
}

/** One operation; the data, and the headers it came with. `missingIsNull`: a not-found answer as null data. */
export async function gqlRaw<T>(c: MondayCreds, operationName: string, query: string, variables: Record<string, unknown> = {}, o: { write?: boolean; missingIsNull?: boolean } = {}): Promise<{ data: T | null; headers: Headers }> {
  const url = c.apiBase.replace(/\/+$/, "");
  const res = await safeFetch({
    site: url,
    url,
    // Every GraphQL call is a POST: reads say so, or a read-only server would refuse them all.
    intent: o.write ? "write" : "read",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A personal token goes as is; "Bearer" is for OAuth tokens.
        Authorization: c.oauth ? `Bearer ${c.token}` : c.token,
        "API-Version": API_VERSION,
      },
      body: JSON.stringify({ operationName, query, variables }),
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  let body: Answer<T> | null = null;
  try {
    body = (await res.json()) as Answer<T>;
  } catch {
    // no JSON body (a gateway's page)
  }
  if (body?.errors?.length || body?.error_code || !res.ok) {
    const err = refused(res.status, res.headers, body);
    if (err.kind === "notFound" && o.missingIsNull) return { data: null, headers: res.headers };
    throw err;
  }
  if (!body || body.data === undefined) throw new ProviderError("incompatible", "monday answered without data", { status: res.status });
  return { data: body.data, headers: res.headers };
}

/** A call that always answers with data. */
export async function gql<T>(c: MondayCreds, operationName: string, query: string, variables: Record<string, unknown> = {}, o: { write?: boolean } = {}): Promise<T> {
  const r = await gqlRaw<T>(c, operationName, query, variables, o);
  if (r.data === null) throw new ProviderError("notFound", `monday: nothing for ${operationName}`);
  return r.data;
}

/** Every item of a page-numbered list (boards, updates, activity logs), until a short page (bounded). */
export async function allPages<T>(size: number, read: (page: number) => Promise<T[]>, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const got = await read(page);
    out.push(...got);
    if (got.length < size) break;
  }
  return out;
}

/** An activity log's time: 17 digits, tenths of a microsecond since the epoch (never milliseconds or ISO). */
export function activityMs(created: string): number | null {
  if (!/^\d{16,18}$/.test(created)) return null;
  return Math.floor(Number(created) / 10_000);
}
