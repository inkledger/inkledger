// Basecamp (3 and 4) as a tracker, through the provider contract. The user's
// to-dos and cards, keyed BC-<project>-<id>: a recording's id is unique on the
// account but every call also needs its project (the "bucket"), so the key
// carries both. A to-do is open or completed; a card also sits in a column of
// its project's card table, a status once the column has a category (Triage,
// Not now and Done have one of their own; the others get it from the
// connection's options, never from a name). Time is Basecamp's timesheet
// entries: a day, hours and minutes, logged on a to-do or card.
// Built on a simulator, not verified on a real account: SPIKES.md.
import { secretOf } from "../core/context";
import { wholeMinutes } from "../core/time";
import { createHash } from "node:crypto";
import { z } from "zod";
import { LruCache } from "../../lib/lruCache";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { DAY_MS } from "@contracts/time";
import { instant, instantFrom, localDate, localDateOf, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import {
  mappingId,
  mappingVersion,
  type ActiveWorkflowSource,
  type CallContext,
  type ConversionWarning,
  type IssueHandle,
  type IssueRef,
  type Limited,
  type RemoteChange,
  type RemoteComment,
  type RemoteIssue,
  type RemotePerson,
  type RemoteStatus,
  type RemoteWorklog,
  type TrackerProvider,
  type Transition,
  type WorklogInput,
} from "../types";
import {
  bc,
  bcOk,
  bcPages,
  type Answer,
  joined,
  LAUNCHPAD,
  webHostOf,
  type BcAccount,
  type BcAssignments,
  type BcAuthorization,
  type BcCardTable,
  type BcColumn,
  type BcComment,
  type BcCreds,
  type BcEntry,
  type BcEvent,
  type BcPerson,
  type BcProject,
  type BcRecording,
} from "./client";

// The catalogue's entry for basecamp, here where the adapter keeps to it (the
// registry holds the two together).
export const basecampCapabilities: TrackerCapabilities = {
  // Completed or not on a to-do; a card also has the column it sits in.
  workflow: { sources: [{ kind: "boolean", transitions: "direct", reasons: false }, { kind: "column", transitions: "move" }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["html"], writePreserves: ["paragraph", "emphasis", "strong", "link", "list"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: true,
  history: true,
  statusHistory: false,
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "native", delete: true },
      // The timesheet report takes a period, not a change: a window of days is read again.
      feed: { kind: "window", by: "entryDate", days: 30, overlapDays: 2 },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
      activities: { read: false, write: false, required: "no" },
      onBehalf: { read: true, write: true },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "none",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    // Signals: an event says which recording changed, the connection is read again.
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const basecampTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: false,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: [],
  fields: ["due", "start", "multiAssignee"],
};

/** A column is matched by its title (case and surrounding spaces aside). */
const columnKey = (title: string) => title.trim().toLowerCase();

const optionsSchema = z.strictObject({
  /** The account (digits, as in 3.basecamp.com/<account>/…); none: the only Basecamp account of the token. */
  account: z
    .string()
    .regex(/^\d{1,15}$/, "an account id is digits")
    .nullable()
    .default(null),
  /**
   * The category of each card column that is a status. Triage, Not now and Done
   * are known to Basecamp; any other column means nothing until it is listed here.
   */
  columns: z
    .record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES))
    .default({})
    .transform((r): Record<string, StatusCategory> => Object.fromEntries(Object.entries(r).map(([k, v]) => [columnKey(k), v]))),
});
export type BasecampOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"basecamp", BasecampOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** The first read goes through the user's assignments; the later ones through the account's recordings, newest change first. */
type IssuePage = { phase: "assigned"; at: number; offset: number } | { phase: "feed"; at: number; i: number; next: string | null };
type EntriesAt = { next: string | null; from: string; to: string; at: number };

/** Overlap read again at each pass: a change may land after the clock that stamps it. */
const OVERLAP_MS = 60_000;
/** Basecamp pages hold 15 records. */
const PER_PAGE = 15;
/** The feed window the capabilities declare: 30 days and 2 of overlap. */
const WINDOW_DAYS = 32;
/** What is read of the recordings, in this order: the live ones, then the trashed ones (which are gone). */
const FEEDS = [
  { type: "Todo", status: "active" },
  { type: "Kanban::Card", status: "active" },
  { type: "Todo", status: "trashed" },
  { type: "Kanban::Card", status: "trashed" },
] as const;

const TODO = "Todo";
const CARD = "Kanban::Card";
const isIssueType = (t: string | undefined): t is typeof TODO | typeof CARD => t === TODO || t === CARD;

// ---------- Account and credentials ----------

/**
 * The account of a token, found once per token (the launchpad lists them).
 * Keyed by a hash, never the token itself, and capped: tokens renewed over
 * time don't pile up in memory.
 */
export const basecampAccounts = new LruCache<string, string>({ maxEntries: 200 });

async function accountOf(base: string, token: string, chosen: string | null): Promise<string> {
  if (chosen) return chosen;
  const key = createHash("sha256").update(`${base}|${token}`).digest("hex");
  const known = basecampAccounts.get(key);
  if (known) return known;
  const auth = await bcOk<BcAuthorization>({ apiBase: base, token }, "/authorization.json", { site: LAUNCHPAD });
  const mine = (auth.accounts ?? []).filter((a: BcAccount) => a.product === "bc3");
  if (mine.length === 0) throw new ProviderError("invalid", "Basecamp: the token has no Basecamp 3 or 4 account");
  if (mine.length > 1) throw new ProviderError("invalid", `Basecamp: the token has ${mine.length} accounts, choose one in the connection's options (account)`);
  basecampAccounts.set(key, String(mine[0].id));
  return String(mine[0].id);
}

async function credsOf(x: X): Promise<BcCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  const base = x.conn.baseUrl.replace(/\/+$/, "");
  return { apiBase: `${base}/${await accountOf(base, token, x.conn.options.account)}`, token };
}

/** What turning a record into the layer's shape needs of its connection. */
type Shape = { connId: number; columns: Record<string, StatusCategory>; zone: TimeZone; me: string };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, columns: x.conn.options.columns, zone: x.conn.timeZone, me: x.conn.remoteAccountId });

// ---------- Keys and links ----------

/** BC-<project>-<id>: the project is part of the address of every recording. */
const KEY = /^BC-(\d{1,15})-(\d{1,15})$/;
const keyOf = (bucket: number | string, id: number | string) => `BC-${bucket}-${id}`;
const normalizeKey = (raw: string) => {
  const k = raw.trim().toUpperCase();
  return KEY.test(k) ? k : null;
};

/** Where a recording is, from a handle or a ref: the key says, a container hint is the fallback. */
function placeOf(h: { remoteId?: string; key?: string; container?: { remoteId: string } }): { bucket: string; id: string } | null {
  const m = h.key ? KEY.exec(h.key) : null;
  const bucket = m?.[1] ?? h.container?.remoteId;
  const id = h.remoteId ?? m?.[2];
  return bucket && id && /^\d{1,15}$/.test(bucket) && /^\d{1,15}$/.test(id) ? { bucket, id } : null;
}

// ---------- Statuses ----------

const OPEN: RemoteStatus = { id: "open", name: "Open", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };
const COMPLETED: RemoteStatus = { id: "completed", name: "Completed", category: "done", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };

/** The three columns every card table has, with a meaning of their own. */
const NATIVE_COLUMNS: Record<string, StatusCategory> = { "Kanban::Triage": "triage", "Kanban::NotNowColumn": "backlog", "Kanban::DoneColumn": "done" };

type Column = Pick<BcColumn, "id" | "title" | "type">;

/** A column's category: Basecamp's own for the three, else the options' (never inferred from a title). */
function columnCategory(s: Pick<Shape, "columns">, col: Column): { category: StatusCategory; native: boolean } | null {
  const own = NATIVE_COLUMNS[col.type];
  if (own) return { category: own, native: true };
  const mapped = s.columns[columnKey(col.title)];
  return mapped ? { category: mapped, native: false } : null;
}

// The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
function columnStatus(s: Shape, bucket: string, col: Column, c: { category: StatusCategory; native: boolean }): RemoteStatus {
  return {
    id: String(col.id),
    name: col.title,
    category: c.category,
    categoryOrigin: c.native ? { by: "native" } : { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) },
    source: { kind: "column", boardRemoteId: bucket },
  };
}

/** A card's column is its status once it has a category; else completed or open. A to-do is completed or open. */
function statusOf(s: Shape, r: Pick<BcRecording, "type" | "completed" | "parent" | "bucket">): RemoteStatus {
  if (r.type === CARD && r.parent?.id !== undefined) {
    const col: Column = { id: r.parent.id, title: r.parent.title ?? "", type: r.parent.type ?? "" };
    const c = columnCategory(s, col);
    if (c) return columnStatus(s, String(r.bucket.id), col, c);
  }
  return r.completed ? COMPLETED : OPEN;
}

// ---------- Shaping ----------

function person(p: BcPerson): RemotePerson {
  return { remoteId: String(p.id), name: p.name || p.email_address || String(p.id), avatarUrl: p.avatar_url ?? null };
}

const day = (v: string | null | undefined): LocalDate | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? localDate(v) : null);

export function toRemoteIssue(s: Shape, r: BcRecording): RemoteIssue {
  const card = r.type === CARD;
  const name = r.bucket.name ?? String(r.bucket.id);
  return {
    remoteId: String(r.id),
    key: keyOf(r.bucket.id, r.id),
    url: r.app_url,
    // A to-do's title is its "content"; a card has a title of its own (its content is the body).
    title: (card ? r.title : (r.content ?? r.title)) || String(r.id),
    type: { id: card ? "card" : "todo", name: card ? "Card" : "To-do", level: "standard" },
    status: statusOf(s, r),
    container: { remoteId: String(r.bucket.id), key: name, name, kind: "project" },
    priority: null,
    labels: [],
    assignees: (r.assignees ?? []).map(person),
    reporter: r.creator ? person(r.creator) : null,
    due: day(r.due_on),
    createdAt: instantFrom(r.created_at),
    updatedAt: instantFrom(r.updated_at),
    statusChangedAt: instantFrom(r.completion?.created_at ?? null),
    parent: null,
  };
}

const mine = (s: Pick<Shape, "me">, r: BcRecording) => (r.assignees ?? []).some((a) => String(a.id) === s.me);

// ---------- Finding a recording ----------

const recordingPath = (bucket: string, id: string, type: string) => (type === CARD ? `/buckets/${bucket}/card_tables/cards/${id}.json` : `/buckets/${bucket}/todos/${id}.json`);

/**
 * A to-do or card as it is now. Cards and to-dos have paths of their own and
 * the wrong one is a 404, so both are tried (the likelier first). A trashed or
 * archived recording is still answered, with its status: it is not there. Null
 * too when the project is out of the user's reach (403).
 */
async function locate(c: BcCreds, place: { bucket: string; id: string } | null, hint: string = TODO): Promise<BcRecording | null> {
  if (!place) return null;
  for (const type of hint === CARD ? [CARD, TODO] : [TODO, CARD]) {
    try {
      const r = await bc<BcRecording>(c, recordingPath(place.bucket, place.id, type), { missingIsNull: true });
      if (r) return r.data.status === "active" ? r.data : null;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "forbidden") return null;
      throw e;
    }
  }
  return null;
}

async function mustLocate(c: BcCreds, ref: IssueRef): Promise<BcRecording> {
  const r = await locate(c, placeOf(ref));
  if (!r) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
  return r;
}

/** The project's card table, when it has one (the first, enabled one of its dock). */
async function cardTableOf(c: BcCreds, bucket: string): Promise<BcCardTable | null> {
  const project = await bc<BcProject>(c, `/projects/${bucket}.json`, { missingIsNull: true });
  const dock = project?.data.dock?.find((d) => d.name === "kanban_board" && d.enabled !== false);
  if (!dock) return null;
  return (await bc<BcCardTable>(c, `/buckets/${bucket}/card_tables/${dock.id}.json`, { missingIsNull: true }))?.data ?? null;
}

// ---------- Search ----------

/** At most this many search results are looked at, each one a call of its own. */
const SEARCH_LOOKED_AT = 40;
type Hit = { id: number; type: string; bucket: { id: number } };

async function search(x: X, text: string, limit: number): Promise<Limited<RemoteIssue>> {
  const c = await credsOf(x);
  const s = shapeOf(x);
  const items: RemoteIssue[] = [];
  let at: string | null = joined("/search.json", { q: text });
  let looked = 0;
  let cut = false;
  // The search finds everything of the account, other people's to-dos too, and gives a bare record: each one is read, and kept when it is the user's.
  for (let page = 0; at && !cut && page < 10; page++) {
    const r: Answer<Hit[]> | null = await bc<Hit[]>(c, at);
    for (const hit of r?.data ?? []) {
      if (!isIssueType(hit.type)) continue;
      if (looked >= SEARCH_LOOKED_AT || items.length > limit) {
        cut = true;
        break;
      }
      looked++;
      const rec = await locate(c, { bucket: String(hit.bucket.id), id: String(hit.id) }, hit.type);
      if (rec && mine(s, rec)) items.push(toRemoteIssue(s, rec));
    }
    at = r?.next ?? null;
  }
  return { items: items.slice(0, limit), complete: !cut && at === null && items.length <= limit };
}

// ---------- Time ----------

/** Hours as Basecamp gives them: "1.33" (two decimals) or "1:20"; whole minutes. */
function minutesOfHours(hours: string): number {
  const clock = /^(\d+):([0-5]?\d)$/.exec(hours.trim());
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const n = Number(hours);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : 0;
}

const hoursOfSeconds = (seconds: number) => {
  const min = wholeMinutes(seconds);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
};

function toRemoteWorklog(e: BcEntry, me: string, bucketHint?: string): RemoteWorklog {
  const bucket = e.bucket?.id !== undefined ? String(e.bucket.id) : bucketHint;
  const parent = e.parent;
  const author = e.person ?? e.creator;
  const own = String(author?.id ?? "") === me;
  return {
    remoteId: String(e.id),
    issue: parent && isIssueType(parent.type) && bucket ? { remoteId: String(parent.id), key: keyOf(bucket, parent.id), container: { remoteId: bucket, key: e.bucket?.name ?? bucket } } : null,
    span: { kind: "date", date: localDate(e.date), seconds: minutesOfHours(e.hours) * 60 },
    comment: e.description ?? "",
    authorRemoteId: String(author?.id ?? ""),
    createdAt: instantFrom(e.created_at ?? null),
    updatedAt: instantFrom(e.updated_at ?? null),
    billable: null,
    activity: null,
    approval: null,
    locked: null,
    editable: { update: own, delete: own },
  };
}

function entryBody(w: WorklogInput) {
  if (w.time.kind !== "date") throw new ProviderError("invalid", `Basecamp keeps time on a day, not a ${w.time.kind}`);
  return { date: w.time.date, hours: hoursOfSeconds(w.time.seconds), description: w.comment, ...(w.onBehalfOfRemoteId ? { person_id: Number(w.onBehalfOfRemoteId) } : {}) };
}

const shiftDay = (d: LocalDate, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const entryPath = (bucket: string, id: string) => `/buckets/${bucket}/timesheet/entries/${encodeURIComponent(id)}.json`;

function bucketOfRef(ref: IssueRef): string {
  const p = placeOf(ref);
  if (!p) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
  return p.bucket;
}

// ---------- Comments ----------

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const toRemoteComment = (cm: BcComment): RemoteComment => ({
  id: String(cm.id),
  author: cm.creator ? person(cm.creator) : { remoteId: "", name: "" },
  body: { kind: "text", format: "html", text: cm.content },
  createdAt: instantFrom(cm.created_at),
  updatedAt: instantFrom(cm.updated_at ?? null),
});

/** Inline Markdown as the tags Basecamp's editor keeps (strong, em, strike, a); code spans are plain text there. */
function inline(text: string, approximate: (f: "code" | "image") => void): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, n) => {
      if (n % 2 === 1) {
        approximate("code");
        return escapeHtml(part.slice(1, -1));
      }
      return escapeHtml(part)
        .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_m, alt: string, url: string) => {
          approximate("image");
          return `<a href="${url.replace(/"/g, "&quot;")}">${alt || url}</a>`;
        })
        .replace(/\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label || url}</a>`)
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<strong>${a ?? b}</strong>`)
        .replace(/~~([^~\n]+)~~/g, "<strike>$1</strike>")
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_\n]*)_(?!\w)/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`);
    })
    .join("");
}

/**
 * Markdown as Basecamp's rich text: <div> paragraphs with <br> line breaks, a
 * single <h1> heading level, <pre>, <blockquote>, lists, strong, em, strike and
 * links. Basecamp drops any other tag, so none is sent. What it can't keep
 * (heading levels, inline code, tables, images) is written as plain text and said so.
 */
export function toBasecampHtml(md: string): { html: string; warnings: ConversionWarning[] } {
  const warnings = new Map<string, ConversionWarning>();
  const approximate = (feature: NonNullable<ConversionWarning["feature"]>) => warnings.set(feature, { code: "approximated", feature });
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) out.push(`<div>${para.join("<br>")}</div>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (code) {
        out.push(`<pre>${code.map(escapeHtml).join("\n")}</pre>`);
        code = null;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(inline(item[2], approximate));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      if (heading[1].length > 1) approximate("heading");
      out.push(`<h1>${inline(heading[2], approximate)}</h1>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      out.push(`<blockquote><div>${inline(quote[1], approximate)}</div></blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) approximate("table");
    if (list) flush();
    para.push(inline(line, approximate));
  }
  if (code) out.push(`<pre>${code.map(escapeHtml).join("\n")}</pre>`);
  flush();
  return { html: out.join(""), warnings: [...warnings.values()] };
}

// ---------- Webhooks ----------

/**
 * Basecamp's webhooks are made per project (POST /buckets/<id>/webhooks.json
 * with a payload URL and the types wanted). A delivery carries no signature:
 * the secret is in the URL, which the core checks; here only that the body is
 * a Basecamp payload ({ id, kind, created_at, recording }).
 */
type Delivery = { id?: unknown; kind?: unknown; created_at?: unknown; recording?: unknown };

function parseDelivery(body: string): Delivery | null {
  try {
    const d = JSON.parse(body) as unknown;
    return typeof d === "object" && d !== null && !Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
}

export const basecampWebhook = {
  verify(rawBody: string): boolean {
    const d = parseDelivery(rawBody);
    return d !== null && typeof d.kind === "string" && typeof d.recording === "object" && d.recording !== null;
  },
  deliveryId(rawBody: string): string | null {
    const id = parseDelivery(rawBody)?.id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  },
  sentAt(rawBody: string): number | null {
    const at = parseDelivery(rawBody)?.created_at;
    return typeof at === "string" ? (instantFrom(at) ?? null) : null;
  },
  /** Which of the declared events a delivery is: comments are comments, anything else about a to-do or card a change. */
  events(rawBody: string): ("issueChanged" | "commentAdded")[] {
    const d = parseDelivery(rawBody);
    if (!d || typeof d.kind !== "string") return [];
    const type = (d.recording as { type?: unknown } | null)?.type;
    if (d.kind.startsWith("comment_")) return ["commentAdded"];
    return type === TODO || type === CARD ? ["issueChanged"] : [];
  },
};

// ---------- The adapter ----------

export const basecampProvider: TrackerProvider<"basecamp", BasecampOptions> = {
  // No signature to check: the secret in the URL is the core's. Replays are refused by the delivery's id, stale ones by its time.
  webhook: {
    verify: (req) => basecampWebhook.verify(req.body),
    deliveryId: (req) => basecampWebhook.deliveryId(req.body),
    sentAt: (req) => basecampWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "basecamp",
  capabilities: basecampCapabilities,
  traits: basecampTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Basecamp options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      const url = new URL(input.trim());
      if (url.host !== webHostOf(r.baseUrl)) return null;
      // /<account>/buckets/<project>/todos/<id>, …/card_tables/cards/<id> (a comment adds #__recording_<id>)
      const m = /^\/(\d+)\/buckets\/(\d+)\/(?:todos|card_tables\/cards)\/(\d+)\/?$/.exec(url.pathname);
      if (!m || (r.options.account !== null && r.options.account !== m[1])) return null;
      return { key: keyOf(m[2], m[3]), remoteId: m[3] };
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await bcOk<BcPerson>(await credsOf(x), "/my/profile.json");
    return { ...person(me), ...(me.email_address ? { email: me.email_address, login: me.email_address } : {}) };
  },

  async probe(x) {
    const c = await credsOf(x);
    await bcOk<BcPerson>(c, "/my/profile.json");
    const sources: ActiveWorkflowSource[] = [{ kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / completed" }];
    // Each project with a card table is a board (the first hundred projects).
    for (const p of (await bcPages<BcProject>(c, "/projects.json", 7)).slice(0, 100)) {
      if (p.dock?.some((d) => d.name === "kanban_board" && d.enabled !== false)) sources.push({ kind: "column", transitions: "move", ref: { kind: "column", boardRemoteId: String(p.id) }, name: `${p.name} (card table)` });
    }
    // 50 requests per 10 seconds per IP, said nowhere in an answer but when exceeded (429).
    return { capabilities: basecampCapabilities, activeSources: sources, rateLimit: { perSecond: 5, origin: "typical" }, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const s = shapeOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const pass = decodePageToken<IssuePage>(x.conn, "issues", V, q.since, q.page) ?? (since === null ? { phase: "assigned" as const, at: Date.now(), offset: 0 } : { phase: "feed" as const, at: Date.now(), i: 0, next: null });
    const done = (items: RemoteIssue[], gone: { remoteId: string; reason: "deleted" }[]) => ({ last: true as const, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: pass.at - OVERLAP_MS } satisfies Since) });

    if (pass.phase === "assigned") {
      // A first read: what is assigned to the user and open (the assignments list has no change time, no completed ones), each read in full.
      const a = await bcOk<BcAssignments>(c, "/my/assignments.json");
      const all = [...new Map([...(a.priorities ?? []), ...(a.non_priorities ?? [])].filter((x2) => isIssueType(x2.type)).map((x2) => [x2.id, x2])).values()].sort((p, r) => p.id - r.id);
      const slice = all.slice(pass.offset, pass.offset + PER_PAGE);
      const found = await Promise.all(slice.map((as) => locate(c, { bucket: String(as.bucket.id), id: String(as.id) }, as.type)));
      const items = found.flatMap((r) => (r && mine(s, r) ? [toRemoteIssue(s, r)] : []));
      const offset = pass.offset + PER_PAGE;
      return offset < all.length ? { last: false, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, { ...pass, offset } satisfies IssuePage) } : done(items, []);
    }

    // A later read: recordings changed since the checkpoint, newest first, until one older than it.
    const feed = FEEDS[pass.i];
    const r = await bc<BcRecording[]>(c, pass.next ?? joined("/projects/recordings.json", { type: feed.type, status: feed.status, sort: "updated_at", direction: "desc" }));
    const rows = r?.data ?? [];
    const cut = since ?? 0;
    const fresh = rows.filter((row) => (instantFrom(row.updated_at) ?? 0) >= cut);
    const items = feed.status === "active" ? fresh.filter((row) => row.status === "active" && mine(s, row)).map((row) => toRemoteIssue(s, row)) : [];
    // A trashed recording is gone; an unassigned or foreign one is none of the user's.
    const gone = feed.status === "trashed" ? fresh.filter((row) => mine(s, row)).map((row) => ({ remoteId: String(row.id), reason: "deleted" as const })) : [];
    const older = fresh.length < rows.length;
    if (r?.next && !older) return { last: false, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, { ...pass, next: r.next } satisfies IssuePage) };
    if (pass.i + 1 < FEEDS.length) return { last: false, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, { phase: "feed", at: pass.at, i: pass.i + 1, next: null } satisfies IssuePage) };
    return done(items, gone);
  },

  async getIssue(x, ref) {
    const r = await locate(await credsOf(x), placeOf(ref));
    return r ? toRemoteIssue(shapeOf(x), r) : null;
  },

  async findIssue(x, handle) {
    const r = await locate(await credsOf(x), placeOf(handle));
    // A key holds the project and the id: never ambiguous.
    return r ? { kind: "found", issue: toRemoteIssue(shapeOf(x), r) } : { kind: "none" };
  },

  searchText: search,

  async statuses(x, source) {
    if (source.kind === "boolean") return [OPEN, COMPLETED];
    if (source.kind !== "column") return [];
    const s = shapeOf(x);
    const table = await cardTableOf(await credsOf(x), source.ref.boardRemoteId);
    return (table?.lists ?? []).flatMap((col, order) => {
      const c = columnCategory(s, col);
      return c ? [{ ...columnStatus(s, source.ref.boardRemoteId, col, c), order }] : [];
    });
  },

  async description(x, ref) {
    const r = await locate(await credsOf(x), placeOf(ref));
    const body = r?.type === CARD ? r.content : r?.description;
    return body?.trim() ? { kind: "text", format: "html", text: body } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const r = await mustLocate(c, ref);
      const s = shapeOf(x);
      const common = { requirements: [], remoteUrl: r.app_url };
      if (r.type !== CARD) {
        return r.completed
          ? ([{ id: "reopen", name: "Reopen", to: OPEN, ...common }] satisfies Transition[])
          : ([{ id: "complete", name: "Complete", to: COMPLETED, ...common }] satisfies Transition[]);
      }
      // A card moves between the columns of its project's table that have a category.
      const bucket = String(r.bucket.id);
      const table = await cardTableOf(c, bucket);
      return (table?.lists ?? []).flatMap((col): Transition[] => {
        const cat = columnCategory(s, col);
        return cat && col.id !== r.parent?.id ? [{ id: `column:${col.id}`, name: `Move to ${col.title}`, to: columnStatus(s, bucket, col, cat), ...common }] : [];
      });
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const r = await mustLocate(c, ref);
      const s = shapeOf(x);
      const bucket = String(r.bucket.id);
      if (r.type !== CARD) {
        if (transitionId !== "complete" && transitionId !== "reopen") throw new ProviderError("invalid", `Basecamp: no transition ${transitionId}`);
        await bc<unknown>(c, `/buckets/${bucket}/todos/${r.id}/completion.json`, { method: transitionId === "complete" ? "POST" : "DELETE" });
      } else {
        const column = transitionId.startsWith("column:") ? Number(transitionId.slice(7)) : NaN;
        const table = await cardTableOf(c, bucket);
        const target = table?.lists.find((l) => l.id === column);
        if (!target || !columnCategory(s, target)) throw new ProviderError("invalid", `Basecamp: no transition ${transitionId}`);
        await bc<unknown>(c, `/buckets/${bucket}/card_tables/cards/${r.id}/moves.json`, { method: "POST", json: { column_id: target.id } });
      }
      // Both answer with no body: read the record again.
      const after = await locate(c, { bucket, id: String(r.id) }, r.type);
      return after ? toRemoteIssue(s, after) : null;
    },
  },

  worklogs: {
    async list(x, ref) {
      const c = await credsOf(x);
      const place = placeOf(ref);
      if (!place) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
      const entries = await bcPages<BcEntry>(c, `/buckets/${place.bucket}/recordings/${place.id}/timesheet.json`);
      return entries.filter((e) => (e.status ?? "active") === "active").map((e) => toRemoteWorklog(e, x.conn.remoteAccountId, place.bucket));
    },
    async get(x, ref, id) {
      const bucket = bucketOfRef(ref);
      const e = await bc<BcEntry>(await credsOf(x), entryPath(bucket, id), { missingIsNull: true });
      // A trashed entry is still answered.
      return e && (e.data.status ?? "active") === "active" ? toRemoteWorklog(e.data, x.conn.remoteAccountId, bucket) : null;
    },
    async changed(x, q) {
      const c = await credsOf(x);
      // Only validated: a window is always read whole (an entry can be dated before it was logged).
      decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since);
      const now = Date.now();
      const today = localDateOf(instant(now), x.conn.timeZone);
      const at =
        decodePageToken<EntriesAt>(x.conn, "worklogs", V, q.since, q.page) ??
        ({ next: null, from: shiftDay(today, -WINDOW_DAYS), to: shiftDay(today, 1), at: now } satisfies EntriesAt);
      const r = await bc<BcEntry[]>(c, at.next ?? joined("/reports/timesheet.json", { from: at.from, to: at.to, person_id: x.conn.remoteAccountId }));
      // Time logged on a project itself (no to-do or card) has nowhere to go here.
      const items = (r?.data ?? []).map((e) => toRemoteWorklog(e, x.conn.remoteAccountId)).filter((w) => w.issue !== null);
      if (!r?.next) return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: at.at } satisfies Since) };
      return { last: false, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { ...at, next: r.next } satisfies EntriesAt) };
    },
    async create(x, ref, w) {
      const place = placeOf(ref);
      if (!place) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
      const e = await bcOk<BcEntry>(await credsOf(x), `/buckets/${place.bucket}/recordings/${place.id}/timesheet/entries.json`, { method: "POST", json: entryBody(w) });
      return toRemoteWorklog(e, x.conn.remoteAccountId, place.bucket);
    },
    async update(x, ref, id, w) {
      const bucket = bucketOfRef(ref);
      const e = await bcOk<BcEntry>(await credsOf(x), entryPath(bucket, id), { method: "PUT", json: entryBody(w) });
      return toRemoteWorklog(e, x.conn.remoteAccountId, bucket);
    },
    async delete(x, ref, id) {
      // An entry is trashed, not removed; trashing what is already gone is a success.
      await bc<unknown>(await credsOf(x), `/buckets/${bucketOfRef(ref)}/recordings/${encodeURIComponent(id)}/status/trashed.json`, { method: "PUT", missingIsNull: true });
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const place = placeOf(ref);
      if (!place) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
      return (await bcPages<BcComment>(c, `/buckets/${place.bucket}/recordings/${place.id}/comments.json`)).map(toRemoteComment);
    },
    async add(x, ref, body) {
      const place = placeOf(ref);
      if (!place) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
      const { html, warnings } = toBasecampHtml(body);
      const comment = await bcOk<BcComment>(await credsOf(x), `/buckets/${place.bucket}/recordings/${place.id}/comments.json`, { method: "POST", json: { content: html } });
      return { comment: toRemoteComment(comment), warnings };
    },
  },

  async watch(x, ref, on) {
    const place = placeOf(ref);
    if (!place) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
    // Subscribing twice, or unsubscribing twice, is what was asked.
    await bc<unknown>(await credsOf(x), `/buckets/${place.bucket}/recordings/${place.id}/subscription.json`, { method: on ? "POST" : "DELETE" });
  },

  async history(x, ref) {
    const c = await credsOf(x);
    const place = placeOf(ref);
    if (!place) throw new ProviderError("notFound", `Basecamp: no to-do or card ${ref.key}`);
    const events = await bcPages<BcEvent>(c, `/buckets/${place.bucket}/recordings/${place.id}/events.json`);
    // Events name people by id: each one is asked once.
    const names = new Map<number, Promise<string>>();
    const nameOf = (id: number) => {
      let p = names.get(id);
      if (!p) {
        p = bc<BcPerson>(c, `/people/${id}.json`, { missingIsNull: true }).then((r) => r?.data.name ?? `#${id}`);
        names.set(id, p);
      }
      return p;
    };
    const changes = await Promise.all(
      events.map(async (e): Promise<RemoteChange | null> => {
        const base = { at: instantFrom(e.created_at) ?? instant(0), actor: e.creator ? person(e.creator) : null };
        switch (e.action) {
          case "created":
            return null;
          case "completed":
            return { ...base, field: { id: "completed", name: "Completed" }, from: [{ text: "No" }], to: [{ text: "Yes" }] };
          case "uncompleted":
            return { ...base, field: { id: "completed", name: "Completed" }, from: [{ text: "Yes" }], to: [{ text: "No" }] };
          case "assignment_changed": {
            const added = e.details?.added_person_ids ?? [];
            const removed = e.details?.removed_person_ids ?? [];
            return {
              ...base,
              field: { id: "assignees", name: "Assignees" },
              from: await Promise.all(removed.map(async (id) => ({ text: await nameOf(id), id: String(id) }))),
              to: await Promise.all(added.map(async (id) => ({ text: await nameOf(id), id: String(id) }))),
            };
          }
          case "content_changed":
            return { ...base, field: { id: "content", name: "Content" }, from: [], to: [] };
          default:
            return { ...base, field: { name: e.action }, from: [], to: [] };
        }
      }),
    );
    return changes.flatMap((ch) => ch ?? []).sort((a, b) => a.at - b.at);
  },
};
