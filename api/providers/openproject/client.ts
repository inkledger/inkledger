// OpenProject's API v3 (HAL+JSON), as the adapter needs it: every call through
// the shared safe fetch (read-only servers, redirects re-checked), errors in
// the layer's words. Written from the API's documentation, not yet run on a
// real server (SPIKES.md, "OpenProject"). Traps this file answers:
// - the personal token is sent as Basic auth with the user name `apikey`;
// - collections page by `offset`, which is a PAGE NUMBER from 1 (not a row
//   offset), and `pageSize` is cut to the server's cap: the answer says the
//   size it really used, and `total` says when to stop;
// - `filters` and `sortBy` are JSON in the query string; without `filters` a
//   work package list silently keeps only the open ones;
// - links are relative paths (`/api/v3/users/5`, with the context path of a
//   sub-URI install in front): ids are read off their tail;
// - errors are HAL `Error` objects; a validation failure (422) lists the
//   attributes at fault in `_embedded.errors`.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";
import type { Network } from "../../lib/security";

export type OpenProjectCreds = {
  /** The service root with or without /api/v3: https://op.example.com, https://host/openproject */
  apiBase: string;
  /** A personal API token (My account, Access tokens) */
  token: string;
};

/** The REST root for a configured base: /api/v3 appended once. */
export const apiRootOf = (base: string) => {
  const b = base.trim().replace(/\/+$/, "");
  return /\/api\/v3$/.test(b) ? b : `${b}/api/v3`;
};
/** The web site for a base: where people see work packages (no /api/v3). */
export const webBaseOf = (base: string) => apiRootOf(base).replace(/\/api\/v3$/, "");

/** OpenProject's own cloud is on the internet; any other server is the user's, maybe on their network. */
export function networkOf(base: string): Network {
  try {
    return /(^|\.)openproject\.com$/i.test(new URL(base).hostname) ? "public" : "private";
  } catch {
    return "public";
  }
}

export type Link = { href: string | null; title?: string; method?: string; templated?: boolean };
export type Formatted = { format?: string; raw?: string | null; html?: string | null };

export type OpUser = { _type?: string; id: number; name?: string; login?: string | null; email?: string | null; avatar?: string | null; status?: string };
export type OpStatus = { id: number; name: string; isClosed?: boolean; isDefault?: boolean; isReadonly?: boolean; position?: number; color?: string };
export type OpProject = { id: number; identifier?: string; name?: string };
export type OpType = { id: number; name: string; isMilestone?: boolean };
export type OpPriority = { id: number; name: string; position?: number };
export type OpWorkPackage = {
  id: number;
  lockVersion: number;
  subject: string;
  description?: Formatted | null;
  startDate?: string | null;
  dueDate?: string | null;
  /** ISO 8601 duration */
  estimatedTime?: string | null;
  /** Present only with the right to see time entries */
  spentTime?: string | null;
  createdAt?: string;
  updatedAt?: string;
  _embedded?: { project?: OpProject; status?: OpStatus; type?: OpType; priority?: OpPriority; author?: OpUser; assignee?: OpUser | null };
  _links: { self?: Link; project?: Link; status?: Link; type?: Link; priority?: Link; author?: Link; assignee?: Link; parent?: Link; [k: string]: Link | undefined };
};
export type OpActivity = {
  _type?: string;
  id: number;
  version?: number;
  comment?: Formatted | null;
  details?: Formatted[];
  createdAt?: string;
  updatedAt?: string;
  _embedded?: { user?: OpUser };
  _links: { user?: Link };
};
export type OpTimeEntry = {
  id: number;
  comment?: Formatted | null;
  /** A plain date: no time, no zone */
  spentOn: string;
  /** ISO 8601 duration */
  hours: string | null;
  ongoing?: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** When the server keeps one (the catalogue's revision): sent back on a change */
  lockVersion?: number;
  _links: { workPackage?: Link; project?: Link; user?: Link; activity?: Link; update?: Link; updateImmediately?: Link; delete?: Link };
};
export type OpActivityType = { id: number; name: string; position?: number; default?: boolean };
export type OpNotification = {
  id: number;
  reason: string;
  readIAN: boolean;
  createdAt?: string;
  updatedAt?: string;
  _links: { resource?: Link; actor?: Link };
};

/** The number at the end of a link (`/api/v3/users/5`), as text. */
export const idOfHref = (href: string | null | undefined) => (href ? /\/(\d+)\/?$/.exec(href)?.[1] ?? null : null);
/** The path of an API resource, for a link in a body. */
export const hrefOf = (path: string) => `/api/v3${path}`;

/** A refused answer as a ProviderError: the HAL error's message and the attributes it objects to; a spent budget is a wait. */
async function refused(res: Response): Promise<ProviderError> {
  let message = `OpenProject answered ${res.status}`;
  let fields: Record<string, string> | undefined;
  try {
    const body = (await res.json()) as {
      message?: string;
      _embedded?: { details?: { attribute?: string }; errors?: { message?: string; _embedded?: { details?: { attribute?: string } } }[] };
    };
    if (body.message) message = `OpenProject: ${body.message}`;
    const errors = body._embedded?.errors ?? [];
    if (errors.length > 0) {
      fields = {};
      for (const e of errors) {
        const attribute = e._embedded?.details?.attribute;
        if (attribute && e.message) fields[attribute] = e.message;
      }
      if (Object.keys(fields).length === 0) fields = undefined;
      message = `OpenProject: ${errors.map((e) => e.message).filter(Boolean).join("; ") || body.message || message}`;
    } else if (body._embedded?.details?.attribute && body.message) {
      fields = { [body._embedded.details.attribute]: body.message };
    }
  } catch {
    // no JSON body
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    const secs = Number(retry);
    const date = retry && !Number.isFinite(secs) ? Date.parse(retry) : NaN;
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const remaining = res.headers.get("x-ratelimit-remaining");
    // Retry-After in seconds or a date; else the reset (epoch seconds); else a minute.
    const waitMs =
      Number.isFinite(secs) && secs > 0 ? secs * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
    return new ProviderError("rateLimit", message, {
      status: 429,
      rateLimit: { retryAfterMs: waitMs, ...(remaining !== null && Number.isFinite(Number(remaining)) ? { remaining: Number(remaining) } : {}), ...(Number.isFinite(reset) && reset > 0 ? { resetAt: reset * 1000 } : {}) },
    });
  }
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status, ...(fields ? { fields } : {}) });
}

type Call = RequestInit & {
  /** 404/410 as null (not there, or not visible: OpenProject answers 404 for both) */
  missingIsNull?: boolean;
  intent?: "read" | "write";
};

/** One call. */
export async function op<T>(c: OpenProjectCreds, path: string, init: Call = {}): Promise<T | null> {
  const root = apiRootOf(c.apiBase);
  const { missingIsNull, intent, ...rest } = init;
  const res = await safeFetch({
    site: root,
    url: `${root}${path}`,
    init: {
      ...rest,
      headers: {
        Accept: "application/hal+json",
        Authorization: `Basic ${Buffer.from(`apikey:${c.token}`, "utf8").toString("base64")}`,
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    },
    ...(intent ? { intent } : {}),
    network: networkOf(c.apiBase),
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 || res.status === 410) && missingIsNull) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) throw await refused(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A call that always answers. */
export async function opOk<T>(c: OpenProjectCreds, path: string, init: Call = {}): Promise<T> {
  const r = await op<T>(c, path, init);
  if (r === null) throw new ProviderError("notFound", `OpenProject: nothing at ${path}`);
  return r;
}

export type Collection<T> = { total: number; count: number; pageSize: number; offset: number; elements: T[] };
type RawCollection<T> = { total?: number; count?: number; pageSize?: number; offset?: number; _embedded?: { elements?: T[] } };

const withQuery = (path: string, query: string) => `${path}${path.includes("?") ? "&" : "?"}${query}`;

/** One page of a collection; `page` counts from 1. */
export async function pageOf<T>(c: OpenProjectCreds, path: string, page: number, pageSize: number, opts: { missingIsNull?: boolean } = {}): Promise<Collection<T> | null> {
  const raw = await op<RawCollection<T>>(c, withQuery(path, `pageSize=${pageSize}&offset=${page}`), opts);
  if (raw === null) return null;
  const elements = raw._embedded?.elements ?? [];
  // The size the server used (it may cap what was asked) is what the next offset is counted in.
  return { total: raw.total ?? elements.length, count: raw.count ?? elements.length, pageSize: raw.pageSize ?? pageSize, offset: raw.offset ?? page, elements };
}

/** True when the page just read was the last one. */
export const lastPage = (p: Collection<unknown>, page: number) => p.count === 0 || (page - 1) * p.pageSize + p.count >= p.total;

/** Every page of a list, until `total` is read; bounded. */
export async function allPages<T>(c: OpenProjectCreds, path: string, opts: { pageSize?: number; maxPages?: number; missingIsNull?: boolean } = {}): Promise<T[] | null> {
  const out: T[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 50); page++) {
    const p = await pageOf<T>(c, path, page, opts.pageSize ?? 100, { missingIsNull: opts.missingIsNull });
    if (p === null) return null;
    out.push(...p.elements);
    if (lastPage(p, page)) return out;
  }
  return out;
}

export type Filter = Record<string, { operator: string; values: string[] | null }>;
/** `filters=` and `sortBy=` for a query string. */
export const filtersQuery = (filters: Filter[]) => `filters=${encodeURIComponent(JSON.stringify(filters))}`;
export const sortQuery = (sort: [string, "asc" | "desc"][]) => `sortBy=${encodeURIComponent(JSON.stringify(sort))}`;

/** One value a form allows: its id and name, and the resource itself when the form embedded it. */
export type Allowed<T> = { id: string; name: string; value?: T };

/**
 * The `allowedValues` of a form property: resources embedded in the schema, or
 * links (id and title only), or one link to a collection to read.
 */
export async function allowedValues<T extends { id: number; name: string }>(
  c: OpenProjectCreds,
  prop: { _embedded?: { allowedValues?: T[] }; _links?: { allowedValues?: Link | Link[] } } | undefined,
): Promise<Allowed<T>[]> {
  const embedded = prop?._embedded?.allowedValues;
  if (embedded) return embedded.map((v) => ({ id: String(v.id), name: v.name, value: v }));
  const links = prop?._links?.allowedValues;
  if (Array.isArray(links)) return links.flatMap((l) => (idOfHref(l.href) ? [{ id: idOfHref(l.href)!, name: l.title ?? "" }] : []));
  if (!links?.href) return [];
  // The link is relative to the host (with the context path in it): keep what comes after /api/v3.
  return ((await allPages<T>(c, links.href.replace(/^.*?\/api\/v3/, ""))) ?? []).map((v) => ({ id: String(v.id), name: v.name, value: v }));
}
