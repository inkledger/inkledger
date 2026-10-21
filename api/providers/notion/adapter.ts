// Notion as a tracker, through the provider contract. The items are the pages
// of one database (options.database) whose people property (default
// "Assignee") holds the user, keyed by the page's id (32 hex characters, as
// in its URL: Notion has no shorter key). A page's status is its "Status"
// property, a native `status` property (its three groups give the category:
// To-do, In progress, Complete) or a `select` one (no meaning at all: the
// connection's own mapping, options.categories, gives the category, "todo"
// otherwise). Notion keeps no time inkledger can use: the time stays in
// inkledger's own register.
//
// An integration token is a bot. An internal integration belongs to the
// workspace, not to a person, so the person is named in options.user (id or
// email); a public integration names the user who authorized it.
import { z } from "zod";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, jsonPayload, localDate, localDateOf, type JsonValue, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { verifySha256Header } from "../core/webhooks";
import {
  mappingId,
  mappingVersion,
  type ActiveWorkflowSource,
  type CallContext,
  type ConversionWarning,
  type IssueHandle,
  type RemoteBody,
  type RemoteComment,
  type RemoteIssue,
  type RemotePerson,
  type RemoteStatus,
  type ReportedIssueGone,
  type TrackerProvider,
  type Transition,
} from "../types";
import {
  dashed,
  nt,
  ntAll,
  ntList,
  ntOk,
  type NotionBlock,
  type NotionColumn,
  type NotionComment,
  type NotionCreds,
  type NotionDatabase,
  type NotionPage,
  type NotionRichText,
  type NotionUser,
  type NotionValue,
} from "./client";

// The catalogue's entry for notion, here where the adapter keeps to it (the
// registry holds the two together).
export const notionCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["rich"], writePreserves: ["paragraph", "emphasis", "strong", "code", "link"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: false,
  inbox: false,
  otherFields: false,
  history: false,
  workflow: { sources: [{ kind: "projectField", transitions: "direct" }] },
  time: { mode: "local", remoteTotals: false },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const notionTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: false, upload: false },
  timeboxes: [],
  fields: ["priority", "due", "start", "estimate", "points", "labels", "multiAssignee", "custom"],
};

/** A page or database id, as 32 hex characters or dashed; kept as 32 lower-case hex. */
const ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const bare = (id: string) => id.replace(/-/g, "").toLowerCase();

const optionsSchema = z.strictObject({
  /** The database whose pages are the items (its id, from its URL) */
  database: z
    .string()
    .trim()
    .regex(ID, "database is the 32 characters of the database's id")
    .transform(bare),
  /** Whose pages these are: a Notion user id or an email (an internal integration belongs to no one) */
  user: z.string().trim().min(1).max(200).optional(),
  /** The names of the properties that matter */
  status: z.string().trim().min(1).max(200).default("Status"),
  assignee: z.string().trim().min(1).max(200).default("Assignee"),
  due: z.string().trim().min(1).max(200).optional(),
  /**
   * The category of each status option, by its id or its name (any case): what
   * a `select` property needs (it has no meaning of its own) and what a `status`
   * one may override.
   */
  categories: z.record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES)).default({}),
});
export type NotionOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"notion", NotionOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
/** What a pass leaves: when it began and the ids it saw (to tell what was deleted). */
type Since = { at: number; ids: string[] };
type PageState = { cursor: string; at: number };

/**
 * Overlap read again at each pass: last_edited_time is rounded to the minute,
 * so a change made after the checkpoint can carry a time up to a minute older.
 */
const OVERLAP_MS = 120_000;
/** Ids kept in a checkpoint to find the deleted ones. */
const MAX_IDS = 500;

function credsOf(x: X, secret: Awaited<ReturnType<X["conn"]["credential"]>>): NotionCreds {
  return { apiBase: x.conn.baseUrl, token: secret.kind === "token" ? secret.token : secret.kind === "oauth" ? secret.accessToken : secret.password };
}
async function creds(x: X): Promise<NotionCreds> {
  return credsOf(x, await x.conn.credential());
}

// ---------- Keys and links ----------

const normalizeKey = (raw: string) => {
  const t = raw.trim();
  return ID.test(t) ? bare(t) : null;
};

// ---------- Rich text ----------

/** A rich text as CommonMark (what the app reads of a "rich" body). */
export function richToMarkdown(rt: NotionRichText[]): string {
  return rt
    .map((r) => {
      let t = r.plain_text;
      if (t === "") return "";
      const a = r.annotations ?? {};
      if (a.code) t = `\`${t}\``;
      else {
        if (a.strikethrough) t = `~~${t}~~`;
        if (a.italic) t = `*${t}*`;
        if (a.bold) t = `**${t}**`;
      }
      return r.href ? `[${t}](${r.href})` : t;
    })
    .join("");
}

/** Notion's limits on one rich text. */
export const RICH_TEXT_MAX = 2000;
export const RICH_ELEMENTS_MAX = 100;

type RichOut = { type: "text"; text: { content: string; link?: { url: string } }; annotations?: { bold?: boolean; italic?: boolean; code?: boolean } };
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)/g;

/** Markdown as the rich text a comment takes: paragraphs, bold, italic, code and links; no text over 2,000 characters in one element. */
export function markdownToRichText(md: string): RichOut[] {
  const out: RichOut[] = [];
  const push = (content: string, extra: Omit<RichOut, "type" | "text"> & { link?: { url: string } } = {}) => {
    for (let i = 0; i < content.length; i += RICH_TEXT_MAX) {
      const { link, ...rest } = extra;
      out.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_MAX), ...(link ? { link } : {}) }, ...rest });
    }
  };
  const text = md.replace(/\r\n?/g, "\n").trim();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) push(text.slice(last, m.index));
    const [whole] = m;
    if (m[1]) push(whole.slice(1, -1), { annotations: { code: true } });
    else if (m[2]) push(whole.slice(2, -2), { annotations: { bold: true } });
    else if (m[3]) {
      const at = whole.indexOf("](");
      push(whole.slice(1, at), { link: { url: whole.slice(at + 2, -1) } });
    } else push(whole.slice(1, -1), { annotations: { italic: true } });
    last = m.index + whole.length;
  }
  if (last < text.length) push(text.slice(last));
  if (out.length > RICH_ELEMENTS_MAX) throw new ProviderError("invalid", `Notion: a comment takes at most ${RICH_ELEMENTS_MAX} pieces of text and formatting`);
  return out;
}

/** What markdown the comment keeps only as text: block features of the text (Notion's comments have none of them). */
const BLOCKS: [ConversionWarning["feature"], RegExp][] = [
  ["codeBlock", /^```/m],
  ["heading", /^#{1,6} /m],
  ["list", /^\s*([-*+]|\d+\.) /m],
  ["quote", /^> /m],
  ["table", /^\|.*\|$/m],
  ["image", /!\[[^\]]*\]\([^)]+\)/],
];
const warningsFor = (md: string): ConversionWarning[] =>
  BLOCKS.filter(([, re]) => re.test(md)).map(([feature]) => ({ code: "approximated" as const, feature, serverDetail: `markdown ${String(feature)} sent to Notion as text` }));

const asJson = (v: unknown, max = 1 << 20): JsonValue => jsonPayload(v, max) ?? [];

const toBody = (rt: NotionRichText[]): RemoteBody => ({ kind: "structured", format: "rich", payload: asJson(rt), preview: richToMarkdown(rt) });

const richOf = (b: NotionBlock): NotionRichText[] => {
  const content = b[b.type];
  const rt = typeof content === "object" && content !== null ? (content as { rich_text?: unknown }).rich_text : undefined;
  return Array.isArray(rt) ? (rt as NotionRichText[]) : [];
};

/** The text blocks of a page's body as CommonMark; the ones with no text (images, embeds) and the ones inside others are left out. */
export function blocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: { text: string; list: boolean }[] = [];
  let n = 0;
  for (const b of blocks) {
    const t = richToMarkdown(richOf(b));
    n = b.type === "numbered_list_item" ? n + 1 : 0;
    switch (b.type) {
      case "paragraph":
        if (t) lines.push({ text: t, list: false });
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3":
        lines.push({ text: `${"#".repeat(Number(b.type.slice(-1)))} ${t}`, list: false });
        break;
      case "bulleted_list_item":
        lines.push({ text: `- ${t}`, list: true });
        break;
      case "numbered_list_item":
        lines.push({ text: `${n}. ${t}`, list: true });
        break;
      case "to_do":
        lines.push({ text: `- [${(b.to_do as { checked?: boolean } | undefined)?.checked ? "x" : " "}] ${t}`, list: true });
        break;
      case "quote":
      case "callout":
        lines.push({ text: `> ${t}`, list: false });
        break;
      case "code":
        lines.push({ text: `\`\`\`${(b.code as { language?: string } | undefined)?.language ?? ""}\n${richOf(b).map((r) => r.plain_text).join("")}\n\`\`\``, list: false });
        break;
      case "divider":
        lines.push({ text: "---", list: false });
        break;
      default:
        break;
    }
  }
  // List items follow each other; everything else is a paragraph apart.
  return lines.reduce((acc, l, i) => acc + (i === 0 ? "" : l.list && lines[i - 1].list ? "\n" : "\n\n") + l.text, "");
}

// ---------- Shapes ----------

const person = (u: NotionUser): RemotePerson => ({ remoteId: u.id, name: u.name || u.person?.email || u.id, avatarUrl: u.avatar_url ?? null });

/** What turning a page into the layer's shape needs of its connection. */
type Shape = { connId: number; zone: TimeZone; categories: NotionOptions["categories"] };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, zone: x.conn.timeZone, categories: x.conn.options.categories });

/** The database's schema as this connection reads it. */
type Schema = { db: NotionDatabase; title: NotionColumn; status: NotionColumn; assignee: NotionColumn; due: NotionColumn | null };

const dbTitle = (db: NotionDatabase) => db.title.map((t) => t.plain_text).join("") || "Untitled";

async function schemaOf(x: X, c: NotionCreds): Promise<Schema> {
  const o = x.conn.options;
  const r = await nt<NotionDatabase>(c, `/databases/${dashed(o.database)}`, { missingIsNull: true });
  // Not shared with the integration reads the same as gone.
  if (!r) throw new ProviderError("notFound", "Notion: the database isn't there for this integration (share it with the integration from the database's connections menu)");
  const columns = Object.values(r.data.properties);
  const named = (name: string, types: string[], what: string): NotionColumn => {
    const hit = columns.find((p) => p.name === name);
    if (!hit) throw new ProviderError("invalid", `Notion: the database has no property named "${name}" (${what})`);
    if (!types.includes(hit.type)) throw new ProviderError("invalid", `Notion: the property "${name}" is a ${hit.type} property, ${what} needs ${types.join(" or ")}`);
    return hit;
  };
  const title = columns.find((p) => p.type === "title");
  if (!title) throw new ProviderError("incompatible", "Notion: a database without a title property");
  return {
    db: r.data,
    title,
    status: named(o.status, ["status", "select"], "the status"),
    assignee: named(o.assignee, ["people"], "the assignee"),
    due: o.due ? named(o.due, ["date"], "the due date") : null,
  };
}

/** The value of a property on a page, by the property's id (a page's keys are the names, which people change). */
const valueOf = (p: NotionPage, col: NotionColumn): NotionValue | undefined => Object.values(p.properties).find((v) => v.id === col.id);

const optionsOf = (col: NotionColumn) => col.status?.options ?? col.select?.options ?? [];

/** The categories of a status property's options: the connection's mapping first, then the group of a native status, else "todo". */
export function statusesOf(s: Shape, sc: Schema): RemoteStatus[] {
  const col = sc.status;
  const groups = col.status?.groups ?? [];
  return optionsOf(col).map((o, order) => {
    const lower = o.name.trim().toLowerCase();
    const mapped = s.categories[o.id] ?? Object.entries(s.categories).find(([k]) => k.trim().toLowerCase() === lower)?.[1];
    // Notion's three groups come in this order: To-do, In progress, Complete.
    const g = groups.findIndex((x) => x.option_ids.includes(o.id));
    const native: StatusCategory | null = groups.length === 3 && g >= 0 ? (["todo", "doing", "done"] as const)[g] : null;
    return {
      id: o.id,
      name: o.name,
      category: mapped ?? native ?? "todo",
      categoryOrigin: !mapped && native ? { by: "native" } : { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) },
      source: { kind: "projectField", fieldRemoteId: col.id, containerRemoteId: sc.db.id },
      ...(groups.length === 3 && g >= 0 ? { nativeReason: groups[g].name } : {}),
      ...(o.color ? { color: o.color } : {}),
      order,
    };
  });
}

/** A page with no status yet: not triaged. */
const noStatus = (s: Shape, sc: Schema): RemoteStatus => ({
  id: "none",
  name: "No status",
  category: "triage",
  categoryOrigin: { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) },
  source: { kind: "projectField", fieldRemoteId: sc.status.id, containerRemoteId: sc.db.id },
});

/**
 * A date property as a day: a bare date is the day; an instant with an offset
 * is the day in the user's zone; a time with no offset is written in the
 * property's own time zone, and its date is that zone's.
 */
export function dueOf(v: NotionValue | undefined, zone: TimeZone): LocalDate | null {
  const start = v?.date?.start;
  if (!start || !/^\d{4}-\d{2}-\d{2}/.test(start)) return null;
  if (start.length === 10) return localDate(start);
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(start)) {
    const at = instantFrom(start);
    return at === null ? null : localDateOf(at, zone);
  }
  return localDate(start.slice(0, 10));
}

export function toRemoteIssue(s: Shape, sc: Schema, p: NotionPage): RemoteIssue {
  const statuses = statusesOf(s, sc);
  const v = valueOf(p, sc.status);
  const picked = v?.status ?? v?.select ?? null;
  const t = valueOf(p, sc.title)?.title ?? [];
  return {
    remoteId: p.id,
    key: bare(p.id),
    url: p.url,
    title: t.map((r) => r.plain_text).join("").trim() || "Untitled",
    type: { id: "page", name: "Page", level: "standard" },
    // A removed option still on a page: it keeps its name, with no category of its own.
    status: picked ? (statuses.find((x) => x.id === picked.id) ?? { ...noStatus(s, sc), id: picked.id, name: picked.name, category: "todo" }) : noStatus(s, sc),
    container: { remoteId: sc.db.id, key: bare(sc.db.id), name: dbTitle(sc.db), kind: "database" },
    priority: null,
    labels: [],
    assignees: (valueOf(p, sc.assignee)?.people ?? []).map(person),
    reporter: null,
    due: sc.due ? dueOf(valueOf(p, sc.due), s.zone) : null,
    estimateSeconds: null,
    createdAt: instantFrom(p.created_time),
    updatedAt: instantFrom(p.last_edited_time),
    statusChangedAt: null,
    parent: null,
    fields: {},
  };
}

// ---------- Pages ----------

const idOf = (ref: { remoteId: string; key: string }) => ref.remoteId || ref.key;

/**
 * A page of the configured database, null when it isn't there for this
 * integration (deleted for good, never shared, malformed id), is in the trash,
 * is a database's id, or sits elsewhere than the database.
 */
async function pageBy(x: X, c: NotionCreds, idOrKey: string): Promise<NotionPage | null> {
  const id = normalizeKey(idOrKey);
  if (!id) return null;
  let r: { data: NotionPage } | null;
  try {
    r = await nt<NotionPage>(c, `/pages/${dashed(id)}`, { missingIsNull: true });
  } catch (e) {
    // A database's id (from a database link) answers 400: it is no page.
    if (e instanceof ProviderError && e.kind === "invalid" && /is a database/i.test(e.message)) return null;
    throw e;
  }
  const p = r?.data;
  if (!p || p.archived || p.in_trash) return null;
  return p.parent.type === "database_id" && bare(p.parent.database_id) === x.conn.options.database ? p : null;
}

async function issueBy(x: X, c: NotionCreds, idOrKey: string): Promise<RemoteIssue | null> {
  const p = await pageBy(x, c, idOrKey);
  return p ? toRemoteIssue(shapeOf(x), await schemaOf(x, c), p) : null;
}

// ---------- Who the user is ----------

/** The person the connection syncs for: options.user, else the owner of a public integration. */
async function userOf(x: X, c: NotionCreds): Promise<NotionUser> {
  const want = x.conn.options.user;
  if (want) {
    if (want.includes("@")) {
      const hit = (await ntAll<NotionUser>(c, "/users")).find((u) => u.person?.email?.toLowerCase() === want.toLowerCase());
      if (!hit) throw new ProviderError("invalid", `Notion: no user with the email ${want} (the integration needs the capability to read user information)`);
      return hit;
    }
    if (!ID.test(want)) throw new ProviderError("invalid", "Notion: options.user is a Notion user id or an email");
    const u = await nt<NotionUser>(c, `/users/${dashed(want)}`, { missingIsNull: true });
    if (!u) throw new ProviderError("notFound", `Notion: no user ${want}`);
    return u.data;
  }
  const bot = await ntOk<NotionUser>(c, "/users/me");
  const owner = bot.bot?.owner;
  if (owner?.type === "user") return owner.user;
  throw new ProviderError("invalid", "Notion: this integration belongs to the workspace, not to a person: set the option \"user\" to your Notion user id or email");
}

// ---------- Query ----------

const queryPath = (db: string) => `/databases/${dashed(db)}/query`;
const mine = (sc: Schema, userId: string) => ({ property: sc.assignee.id, people: { contains: userId } });

/** The ids of every page assigned to the user, as light as a query gets (only the title asked for). */
async function assignedIds(x: X, c: NotionCreds, sc: Schema): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 100; n++) {
    const page: { results: NotionPage[]; next: string | null } = await ntList<NotionPage>(
      c,
      queryPath(x.conn.options.database),
      { method: "POST", intent: "read", query: { filter_properties: sc.title.id }, body: { filter: mine(sc, x.conn.remoteAccountId) } },
      cursor,
    );
    ids.push(...page.results.map((p) => p.id));
    if (!page.next) break;
    cursor = page.next;
  }
  return ids;
}

/** Pages a pass saw before that are no longer assigned: the ones in the trash or removed are deleted; one given to someone else is no departure. */
async function vanished(c: NotionCreds, before: string[], now: Set<string>): Promise<ReportedIssueGone[]> {
  const gone: ReportedIssueGone[] = [];
  for (const id of before) {
    if (now.has(dashed(id))) continue;
    const r = await nt<NotionPage>(c, `/pages/${dashed(id)}`, { missingIsNull: true });
    // Nothing there: deleted for good, or no longer shared.
    if (!r || r.data.archived || r.data.in_trash) gone.push({ remoteId: dashed(id), reason: "deleted" });
  }
  return gone;
}

// ---------- Comments ----------

async function authors(c: NotionCreds, ids: string[]): Promise<Map<string, RemotePerson>> {
  const out = new Map<string, RemotePerson>();
  for (const id of new Set(ids)) {
    let u: { data: NotionUser } | null = null;
    try {
      u = await nt<NotionUser>(c, `/users/${id}`, { missingIsNull: true });
    } catch (e) {
      // Without the capability to read users a comment shows its author's id.
      if (!(e instanceof ProviderError && e.kind === "forbidden")) throw e;
    }
    out.set(id, u ? person(u.data) : { remoteId: id, name: id, avatarUrl: null });
  }
  return out;
}

const toRemoteComment = (cm: NotionComment, who: Map<string, RemotePerson>): RemoteComment => ({
  id: cm.id,
  author: who.get(cm.created_by.id) ?? { remoteId: cm.created_by.id, name: cm.created_by.id, avatarUrl: null },
  body: toBody(cm.rich_text),
  createdAt: instantFrom(cm.created_time),
  updatedAt: instantFrom(cm.last_edited_time),
});

// ---------- Provider ----------

export const notionProvider: TrackerProvider<"notion", NotionOptions> = {
  // Deliveries are signed by Notion with the webhook's verification token (X-Notion-Signature).
  webhook: {
    verify: (req, secret) => notionWebhook.verify({ secret, rawBody: req.body, headers: req.headers }),
    deliveryId: (req) => notionWebhook.deliveryId(req.body),
    sentAt: (req) => notionWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "notion",
  capabilities: notionCapabilities,
  traits: notionTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw);
    if (!r.success) throw new ProviderError("invalid", `Notion options: ${r.error.issues.map((i) => `${i.path.join(".") || "options"}: ${i.message}`).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      // https://www.notion.so/<workspace>/<Title-slug>-<32 hex> or https://www.notion.so/<32 hex>; in a database view the
      // page that is open is ?p=<id> (the path is the database's then).
      const url = new URL(input.trim());
      if (url.protocol !== "https:" || (url.hostname !== "notion.so" && url.hostname !== "www.notion.so")) return null;
      const peeked = normalizeKey(url.searchParams.get("p") ?? "");
      if (peeked) return { key: peeked };
      const last = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
      const m = /(?:^|-)([0-9a-f]{32})$/i.exec(last);
      return m ? { key: bare(m[1]) } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const u = await userOf(x, await creds(x));
    return { ...person(u), ...(u.person?.email ? { email: u.person.email } : {}) };
  },

  async probe(x) {
    const c = await creds(x);
    const sc = await schemaOf(x, c);
    const activeSources: ActiveWorkflowSource[] = [
      { kind: "projectField", transitions: "direct", ref: { kind: "projectField", fieldRemoteId: sc.status.id, containerRemoteId: sc.db.id }, name: `${dbTitle(sc.db)} · ${sc.status.name}` },
    ];
    return {
      capabilities: notionCapabilities,
      activeSources,
      // An average of three requests a second, as documented.
      rateLimit: { perSecond: 3, origin: "typical" },
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const c = await creds(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since);
    const state = decodePageToken<PageState>(x.conn, "issues", V, q.since, q.page);
    const at = state?.at ?? Date.now();
    const sc = await schemaOf(x, c);
    const filter = { and: [mine(sc, x.conn.remoteAccountId), ...(since ? [{ timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(since.at - OVERLAP_MS).toISOString() } }] : [])] };
    const r = await ntList<NotionPage>(
      c,
      queryPath(x.conn.options.database),
      { method: "POST", intent: "read", body: { filter, sorts: [{ timestamp: "last_edited_time", direction: "ascending" }] } },
      state?.cursor ?? null,
    );
    const s = shapeOf(x);
    const items = r.results.filter((p) => !p.archived && !p.in_trash).map((p) => toRemoteIssue(s, sc, p));
    if (r.next) return { last: false as const, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, { cursor: r.next, at } satisfies PageState) };

    // The last page: who is assigned now, to tell what left. A page in the trash is in no query: only reading it says so.
    const ids = await assignedIds(x, c, sc);
    const gone = since ? await vanished(c, since.ids, new Set(ids)) : [];
    const kept = ids.slice(0, MAX_IDS).map(bare);
    return { last: true as const, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at, ids: kept } satisfies Since) };
  },

  async getIssue(x, ref) {
    return issueBy(x, await creds(x), idOf(ref));
  },

  async findIssue(x, handle) {
    const i = await issueBy(x, await creds(x), handle.remoteId ?? handle.key ?? "");
    return i ? { kind: "found", issue: i } : { kind: "none" };
  },

  async searchText(x, input, limit) {
    const c = await creds(x);
    const sc = await schemaOf(x, c);
    const n = Math.min(100, Math.max(1, limit));
    // The database's own filter, not the workspace search: that one is fuzzy, slow to index and not scoped to a database.
    const r = await ntList<NotionPage>(
      c,
      queryPath(x.conn.options.database),
      { method: "POST", intent: "read", body: { filter: { property: sc.title.id, title: { contains: input.trim() } }, sorts: [{ timestamp: "last_edited_time", direction: "descending" }] } },
      null,
      n,
    );
    const s = shapeOf(x);
    return { items: r.results.map((p) => toRemoteIssue(s, sc, p)), complete: r.next === null && limit >= n };
  },

  async statuses(x, source) {
    if (source.ref.kind !== "projectField") return [];
    const sc = await schemaOf(x, await creds(x));
    if (bare(source.ref.containerRemoteId) !== bare(sc.db.id)) return [];
    return statusesOf(shapeOf(x), sc);
  },

  async description(x, ref) {
    const c = await creds(x);
    if (!(await pageBy(x, c, idOf(ref)))) return null;
    // Top-level blocks only: what sits inside a toggle or a column is not read.
    const blocks = await ntAll<NotionBlock>(c, `/blocks/${dashed(normalizeKey(idOf(ref)) ?? idOf(ref))}/children`);
    const preview = blocksToMarkdown(blocks);
    return preview === "" ? null : { kind: "structured", format: "rich", payload: asJson(blocks), preview };
  },

  transitions: {
    async list(x, ref) {
      const c = await creds(x);
      const p = await pageBy(x, c, idOf(ref));
      if (!p) throw new ProviderError("notFound", `Notion: no page ${ref.key}`);
      const sc = await schemaOf(x, c);
      const v = valueOf(p, sc.status);
      const current = (v?.status ?? v?.select)?.id;
      // Any option, from any: a status property has no transition table.
      return statusesOf(shapeOf(x), sc)
        .filter((st) => st.id !== current)
        .map<Transition>((st) => ({ id: st.id, name: st.name, to: st, requirements: [], remoteUrl: p.url }));
    },
    async apply(x, ref, transitionId) {
      const c = await creds(x);
      const sc = await schemaOf(x, c);
      const id = normalizeKey(idOf(ref));
      if (!id) throw new ProviderError("notFound", `Notion: no page ${ref.key}`);
      // Written by the property's id, which survives a rename; the option by its id.
      const p = await ntOk<NotionPage>(c, `/pages/${dashed(id)}`, { method: "PATCH", body: { properties: { [sc.status.id]: { [sc.status.type]: { id: transitionId } } } } });
      return toRemoteIssue(shapeOf(x), sc, p);
    },
  },

  comments: {
    async list(x, ref) {
      const c = await creds(x);
      const id = normalizeKey(idOf(ref));
      if (!id) throw new ProviderError("notFound", `Notion: no page ${ref.key}`);
      // Oldest first. The comments of the page itself: those on one block of its body are listed by that block.
      const all = await ntAll<NotionComment>(c, "/comments", { query: { block_id: dashed(id) } });
      const who = await authors(c, all.map((cm) => cm.created_by.id));
      return all.map((cm) => toRemoteComment(cm, who));
    },
    async add(x, ref, body) {
      const c = await creds(x);
      const id = normalizeKey(idOf(ref));
      if (!id) throw new ProviderError("notFound", `Notion: no page ${ref.key}`);
      const rt = markdownToRichText(body);
      if (rt.length === 0) throw new ProviderError("invalid", "Notion: an empty comment");
      const cm = await ntOk<NotionComment>(c, "/comments", { method: "POST", body: { parent: { page_id: dashed(id) }, rich_text: rt } });
      return { comment: toRemoteComment(cm, await authors(c, [cm.created_by.id])), warnings: warningsFor(body) };
    },
  },
};

// ---------- Webhooks ----------

type Hook = { id?: unknown; timestamp?: unknown; type?: unknown; entity?: unknown };

/**
 * Notion's webhooks: `X-Notion-Signature` is `sha256=` and the hex HMAC-SHA256
 * of the raw body under the subscription's verification token (sent once, in
 * the first request, which has only that token). The delivery's own `id` is
 * what a retry repeats, its `timestamp` (ISO) when it was sent. A delivery is a
 * signal: the page is read again.
 */
export const notionWebhook = {
  verify(a: { secret: string; rawBody: string; headers: Record<string, string> | Headers }): boolean {
    const given = a.headers instanceof Headers ? a.headers.get("x-notion-signature") : Object.entries(a.headers).find(([k]) => k.toLowerCase() === "x-notion-signature")?.[1];
    return verifySha256Header(given ?? undefined, a.secret, a.rawBody);
  },
  parse(rawBody: string): Hook | null {
    try {
      const b: unknown = JSON.parse(rawBody);
      return typeof b === "object" && b !== null ? b : null;
    } catch {
      return null;
    }
  },
  deliveryId(rawBody: string): string | null {
    const id = notionWebhook.parse(rawBody)?.id;
    return typeof id === "string" && id !== "" ? id : null;
  },
  sentAt(rawBody: string): number | null {
    const t = notionWebhook.parse(rawBody)?.timestamp;
    return typeof t === "string" ? instantFrom(t) : null;
  },
  /** Which of the declared events it is; null for the ones inkledger doesn't read. */
  event(rawBody: string): "issueChanged" | "commentAdded" | null {
    const type = notionWebhook.parse(rawBody)?.type;
    if (typeof type !== "string") return null;
    if (type === "comment.created") return "commentAdded";
    // A page deleted is a change too: the next read finds it gone.
    return /^page\.(created|properties_updated|content_updated|moved|deleted|undeleted|locked|unlocked)$/.test(type) ? "issueChanged" : null;
  },
};
