// monday.com as a tracker, through the provider contract. Items of the boards
// the user can see whose people column holds them, keyed by board and item
// ("1234567890#9876543210": monday has no human key, and an item that moves to
// another board keeps its id and gets a new key). The workflow is a board's
// status column: its labels are the board's own words, so only "done" (the
// column's done colours) and "no label" are monday's to say; the rest follow
// the connection's own mapping. Time: the time tracking column is read, never
// written (spentSeconds); the time filed stays in inkledger's own register.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { STATUS_CATEGORIES, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, localDateOf, type Instant, type JsonValue, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { mappingId, mappingVersion } from "../types";
import type { ActiveWorkflowSource, CallContext, ChangeValue, ConversionWarning, IssueHandle, IssueRef, RemoteChange, RemoteComment, RemoteIssue, RemotePerson, RemoteStatus, TrackerProvider, Transition } from "../types";
import {
  ITEM_FIELDS,
  UPDATE_FIELDS,
  activityMs,
  allPages,
  gql,
  type MondayActivity,
  type MondayBoard,
  type MondayColumn,
  type MondayCreds,
  type MondayItem,
  type MondayUpdate,
  type MondayUser,
} from "./client";

export const mondayCapabilities: TrackerCapabilities = {
  // A board's status column: any label can be set from any other.
  workflow: { sources: [{ kind: "projectField", transitions: "direct" }] },
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
  watch: false,
  history: true,
  // The time tracking column can be read, not written.
  time: { mode: "local", remoteTotals: true },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const mondayTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: [],
  fields: ["priority", "due", "start", "estimate", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({
  /**
   * The category of a status label, by its name (any case). monday says which
   * labels mean "done" (the column's done colours) and which is empty; it
   * doesn't say what "Working on it" or "Stuck" mean: only what is listed here
   * is read as more than "todo".
   */
  categories: z.record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES)).default({}),
});
export type MondayOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"monday", MondayOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** Where a pass is: a board (page of the boards list, and place in it), its items by cursor, then, on an incremental pass, what left it. */
type PageAt = { page: number; b: number; phase: "items" | "gone"; cursor: string | null; at: number };

/** Overlap read again at each pass: updates may land while a pass runs. */
const OVERLAP_MS = 60_000;
/** monday allows 500 items a page; each item carries its board's columns, which weighs on the complexity budget. */
const PER_PAGE = 50;
const BOARDS_PER_PAGE = 25;
const LOG_PAGE = 100;
/** Boards asked for in one search query. */
const SEARCH_BOARDS = 5;

async function credsOf(x: X): Promise<MondayCreds> {
  const cred = await x.conn.credential();
  return { apiBase: x.conn.baseUrl, token: cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password, oauth: cred.kind === "oauth" };
}

// ---------- Keys and links ----------

/** board#item: the ids are digits (up to 19: they outgrow 2^53 in time). */
export const ISSUE_KEY = /^(\d{1,19})#(\d{1,19})$/;
const normalizeKey = (raw: string) => (ISSUE_KEY.test(raw.trim()) ? raw.trim() : null);
const keyOf = (boardId: string, itemId: string) => `${boardId}#${itemId}`;
const itemIdOf = (ref: { remoteId?: string; key?: string }): string | null => {
  if (ref.remoteId && /^\d{1,19}$/.test(ref.remoteId)) return ref.remoteId;
  const m = ref.key ? ISSUE_KEY.exec(ref.key) : null;
  return m ? m[2] : null;
};

/** *.monday.com (the account's subdomain) or monday.com itself. */
const isMondayHost = (host: string) => host === "monday.com" || host.endsWith(".monday.com");

// ---------- Values ----------

const parseJson = (s: string | null | undefined): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** Ids are strings in GraphQL and numbers inside a cell's JSON (and past 2^53 they are lost there): both read as strings. */
const idStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

// The column types changed names between schema versions: both are read.
const isStatus = (c: MondayColumn) => c.type === "status" || c.type === "color";
const isPeople = (c: MondayColumn) => c.type === "people" || c.type === "multiple-person";
const isTracking = (c: MondayColumn) => c.type === "time_tracking" || c.type === "duration";

/** The status column that is the board's workflow: "status" by id, else the first that isn't a priority. */
export const statusColumn = (cols: MondayColumn[]): MondayColumn | undefined => {
  const all = cols.filter(isStatus);
  return all.find((c) => c.id === "status") ?? all.find((c) => !c.id.startsWith("priority")) ?? all[0];
};
/** The people column the user's items are found by: "person" by id, else the first. */
export const peopleColumn = (cols: MondayColumn[]): MondayColumn | undefined => {
  const all = cols.filter(isPeople);
  return all.find((c) => c.id === "person") ?? all[0];
};
/** A board whose items can be followed: items, a status to move along and someone assigned. */
const usable = (b: MondayBoard) => b.type !== "document" && statusColumn(b.columns) !== undefined && peopleColumn(b.columns) !== undefined;

type Label = { index: number; name: string; color?: string; order: number; done: boolean };

/** A status column's labels: its settings are JSON in a string; a label's index is the board's own number. */
export function labelsOf(col: MondayColumn): Label[] {
  const s = rec(parseJson(col.settings_str));
  const names = rec(s.labels);
  const done = Array.isArray(s.done_colors) ? s.done_colors.filter((n): n is number => typeof n === "number") : [];
  const positions = rec(s.labels_positions_v2);
  const colors = rec(s.labels_colors);
  return Object.entries(names)
    .map(([k, name]) => ({ index: Number(k), name: typeof name === "string" ? name : "", color: str(rec(colors[k]).color) ?? undefined, order: typeof positions[k] === "number" ? positions[k] : Number(k), done: done.includes(Number(k)) }))
    .filter((l) => Number.isInteger(l.index))
    .sort((a, b) => a.order - b.order || a.index - b.index);
}

/** What turning a monday item into the layer's shape needs of its connection. */
type Shape = { connId: number; zone: TimeZone; categories: MondayOptions["categories"]; users: Map<string, MondayUser>; now: number };

function categoryOf(sh: Shape, l: Pick<Label, "name" | "done">): Pick<RemoteStatus, "category" | "categoryOrigin"> {
  if (l.done) return { category: "done", categoryOrigin: { by: "native" } };
  if (l.name.trim() === "") return { category: "backlog", categoryOrigin: { by: "native" } };
  const name = l.name.trim().toLowerCase();
  const hit = Object.entries(sh.categories).find(([k]) => k.trim().toLowerCase() === name);
  // The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
  return { category: hit ? hit[1] : "todo", categoryOrigin: { by: "mapping", mapping: mappingId(sh.connId), version: mappingVersion(1) } };
}

export function statusOf(sh: Shape, board: Pick<MondayBoard, "id">, col: MondayColumn, l: Label): RemoteStatus {
  return {
    id: String(l.index),
    name: l.name,
    ...categoryOf(sh, l),
    source: { kind: "projectField", fieldRemoteId: col.id, containerRemoteId: board.id },
    ...(l.color ? { color: l.color } : {}),
    order: l.order,
  };
}

/** An item with no label in its status column: monday shows it blank. */
const blankStatus = (board: Pick<MondayBoard, "id">, col: MondayColumn): RemoteStatus => ({
  id: "blank",
  name: "No status",
  category: "backlog",
  categoryOrigin: { by: "native" },
  source: { kind: "projectField", fieldRemoteId: col.id, containerRemoteId: board.id },
  nativeReason: "no label",
});

const person = (u: MondayUser): RemotePerson => ({ remoteId: u.id, name: u.name, avatarUrl: u.photo_thumb_small ?? null });

/** The people (not the teams) a people column holds; the ids only: the names are asked for in one go. */
function personIds(item: MondayItem): string[] {
  const cols = item.board?.columns.filter(isPeople).map((c) => c.id) ?? [];
  const ids = item.column_values
    .filter((v) => cols.includes(v.id))
    .flatMap((v) => {
      const list = rec(parseJson(v.value)).personsAndTeams;
      return Array.isArray(list) ? list.filter((p) => rec(p).kind === "person").map((p) => idStr(rec(p).id)) : [];
    });
  return [...new Set(ids.filter((i): i is string => i !== null))];
}

/** A date column's cell: a day, and a time of day that, when set, is UTC (never the user's zone). */
function dayOf(zone: TimeZone, v: Record<string, unknown>): LocalDate | null {
  const date = str(v.date);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  try {
    const time = str(v.time);
    if (!time) return localDate(date);
    const ms = Date.parse(`${date}T${time}Z`);
    return Number.isFinite(ms) ? localDateOf(instant(ms), zone) : localDate(date);
  } catch {
    return null;
  }
}
const plainDay = (v: unknown): LocalDate | null => {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  try {
    return localDate(s);
  } catch {
    return null;
  }
};

/** The time tracking column's total, seconds. A running timer counts up to now; `running` comes as a string. */
export function trackedSeconds(value: string | null | undefined, now: number): number | null {
  const v = rec(parseJson(value));
  const duration = typeof v.duration === "number" && v.duration >= 0 ? Math.floor(v.duration) : null;
  if (duration === null) return null;
  const running = v.running === true || v.running === "true";
  const started = typeof v.startDate === "number" ? v.startDate : Number(v.startDate);
  return running && Number.isFinite(started) && started > 0 ? duration + Math.max(0, Math.floor(now / 1000 - started)) : duration;
}

export function toRemoteIssue(sh: Shape, item: MondayItem): RemoteIssue {
  const board = item.board;
  if (!board) throw new ProviderError("incompatible", `monday: item ${item.id} without its board`);
  const col = statusColumn(board.columns);
  const cell = (id: string) => item.column_values.find((v) => v.id === id);
  const status = (() => {
    if (!col) return { id: "none", name: "No status", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "projectField", fieldRemoteId: "status", containerRemoteId: board.id } } satisfies RemoteStatus;
    const v = rec(parseJson(cell(col.id)?.value));
    const index = typeof v.index === "number" ? v.index : null;
    const label = index === null ? undefined : labelsOf(col).find((l) => l.index === index);
    return label ? statusOf(sh, board, col, label) : blankStatus(board, col);
  })();
  const changed = col ? str(rec(parseJson(cell(col.id)?.value)).changed_at) : null;

  const prio = board.columns.find((c) => isStatus(c) && c.id.startsWith("priority"));
  const prioCell = prio ? cell(prio.id) : undefined;
  const prioIndex = prioCell ? rec(parseJson(prioCell.value)).index : undefined;
  const prioLabel = prioCell && prioIndex !== undefined ? str(prioCell.text) : null;

  const dateCol = board.columns.find((c) => c.type === "date");
  const timeline = board.columns.find((c) => c.type === "timeline");
  const dateCell = dateCol ? rec(parseJson(cell(dateCol.id)?.value)) : {};
  const line = timeline ? rec(parseJson(cell(timeline.id)?.value)) : {};
  const due = dayOf(sh.zone, dateCell) ?? plainDay(line.to);
  const start = plainDay(line.from);

  const tags = board.columns.filter((c) => c.type === "tags").flatMap((c) => (cell(c.id)?.text ?? "").split(",").map((t) => t.trim()).filter((t) => t !== ""));
  const track = board.columns.find(isTracking);
  const mapped = new Set([col?.id, prio?.id, dateCol?.id, timeline?.id, track?.id, ...board.columns.filter((c) => isPeople(c) || c.type === "tags" || c.type === "subtasks" || c.type === "name").map((c) => c.id)]);
  const fields: Record<string, JsonValue> = {
    ...(start ? { start } : {}),
    ...(item.group ? { group: item.group.title } : {}),
    ...Object.fromEntries(board.columns.filter((c) => !mapped.has(c.id) && c.id !== descriptionColumn(board.columns)?.id && (cell(c.id)?.text ?? "") !== "").map((c) => [c.id, cell(c.id)?.text ?? ""])),
  };
  const spent = track ? trackedSeconds(cell(track.id)?.value, sh.now) : null;
  const parent = item.parent_item;

  return {
    remoteId: item.id,
    key: keyOf(board.id, item.id),
    url: item.url,
    title: item.name,
    type: { id: "item", name: parent ? "Subitem" : "Item", level: parent ? "sub" : "standard" },
    status,
    container: { remoteId: board.id, key: board.id, name: board.name, kind: "board", ...(board.workspace?.name ? { group: board.workspace.name } : {}) },
    priority: prio && prioLabel ? { id: typeof prioIndex === "number" ? String(prioIndex) : prioLabel, name: prioLabel, rank: null } : null,
    labels: tags,
    assignees: personIds(item).map((id) => person(sh.users.get(id) ?? { id, name: `User ${id}` })),
    reporter: item.creator ? person(item.creator) : null,
    due,
    estimateSeconds: null,
    ...(spent !== null ? { spentSeconds: spent } : {}),
    createdAt: instantFrom(item.created_at),
    updatedAt: instantFrom(item.updated_at),
    statusChangedAt: instantFrom(changed),
    parent: parent ? { remoteId: parent.id, key: keyOf(parent.board?.id ?? board.id, parent.id) } : null,
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}

/** The long text column that is the item's description: "description" by id or title. */
function descriptionColumn(cols: MondayColumn[]): MondayColumn | undefined {
  return cols.find((c) => c.type === "long_text" && (c.id === "description" || /^description$/i.test(c.title)));
}

// ---------- Queries ----------

const ITEMS_BY_ID = `${ITEM_FIELDS}
query Items($ids: [ID!]) { items(ids: $ids) { ...ItemFields } }`;

const BOARD_FIELDS = "id name type workspace { id name } columns { id title type settings_str }";
const BOARDS = `query Boards($limit: Int!, $page: Int!) { boards(limit: $limit, page: $page, state: active, order_by: created_at) { ${BOARD_FIELDS} } }`;

const FIRST_ITEMS = `${ITEM_FIELDS}
query BoardItems($board: ID!, $limit: Int!, $rules: [ItemsQueryRule!]) {
  boards(ids: [$board]) { items_page(limit: $limit, query_params: { rules: $rules, operator: and }) { cursor items { ...ItemFields } } }
}`;

const NEXT_ITEMS = `${ITEM_FIELDS}
query NextItems($cursor: String!, $limit: Int!) { next_items_page(cursor: $cursor, limit: $limit) { cursor items { ...ItemFields } } }`;

const SEARCH_ITEMS = `${ITEM_FIELDS}
query SearchItems($ids: [ID!], $limit: Int!, $rules: [ItemsQueryRule!]) {
  boards(ids: $ids) { id items_page(limit: $limit, query_params: { rules: $rules, operator: and }) { cursor items { ...ItemFields } } }
}`;

const USERS = `query Users($ids: [ID!]) { users(ids: $ids) { id name email photo_thumb_small } }`;

const boardsPage = async (c: MondayCreds, page: number): Promise<MondayBoard[]> => (await gql<{ boards: MondayBoard[] }>(c, "Boards", BOARDS, { limit: BOARDS_PER_PAGE, page })).boards;

/** The people behind some ids, asked for in as few calls as monday allows. */
async function usersOf(c: MondayCreds, ids: string[]): Promise<Map<string, MondayUser>> {
  const out = new Map<string, MondayUser>();
  const want = [...new Set(ids)];
  for (let i = 0; i < want.length; i += 50) {
    const d = await gql<{ users: MondayUser[] }>(c, "Users", USERS, { ids: want.slice(i, i + 50) });
    for (const u of d.users) out.set(u.id, u);
  }
  return out;
}

/** A shape without people: for statuses, which have none. */
const bareShape = (x: X): Shape => ({ connId: x.conn.id, zone: x.conn.timeZone, categories: x.conn.options.categories, users: new Map(), now: Date.now() });

/** What shaping some items needs: the connection's, and the names of the people in their columns. */
async function shapeFor(x: X, c: MondayCreds, items: MondayItem[]): Promise<Shape> {
  return { connId: x.conn.id, zone: x.conn.timeZone, categories: x.conn.options.categories, users: await usersOf(c, items.flatMap(personIds)), now: Date.now() };
}

async function issuesOf(x: X, c: MondayCreds, items: MondayItem[]): Promise<RemoteIssue[]> {
  const sh = await shapeFor(x, c, items);
  return items.map((i) => toRemoteIssue(sh, i));
}

/** An item by id: null when there is none, or it was deleted (monday still answers for those, with state "deleted"). */
async function itemBy(c: MondayCreds, ref: { remoteId?: string; key?: string }): Promise<MondayItem | null> {
  const id = itemIdOf(ref);
  if (!id) return null;
  const d = await gql<{ items: MondayItem[] }>(c, "Items", ITEMS_BY_ID, { ids: [id] });
  const i = d.items[0];
  return i && i.state !== "deleted" && i.board ? i : null;
}

async function mustItem(c: MondayCreds, ref: IssueRef): Promise<MondayItem> {
  const i = await itemBy(c, ref);
  if (!i) throw new ProviderError("notFound", `monday: no item ${ref.key}`);
  return i;
}

/** UTC day of a moment (YYYY-MM-DD): the finest a last-updated filter takes. */
const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const ACTIVITY = `query Activity($board: ID!, $from: ISO8601DateTime, $to: ISO8601DateTime, $items: [ID!], $limit: Int, $page: Int) {
  boards(ids: [$board]) { activity_logs(from: $from, to: $to, item_ids: $items, limit: $limit, page: $page) { id event data created_at user_id } }
}`;

const activityPage = async (c: MondayCreds, board: string, page: number, o: { from?: number; to?: number; item?: string }): Promise<MondayActivity[]> => {
  const d = await gql<{ boards: { activity_logs: MondayActivity[] }[] }>(c, "Activity", ACTIVITY, {
    board,
    from: o.from === undefined ? null : new Date(o.from).toISOString(),
    to: o.to === undefined ? null : new Date(o.to).toISOString(),
    items: o.item ? [o.item] : null,
    limit: LOG_PAGE,
    page,
  });
  return d.boards[0]?.activity_logs ?? [];
};

// ---------- Markdown to monday's HTML ----------

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline Markdown as the HTML an update keeps: strong, emphasis, links; code is written as text. */
function inline(text: string, note: (f: NonNullable<ConversionWarning["feature"]>) => void): string {
  const parts = text.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|\b_[^_\n]+_\b|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`)/);
  return parts
    .map((p, n) => {
      if (n % 2 === 0) return escapeHtml(p);
      if (p.startsWith("**") || p.startsWith("__")) return `<strong>${escapeHtml(p.slice(2, -2))}</strong>`;
      if (p.startsWith("`")) {
        note("code");
        return escapeHtml(p.slice(1, -1));
      }
      if (p.startsWith("[")) {
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
        if (m && SAFE_URL.test(m[2])) return `<a href="${escapeHtml(m[2]).replace(/"/g, "&quot;")}">${escapeHtml(m[1])}</a>`;
        return escapeHtml(m ? m[1] : p);
      }
      return `<em>${escapeHtml(p.slice(1, -1))}</em>`;
    })
    .join("");
}

/**
 * Markdown as the HTML of a monday update: paragraphs, strong, emphasis,
 * links and lists. What it can't keep (headings, quotes, code, tables,
 * images) is written as plain paragraphs and said so.
 */
export function toMondayHtml(md: string): { html: string; warnings: ConversionWarning[] } {
  const warnings = new Map<string, ConversionWarning>();
  const approximate = (feature: NonNullable<ConversionWarning["feature"]>) => warnings.set(feature, { code: "approximated", feature, serverDetail: `markdown ${feature} sent to monday as plain text` });
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let fenced = false;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      approximate("codeBlock");
      continue;
    }
    if (fenced) {
      flush();
      out.push(`<p>${escapeHtml(line)}</p>`);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(inline(item[2], approximate));
      continue;
    }
    flush();
    if (line.trim() === "") continue;
    let text = line;
    if (/^#{1,6}\s/.test(text)) {
      approximate("heading");
      text = text.replace(/^#{1,6}\s+/, "");
    }
    if (/^>\s?/.test(text)) {
      approximate("quote");
      text = text.replace(/^>\s?/, "");
    }
    if (/^\|.*\|\s*$/.test(text)) approximate("table");
    if (/!\[[^\]]*\]\([^)]+\)/.test(text)) approximate("image");
    out.push(`<p>${inline(text, approximate)}</p>`);
  }
  flush();
  return { html: out.join(""), warnings: [...warnings.values()] };
}

const toRemoteComment = (u: MondayUpdate): RemoteComment => ({
  id: u.id,
  // An update whose author left has no creator.
  author: u.creator ? person(u.creator) : { remoteId: "deleted-user", name: "Deleted user", avatarUrl: null },
  body: { kind: "text", format: "html", text: u.body },
  createdAt: instantFrom(u.created_at),
  updatedAt: instantFrom(u.updated_at),
});

// ---------- The provider ----------

export const mondayProvider: TrackerProvider<"monday", MondayOptions> = {
  // Deliveries carry a JWT in Authorization, signed with the app's signing secret.
  webhook: {
    verify: (req, secret) => mondayWebhook.verify({ secret, headers: req.headers }),
    deliveryId: (req) => mondayWebhook.deliveryId(req.body),
    sentAt: (req) => mondayWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "monday",
  capabilities: mondayCapabilities,
  traits: mondayTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `monday options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, text): IssueHandle | null {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      // https://acme.monday.com/boards/<board>/pulses/<item>, or …/boards/<board>/views/<view>/pulses/<item>
      const url = new URL(text.trim());
      if (url.protocol !== "https:" || !isMondayHost(url.hostname)) return null;
      const m = /^\/boards\/(\d{1,19})(?:\/views\/\d{1,19})?\/pulses\/(\d{1,19})\/?$/.exec(url.pathname);
      return m ? { remoteId: m[2], key: keyOf(m[1], m[2]) } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const d = await gql<{ me: MondayUser }>(await credsOf(x), "Me", `query Me { me { id name email photo_thumb_small } }`);
    return { ...person(d.me), ...(d.me.email ? { login: d.me.email, email: d.me.email } : {}) };
  },

  async probe(x) {
    const c = await credsOf(x);
    const boards = await allPages(BOARDS_PER_PAGE, (p) => boardsPage(c, p), 20);
    // One source per board (the status column and its labels are the board's).
    const activeSources = boards.filter(usable).map<ActiveWorkflowSource>((b) => ({
      kind: "projectField",
      transitions: "direct",
      ref: { kind: "projectField", fieldRemoteId: statusColumn(b.columns)!.id, containerRemoteId: b.id },
      name: b.name,
    }));
    // monday counts per minute and per day, by plan, and by query complexity: no figure to read, a conservative typical one.
    return { capabilities: mondayCapabilities, activeSources, rateLimit: { perHour: 30_000, origin: "typical" }, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    let at: PageAt = decodePageToken<PageAt>(x.conn, "issues", V, q.since, q.page) ?? { page: 1, b: 0, phase: "items", cursor: null, at: Date.now() };
    const last = { last: true as const, items: [] as RemoteIssue[], gone: [] as { remoteId: string; reason: "deleted" }[], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at.at - OVERLAP_MS } satisfies Since) };
    const next = (p: PageAt, items: RemoteIssue[], gone: { remoteId: string; reason: "deleted" }[]) => ({ last: false as const, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, p) });
    const nextBoard = (p: PageAt): PageAt => ({ ...p, b: p.b + 1, phase: "items", cursor: null });

    let boards = await boardsPage(c, at.page);
    for (;;) {
      const board = boards[at.b];
      if (!board) {
        // A short page was the last one.
        if (boards.length < BOARDS_PER_PAGE) return last;
        at = { ...at, page: at.page + 1, b: 0, phase: "items", cursor: null };
        boards = await boardsPage(c, at.page);
        continue;
      }
      if (!usable(board)) {
        at = nextBoard(at);
        continue;
      }

      if (at.phase === "items") {
        type Items = { cursor: string | null; items: MondayItem[] };
        let got: Items;
        try {
          if (at.cursor) got = (await gql<{ next_items_page: Items }>(c, "NextItems", NEXT_ITEMS, { cursor: at.cursor, limit: PER_PAGE })).next_items_page;
          else {
            const rules: unknown[] = [{ column_id: peopleColumn(board.columns)!.id, compare_value: [`person-${x.conn.remoteAccountId}`], operator: "any_of" }];
            // The last-updated filter takes a day, not a moment, and counts days in its own zone: a day early, then the exact cut here.
            if (since !== null) rules.push({ column_id: "__last_updated__", compare_value: ["EXACT", dayText(since - 86_400_000)], operator: "greater_than_or_equals" });
            got = (await gql<{ boards: { items_page: Items }[] }>(c, "BoardItems", FIRST_ITEMS, { board: board.id, limit: PER_PAGE, rules })).boards[0]?.items_page ?? { cursor: null, items: [] };
          }
        } catch (e) {
          // A board the user lost sight of meanwhile.
          if (e instanceof ProviderError && (e.kind === "notFound" || e.kind === "forbidden") && !at.cursor) {
            at = nextBoard(at);
            continue;
          }
          throw e;
        }
        const fresh = got.items.filter((i) => i.state === "active" && (since === null || (instantFrom(i.updated_at) ?? Infinity) >= since));
        const items = await issuesOf(x, c, fresh);
        if (got.cursor) return next({ ...at, cursor: got.cursor }, items, []);
        return next(since !== null ? { ...at, phase: "gone", cursor: null } : nextBoard(at), items, []);
      }

      // What left this board since the last pass: the activity log says deleted and archived items.
      const logs = await allPages(LOG_PAGE, (p) => activityPage(c, board.id, p, { from: since ?? undefined, to: at.at }), 20);
      const ids = new Set<string>();
      for (const l of logs) if (l.event === "delete_pulse" || l.event === "archive_pulse") {
        const id = idStr(rec(parseJson(l.data)).pulse_id);
        if (id) ids.add(id);
      }
      return next(nextBoard(at), [], [...ids].map((remoteId) => ({ remoteId, reason: "deleted" as const })));
    }
  },

  async getIssue(x, ref) {
    const c = await credsOf(x);
    const i = await itemBy(c, ref);
    return i ? (await issuesOf(x, c, [i]))[0] : null;
  },

  async findIssue(x, handle) {
    const c = await credsOf(x);
    // A key from before a move still leads to the item (the id is what counts), under its new key.
    const i = await itemBy(c, handle);
    return i ? { kind: "found", issue: (await issuesOf(x, c, [i]))[0] } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    const c = await credsOf(x);
    // A few boards a query, a few items each: every item weighs on the complexity budget (a query over 5,000,000 points is refused).
    const per = Math.min(25, Math.max(1, limit));
    const found: MondayItem[] = [];
    let complete = true;
    // monday has no search across boards: the boards are asked, a page of them at a time.
    for (let page = 1; page <= 4 && found.length <= limit; page++) {
      const all = await boardsPage(c, page);
      const boards = all.filter((b) => b.type !== "document");
      for (let i = 0; i < boards.length && found.length <= limit; i += SEARCH_BOARDS) {
        const rules = [{ column_id: "name", compare_value: [text.trim()], operator: "contains_text" }];
        const d = await gql<{ boards: { items_page: { cursor: string | null; items: MondayItem[] } }[] }>(c, "SearchItems", SEARCH_ITEMS, { ids: boards.slice(i, i + SEARCH_BOARDS).map((b) => b.id), limit: per, rules });
        for (const b of d.boards) {
          found.push(...b.items_page.items.filter((it) => it.state === "active"));
          if (b.items_page.cursor) complete = false;
        }
      }
      if (all.length < BOARDS_PER_PAGE) break;
      if (page === 4) complete = false;
    }
    if (found.length > limit) complete = false;
    return { items: await issuesOf(x, c, found.slice(0, limit)), complete };
  },

  async statuses(x, source) {
    if (source.ref.kind !== "projectField") return [];
    const c = await credsOf(x);
    const { fieldRemoteId, containerRemoteId } = source.ref;
    const d = await gql<{ boards: MondayBoard[] }>(c, "Board", `query Board($ids: [ID!]) { boards(ids: $ids) { ${BOARD_FIELDS} } }`, { ids: [containerRemoteId] });
    const col = d.boards[0]?.columns.find((k) => k.id === fieldRemoteId);
    if (!col) throw new ProviderError("notFound", `monday: no status column ${fieldRemoteId} on board ${containerRemoteId}`);
    const sh = bareShape(x);
    return labelsOf(col).filter((l) => l.name !== "").map((l) => statusOf(sh, { id: containerRemoteId }, col, l));
  },

  async description(x, ref) {
    const i = await mustItem(await credsOf(x), ref);
    const col = descriptionColumn(i.board?.columns ?? []);
    const text = col ? str(rec(parseJson(i.column_values.find((v) => v.id === col.id)?.value)).text) : null;
    return text ? { kind: "text", format: "plain", text } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const i = await mustItem(c, ref);
      const board = i.board!;
      const col = statusColumn(board.columns);
      if (!col) return [];
      const now = i.column_values.find((v) => v.id === col.id)?.value;
      const current = rec(parseJson(now)).index;
      const sh = bareShape(x);
      // Any label of the column, from any other: monday has no transition table.
      return labelsOf(col)
        .filter((l) => l.name !== "" && l.index !== current)
        .map<Transition>((l) => ({ id: String(l.index), name: l.name, to: statusOf(sh, board, col, l), requirements: [], remoteUrl: i.url }));
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const i = await mustItem(c, ref);
      const col = statusColumn(i.board!.columns);
      if (!col) throw new ProviderError("invalid", `monday: board ${i.board!.id} has no status column`);
      const index = Number(transitionId);
      if (!Number.isInteger(index)) throw new ProviderError("invalid", `monday: not a label: ${transitionId}`);
      const d = await gql<{ change_column_value: MondayItem | null }>(
        c,
        "ChangeStatus",
        `${ITEM_FIELDS}
mutation ChangeStatus($board: ID!, $item: ID!, $column: String!, $value: JSON!) { change_column_value(board_id: $board, item_id: $item, column_id: $column, value: $value) { ...ItemFields } }`,
        // The value is JSON inside a string: a label by its index (never its name, which is the board's own).
        { board: i.board!.id, item: i.id, column: col.id, value: JSON.stringify({ index }) },
        { write: true },
      );
      return d.change_column_value ? (await issuesOf(x, c, [d.change_column_value]))[0] : null;
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const id = itemIdOf(ref);
      if (!id) throw new ProviderError("notFound", `monday: no item ${ref.key}`);
      const q = `query Updates($ids: [ID!], $limit: Int!, $page: Int!) { items(ids: $ids) { id updates(limit: $limit, page: $page) { ${UPDATE_FIELDS} replies { ${UPDATE_FIELDS} } } } }`;
      let seen = false;
      const all = await allPages(100, async (page) => {
        const d = await gql<{ items: { updates: MondayUpdate[] }[] }>(c, "Updates", q, { ids: [id], limit: 100, page });
        if (d.items[0]) seen = true;
        return d.items[0]?.updates ?? [];
      });
      if (!seen) throw new ProviderError("notFound", `monday: no item ${ref.key}`);
      // Newest first, with replies inside: a flat list, oldest first.
      return all
        .flatMap((u) => [u, ...(u.replies ?? [])])
        .map(toRemoteComment)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    },
    async add(x, ref, body) {
      const id = itemIdOf(ref);
      if (!id) throw new ProviderError("notFound", `monday: no item ${ref.key}`);
      const { html, warnings } = toMondayHtml(body);
      const d = await gql<{ create_update: MondayUpdate | null }>(
        await credsOf(x),
        "CreateUpdate",
        `mutation CreateUpdate($item: ID!, $body: String!) { create_update(item_id: $item, body: $body) { ${UPDATE_FIELDS} } }`,
        { item: id, body: html },
        { write: true },
      );
      return { comment: d.create_update ? toRemoteComment(d.create_update) : null, warnings };
    },
  },

  async history(x, ref) {
    const c = await credsOf(x);
    const i = await mustItem(c, ref);
    const logs = await allPages(LOG_PAGE, (p) => activityPage(c, i.board!.id, p, { item: i.id }), 50);
    const titles = new Map((i.board?.columns ?? []).map((k) => [k.id, k.title]));
    const parsed = logs.map((l) => ({ l, data: rec(parseJson(l.data)) }));
    // People appear as ids in a cell's JSON and as a user id on the log: one lookup for all.
    const ids = parsed.flatMap(({ l, data }) => [l.user_id, ...peopleIn(data.value), ...peopleIn(data.previous_value)]).filter((v): v is string => typeof v === "string");
    const users = await usersOf(c, ids);
    return parsed.flatMap(({ l, data }) => toChanges(l, data, titles, users)).sort((a, b) => a.at - b.at);
  },
};

// ---------- History ----------

const peopleIn = (v: unknown): string[] => {
  const list = rec(v).personsAndTeams;
  return Array.isArray(list) ? list.filter((p) => rec(p).kind === "person").flatMap((p) => idStr(rec(p).id) ?? []) : [];
};

/** What a cell's JSON says, as text people read (and the raw value beside it). */
function cellValues(type: string, v: unknown, users: Map<string, MondayUser>): ChangeValue[] {
  const o = rec(v);
  if (Object.keys(o).length === 0) return [];
  const label = rec(o.label);
  if (typeof label.text === "string") return label.text === "" ? [] : [{ text: label.text, ...(typeof label.index === "number" ? { id: String(label.index) } : {}) }];
  if (type === "people" || type === "multiple-person") return peopleIn(o).map((id) => ({ text: users.get(id)?.name ?? `User ${id}`, id }));
  const date = str(o.date);
  if (date) return [{ text: str(o.time) ? `${date} ${String(o.time)}` : date, raw: date }];
  const text = str(o.text) ?? str(o.value);
  return text ? [{ text }] : [];
}

/** One activity-log entry as a change (create and move events carry no field and are left out). */
export function toChanges(l: MondayActivity, data: Record<string, unknown>, titles: Map<string, string>, users: Map<string, MondayUser>): RemoteChange[] {
  const ms = activityMs(l.created_at);
  if (ms === null) return [];
  const at = instant(ms);
  const user = l.user_id ? users.get(l.user_id) : undefined;
  const actor = user ? person(user) : null;
  if (l.event === "update_name") {
    const to = str(data.name);
    const from = str(data.previous_name);
    return to || from ? [{ at, actor, field: { id: "name", name: "Name" }, from: from ? [{ text: from }] : [], to: to ? [{ text: to }] : [] }] : [];
  }
  if (l.event === "update_column_value") {
    const id = str(data.column_id);
    if (!id) return [];
    const type = str(data.column_type) ?? "";
    return [{ at, actor, field: { id, name: str(data.column_title) ?? titles.get(id) ?? id }, from: cellValues(type, data.previous_value, users), to: cellValues(type, data.value, users) }];
  }
  return [];
}

// ---------- Webhooks ----------

type Headers_ = Headers | Record<string, string | string[] | undefined>;
const header = (h: Headers_, name: string): string | undefined => {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name);
  return Array.isArray(hit?.[1]) ? hit[1][0] : hit?.[1];
};
const b64url = (b: Buffer) => b.toString("base64url");

/**
 * monday's webhooks. `Authorization` holds a JWT (HS256) signed with the
 * app's signing secret, carrying an `exp`. A new subscription is first sent
 * `{"challenge": "…"}` and wants the same JSON back (`challengeOf`); every
 * later delivery is `{"event": {…}}` with a `triggerUuid` to refuse replays by.
 */
export const mondayWebhook = {
  verify(a: { secret: string; headers: Headers_; now?: number }): boolean {
    const given = header(a.headers, "authorization")?.replace(/^Bearer\s+/i, "").trim();
    const parts = given?.split(".");
    if (!parts || parts.length !== 3) return false;
    const [h, p, s] = parts;
    try {
      // Only HS256: a token naming another algorithm ("none") is not ours.
      if (rec(JSON.parse(Buffer.from(h, "base64url").toString("utf8"))).alg !== "HS256") return false;
      const expected = createHmac("sha256", a.secret).update(`${h}.${p}`).digest();
      const got = Buffer.from(s, "base64url");
      if (got.length !== expected.length || !timingSafeEqual(got, expected) || b64url(got) !== s) return false;
      const exp = rec(JSON.parse(Buffer.from(p, "base64url").toString("utf8"))).exp;
      return typeof exp === "number" && exp * 1000 > (a.now ?? Date.now());
    } catch {
      return false;
    }
  },
  deliveryId(rawBody: string): string | null {
    const e = rec(rec(parseJson(rawBody)).event);
    return str(e.triggerUuid) ?? str(e.originalTriggerUuid);
  },
  sentAt(rawBody: string): Instant | null {
    const e = rec(rec(parseJson(rawBody)).event);
    const ms = Date.parse(str(e.triggerTime) ?? "");
    return Number.isFinite(ms) && ms > 0 ? instant(ms) : null;
  },
  /** The body to answer a subscription's challenge with (the same JSON), or null when the delivery is not one. */
  challengeOf(rawBody: string): string | null {
    const c = rec(parseJson(rawBody)).challenge;
    return typeof c === "string" && c !== "" ? JSON.stringify({ challenge: c }) : null;
  },
};
