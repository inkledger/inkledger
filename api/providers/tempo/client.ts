// Tempo's REST API v4 (Tempo Cloud, for Jira), as the adapter needs it: every
// call through the shared safe fetch (read-only servers, redirects re-checked,
// network "public"), the personal API token as a Bearer token, errors in the
// layer's words. Written from Tempo's documentation, not yet run on a real
// account (SPIKES.md). Traps this file answers:
// - lists answer { metadata: { count, offset, limit, next? }, results }: `next` is a full URL, followed only on the API's own origin (the token travels with it);
// - `limit` tops out at 1000 and a larger one is a 400, not a cap;
// - errors are { errors: [{ message }] }, a 400 even for a worklog in an approved period (told apart by its message: "forbidden");
// - a worklog has two ids (tempoWorklogId, the one every Tempo call takes, and jiraWorklogId, its mirror in Jira): never mixed;
// - the limit answers 429, with Retry-After when the plan sends it.
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch } from "../core/http";
import type { TimeZone } from "@contracts/values";

export type TempoCreds = {
  /** The API root: https://api.tempo.io/4 */
  apiBase: string;
  /** A personal API token (Tempo → Settings → API integration) */
  token: string;
};

const trimmed = (apiBase: string) => apiBase.trim().replace(/\/+$/, "");

/** limit tops out at 1000; a bigger one is refused. */
export const PER_PAGE = 1000;

export type TempoAttributeValue = { key: string; value: string };

/** A worklog as Tempo answers it. */
export type TempoWorklog = {
  self?: string;
  /** The id every Tempo call takes */
  tempoWorklogId: number;
  /** Its mirror in Jira's own worklogs: another number, never accepted by Tempo's calls */
  jiraWorklogId?: number | null;
  issue?: { self?: string; id: number } | null;
  timeSpentSeconds: number;
  billableSeconds?: number | null;
  /** A plain date, in the user's own zone */
  startDate: string;
  /** "HH:mm:ss", in the user's own zone */
  startTime?: string | null;
  description?: string | null;
  /** UTC, "2026-10-14T08:30:00Z" */
  createdAt?: string;
  updatedAt?: string;
  author: { self?: string; accountId: string };
  attributes?: { self?: string; values: TempoAttributeValue[] };
};

export type TempoList<T> = { self?: string; metadata: { count: number; offset: number; limit: number; next?: string | null; previous?: string | null }; results: T[] };

/** A work attribute (work type…): STATIC_LIST ones are what inkledger calls an activity. */
export type TempoWorkAttribute = {
  self?: string;
  key: string;
  name: string;
  type: "STATIC_LIST" | "INPUT_FIELD" | "INPUT_NUMERIC" | "CHECKBOX" | "ACCOUNT" | "CATEGORY";
  required?: boolean;
  /** The values of a static list */
  values?: string[];
  /** A value's display name, by value */
  names?: Record<string, string>;
};

/** A timesheet approval period of a user. */
export type TempoApproval = {
  self?: string;
  user?: { accountId: string };
  period: { from: string; to: string };
  /** OPEN, IN_REVIEW (WAITING_FOR_APPROVAL), APPROVED */
  status: { key: string };
};

const LOCKED = /approved|locked|closed period|submitted/i;

/** A refused answer as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Tempo answered ${res.status}`;
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { errors?: { message?: unknown }[]; message?: unknown };
      const messages = (body.errors ?? []).map((e) => e.message).filter((m): m is string => typeof m === "string");
      if (messages.length > 0) message = `Tempo: ${messages.join("; ")}`;
      else if (typeof body.message === "string") message = `Tempo: ${body.message}`;
    } catch {
      const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (plain) message = `Tempo: ${plain.slice(0, 200)}`;
    }
  } catch {
    // no body
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    const secs = Number(retry);
    const at = retry && !Number.isFinite(secs) ? Date.parse(retry) : NaN;
    const waitMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : Number.isFinite(at) ? Math.max(0, at - Date.now()) : 60_000;
    return new ProviderError("rateLimit", message, { status: 429, rateLimit: { retryAfterMs: waitMs, remaining: 0 } });
  }
  // A worklog in an approved (or otherwise locked) period is a 400 whose message says so: not the user's typo, a lock.
  if (res.status === 400 && LOCKED.test(message)) return new ProviderError("forbidden", message, { status: 400 });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

type Call = Omit<RequestInit, "body"> & {
  /** Sent as JSON */
  data?: unknown;
  /** 404 as null (a worklog that isn't there) */
  missingIsNull?: boolean;
  /** 403 and 404 as null (a feature the plan doesn't include) */
  absentIsNull?: boolean;
};

/** One call; `data` is undefined for an answer with no body (204). */
export async function tp<T>(c: TempoCreds, path: string, init: Call = {}): Promise<{ data: T } | null> {
  const { data, missingIsNull, absentIsNull, ...rest } = init;
  const base = trimmed(c.apiBase);
  const url = path.startsWith("http") ? path : `${base}${path}`;
  // A "next" link is followed on the API's own origin only.
  if (new URL(url).origin !== new URL(base).origin) throw new ProviderError("incompatible", "Tempo: a link to another site");
  const res = await safeFetch({
    site: c.apiBase,
    url,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${c.token}`,
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  if ((res.status === 404 && (missingIsNull || absentIsNull)) || (res.status === 403 && absentIsNull)) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) throw await refused(res);
  if (res.status === 204) return { data: undefined as T };
  const text = await res.text();
  if (!text.trim()) return { data: undefined as T };
  try {
    return { data: JSON.parse(text) as T };
  } catch (cause) {
    throw new ProviderError("incompatible", "Tempo answered something that is not JSON", { cause });
  }
}

/** A call that always answers. */
export async function tpOk<T>(c: TempoCreds, path: string, init: Call = {}): Promise<T> {
  const r = await tp<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Tempo: nothing at ${path}`);
  return r.data;
}

/** `path` with a query: URLSearchParams from the given pairs (undefined left out). */
export function withQuery(path: string, q: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

/** Every page of a list, following `next` (bounded). */
export async function tpPages<T>(c: TempoCreds, path: string, opts: { maxPages?: number; absentIsNull?: boolean } = {}): Promise<T[] | null> {
  const out: T[] = [];
  let next: string | null = path;
  for (let n = 0; next && n < (opts.maxPages ?? 100); n++) {
    const r: { data: TempoList<T> } | null = await tp<TempoList<T>>(c, next, opts.absentIsNull ? { absentIsNull: true } : {});
    if (r === null) return null;
    out.push(...(r.data.results ?? []));
    next = r.data.metadata?.next ?? null;
  }
  return out;
}

// ---------- Wall-clock time ----------
// Tempo keeps a worklog's start as a date and a time of day in the user's own
// zone, no offset: an instant is turned into the connection's zone going out,
// and back coming in.

const WALL = new Map<string, Intl.DateTimeFormat>();
function wallFormat(zone: TimeZone): Intl.DateTimeFormat {
  let f = WALL.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    WALL.set(zone, f);
  }
  return f;
}

/** The wall clock of an instant in a zone, as a UTC number of milliseconds (the zone's offset still inside). */
function wallMs(ms: number, zone: TimeZone): number {
  const p = Object.fromEntries(wallFormat(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** An instant as Tempo wants a start: the day and the time of day in the zone. */
export function wallOf(ms: number, zone: TimeZone): { date: string; time: string } {
  const iso = new Date(wallMs(ms, zone)).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

/** The instant of a day and time of day in a zone (a time that never happened, in a DST gap, falls after it). */
export function instantOfWall(date: string, time: string, zone: TimeZone): number | null {
  const naive = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(naive)) return null;
  let guess = naive;
  for (let n = 0; n < 3; n++) guess = naive - (wallMs(guess, zone) - Math.floor(guess / 1000) * 1000);
  return guess;
}
