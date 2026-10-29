// Trello as a tracker, through the provider contract. Cards assigned to the
// user, keyed by their shortLink (8 characters, unique on the whole service
// and kept when the card moves to another board; the number on the board,
// idShort, changes with the move). A card's status is the list (column) it
// sits in. Trello gives lists no meaning, so their categories come from the
// connection's own mapping (options.categories), never from a list's name;
// a list nobody mapped is "todo". Trello keeps no time inkledger can use: the
// time stays in inkledger's own register.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDateOf, type Instant, type JsonValue, type TimeZone } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { sameSecret } from "../core/webhooks";
import {
  mappingId,
  mappingVersion,
  type ActiveWorkflowSource,
  type CallContext,
  type ChangeValue,
  type IssueHandle,
  type RemoteChange,
  type RemoteComment,
  type RemoteIssue,
  type RemotePerson,
  type RemoteStatus,
  type ReportedIssueGone,
  type TrackerProvider,
  type Transition,
} from "../types";
import {
  CARD_FIELDS,
  createdAtOfId,
  splitSecret,
  tr,
  trActions,
  trOk,
  type TrelloAction,
  type TrelloBoard,
  type TrelloCard,
  type TrelloCreds,
  type TrelloList,
  type TrelloMember,
} from "./client";
import { statusSteps } from "../core/statusSteps";

// The catalogue's entry for trello, here where the adapter keeps to it (the
// registry holds the two together).
export const trelloCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["commonmark"], writePreserves: ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: true,
  inbox: false,
  otherFields: false,
  history: true,
  statusHistory: true,
  // The list a card sits in; it moves to another list of its board.
  workflow: { sources: [{ kind: "column", transitions: "move" }] },
  time: { mode: "local", remoteTotals: false },
  sync: {
    issueCheckpoints: true,
    // Deleted and archived cards are reported; so is a card the user was taken off.
    gone: { deleted: true, lostAccess: false, movedOut: true, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const trelloTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: false,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: [],
  fields: ["due", "start", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({
  /**
   * The category of each list, by the list's id or by its name (any case).
   * Trello doesn't say what a list means: only what is listed here is read as
   * more than "todo".
   */
  categories: z.record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES)).default({}),
});
export type TrelloOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"trello", TrelloOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };

/** Overlap read again at each pass: Trello stamps activity with its own clock. */
const OVERLAP_MS = 60_000;
/** Boards asked for their action log at the same time (the token's budget is 100 calls per 10 seconds). */
const BOARD_BATCH = 4;
const AVATAR_SIZE = 50;
const MEMBER_FIELDS = "fullName,username,avatarUrl";

async function credsOf(x: X): Promise<TrelloCreds> {
  const cred = await x.conn.credential();
  const secret = secretOf(cred);
  const parts = splitSecret(secret);
  if (!parts) throw new ProviderError("auth", "Trello needs the API key and the token as <key>:<token>");
  return { apiBase: x.conn.baseUrl, ...parts };
}

// ---------- Keys and links ----------

/** The shortLink: 8 letters and digits. */
export const SHORT_LINK = /^[A-Za-z0-9]{8}$/;
const normalizeKey = (raw: string) => (SHORT_LINK.test(raw.trim()) ? raw.trim() : null);

// ---------- Shapes ----------

const person = (m: TrelloMember): RemotePerson => ({
  remoteId: m.id,
  name: m.fullName || m.username || m.id,
  // The avatar address is a base: the size and format are appended.
  avatarUrl: m.avatarUrl ? `${m.avatarUrl}/${AVATAR_SIZE}.png` : null,
  ...(m.username ? { handle: m.username } : {}),
});

/** What turning a card into the layer's shape needs of its connection. */
type Shape = { connId: number; zone: TimeZone; categories: TrelloOptions["categories"] };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, zone: x.conn.timeZone, categories: x.conn.options.categories });

function categoryOf(s: Shape, list: Pick<TrelloList, "id" | "name">): StatusCategory {
  const byId = s.categories[list.id];
  if (byId) return byId;
  const name = list.name.trim().toLowerCase();
  const hit = Object.entries(s.categories).find(([k]) => k.toLowerCase() === name);
  return hit ? hit[1] : "todo";
}

// The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
export function statusOf(s: Shape, list: TrelloList): RemoteStatus {
  return {
    id: list.id,
    name: list.name,
    category: categoryOf(s, list),
    categoryOrigin: { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) },
    source: { kind: "column", boardRemoteId: list.idBoard },
    ...(list.closed ? { nativeReason: "archived list" } : {}),
    order: list.pos,
  };
}

export function toRemoteIssue(s: Shape, card: TrelloCard, board: TrelloBoard, list: TrelloList): RemoteIssue {
  // Not the card's own zone: a due date is an instant, and the user's day is the one in their zone.
  const due = instantFrom(card.due);
  const created = createdAtOfId(card.id);
  const start = instantFrom(card.start);
  const fields: Record<string, JsonValue> = { number: card.idShort, dueComplete: card.dueComplete === true, ...(start ? { start: localDateOf(start, s.zone) } : {}) };
  return {
    remoteId: card.id,
    key: card.shortLink,
    url: card.shortUrl,
    title: card.name,
    type: { id: "card", name: "Card", level: "standard" },
    status: statusOf(s, list),
    container: { remoteId: board.id, key: board.shortLink, name: board.name, kind: "board" },
    priority: null,
    // A label can have a colour and no name.
    labels: (card.labels ?? []).map((l) => l.name?.trim() || l.color || "").filter((n) => n !== ""),
    assignees: (card.members ?? []).map(person),
    reporter: null,
    due: due ? localDateOf(due, s.zone) : null,
    estimateSeconds: null,
    // Trello ids carry their creation time.
    createdAt: created === null ? null : instant(created),
    updatedAt: instantFrom(card.dateLastActivity),
    statusChangedAt: null,
    parent: null,
    fields,
  };
}

// ---------- Boards and lists ----------

const BOARD_FIELDS = "name,shortLink,url,closed";
type Boards = Map<string, TrelloBoard>;

/** The boards the user belongs to, closed ones too, each with its lists (archived ones too). */
async function myBoards(c: TrelloCreds): Promise<Boards> {
  const boards = await trOk<TrelloBoard[]>(c, "/members/me/boards", { query: { filter: "all", fields: BOARD_FIELDS, lists: "all" } });
  return new Map(boards.map((b) => [b.id, b]));
}

/** A board by id: from what is known, else asked for (a card can sit on a board the member list doesn't show). */
async function boardOf(c: TrelloCreds, known: Boards, id: string): Promise<TrelloBoard | null> {
  const hit = known.get(id);
  if (hit) return hit;
  const r = await tr<TrelloBoard>(c, `/boards/${id}`, { query: { fields: BOARD_FIELDS, lists: "all" }, missingIsNull: true });
  if (r) known.set(id, r.data);
  return r?.data ?? null;
}

async function listOf(c: TrelloCreds, board: TrelloBoard, id: string): Promise<TrelloList | null> {
  const hit = board.lists?.find((l) => l.id === id);
  if (hit) return hit;
  return (await tr<TrelloList>(c, `/lists/${id}`, { query: { fields: "name,closed,pos,idBoard" }, missingIsNull: true }))?.data ?? null;
}

/** Cards as issues; one whose board or list the token can't read is left out. */
async function issuesOf(x: X, c: TrelloCreds, cards: TrelloCard[], boards: Boards): Promise<RemoteIssue[]> {
  const s = shapeOf(x);
  const out: RemoteIssue[] = [];
  for (const card of cards) {
    const board = await boardOf(c, boards, card.idBoard);
    const list = board ? await listOf(c, board, card.idList) : null;
    if (board && list) out.push(toRemoteIssue(s, card, board, list));
  }
  return out;
}

const CARD_QUERY = { fields: CARD_FIELDS, members: true, member_fields: MEMBER_FIELDS };

/** A card by id or shortLink, null when it isn't there for this token (deleted, never existed, malformed, on a board it can't read). */
async function cardBy(c: TrelloCreds, idOrLink: string): Promise<TrelloCard | null> {
  return (await tr<TrelloCard>(c, `/cards/${encodeURIComponent(idOrLink)}`, { query: CARD_QUERY, missingIsNull: true }))?.data ?? null;
}

async function issueBy(x: X, c: TrelloCreds, idOrLink: string): Promise<RemoteIssue | null> {
  const card = await cardBy(c, idOrLink);
  return card ? (await issuesOf(x, c, [card], new Map()))[0] ?? null : null;
}

const idOf = (ref: { remoteId: string; key: string }) => ref.remoteId || ref.key;

// ---------- Comments and history ----------

const toRemoteComment = (a: TrelloAction): RemoteComment => ({
  id: a.id,
  author: a.memberCreator ? person(a.memberCreator) : { remoteId: a.idMemberCreator, name: a.idMemberCreator, avatarUrl: null },
  body: { kind: "text", format: "commonmark", text: a.data.text ?? "" },
  createdAt: instantFrom(a.date),
  // An edited comment keeps its action's date and says when it was edited in its data.
  updatedAt: instantFrom(a.data.dateLastEdited ?? a.date),
});

const text = (v: string | null | undefined, id?: string): ChangeValue[] => (v === null || v === undefined || v === "" ? [] : [{ text: v, ...(id ? { id } : {}), raw: v }]);

/** One action may change several fields at once (updateCard): one change per field. */
export function toChanges(a: TrelloAction): RemoteChange[] {
  const at = instantFrom(a.date);
  if (at === null) return [];
  const actor = a.memberCreator ? person(a.memberCreator) : null;
  const out: RemoteChange[] = [];
  const push = (field: RemoteChange["field"], from: ChangeValue[], to: ChangeValue[]) => out.push({ at, actor, field, from, to });
  const d = a.data;
  switch (a.type) {
    case "updateCard": {
      const old = d.old ?? {};
      if (d.listBefore || d.listAfter) push({ id: "idList", name: "Status" }, text(d.listBefore?.name, d.listBefore?.id), text(d.listAfter?.name, d.listAfter?.id));
      if (old.name !== undefined) push({ id: "name", name: "Title" }, text(old.name), text(d.card?.name));
      if (old.desc !== undefined) push({ id: "desc", name: "Description" }, text(old.desc), text(d.card?.desc));
      if ("due" in old) push({ id: "due", name: "Due date" }, text(old.due), text(d.card?.due));
      if (old.closed !== undefined) push({ id: "closed", name: "Archived" }, [{ text: String(old.closed), raw: old.closed }], [{ text: String(d.card?.closed ?? !old.closed), raw: d.card?.closed ?? !old.closed }]);
      if (old.dueComplete !== undefined) push({ id: "dueComplete", name: "Due date done" }, [{ text: String(old.dueComplete), raw: old.dueComplete }], [{ text: String(!old.dueComplete), raw: !old.dueComplete }]);
      break;
    }
    case "addMemberToCard":
    case "removeMemberFromCard": {
      const who = a.member ? person(a.member).name : (d.idMember ?? "");
      const v = text(who, d.idMember);
      if (a.type === "addMemberToCard") push({ id: "idMembers", name: "Members" }, [], v);
      else push({ id: "idMembers", name: "Members" }, v, []);
      break;
    }
    case "addLabelToCard":
    case "removeLabelFromCard": {
      const v = text(d.label?.name || d.label?.color, d.label?.id);
      if (a.type === "addLabelToCard") push({ id: "labels", name: "Labels" }, [], v);
      else push({ id: "labels", name: "Labels" }, v, []);
      break;
    }
    default:
      break;
  }
  return out;
}

const HISTORY_ACTIONS = "updateCard,addMemberToCard,removeMemberFromCard,addLabelToCard,removeLabelFromCard";

// ---------- Provider ----------

export const trelloProvider: TrackerProvider<"trello", TrelloOptions> = {
  // Deliveries are signed by Trello with the app's secret (X-Trello-Webhook); see trelloWebhook for what the secret must hold.
  webhook: {
    verify: (req, secret) => {
      // The signature covers the callback URL too: the stored secret carries it after the key's secret, on a line of its own.
      const [apiSecret, callbackUrl] = secret.split("\n");
      return !!apiSecret && !!callbackUrl && trelloWebhook.verify({ secret: apiSecret, callbackUrl, rawBody: req.body, headers: req.headers });
    },
    deliveryId: (req) => trelloWebhook.deliveryId(req.body),
    sentAt: (req) => trelloWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "trello",
  capabilities: trelloCapabilities,
  traits: trelloTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Trello options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      // https://trello.com/c/<shortLink>/<number>-<slug>: the slug follows the title, only the shortLink counts.
      const url = new URL(input.trim());
      if (url.protocol !== "https:" || (url.hostname !== "trello.com" && url.hostname !== "www.trello.com")) return null;
      const m = /^\/c\/([A-Za-z0-9]{8})(?:\/[^/]*)?\/?$/.exec(url.pathname);
      return m ? { key: m[1] } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = (await trOk<TrelloMember>(await credsOf(x), "/members/me", { query: { fields: `${MEMBER_FIELDS},email` } }));
    return { ...person(me), ...(me.username ? { login: me.username } : {}), ...(me.email ? { email: me.email } : {}) };
  },

  async probe(x) {
    const c = await credsOf(x);
    const [boards, who] = await Promise.all([myBoards(c), tr<TrelloMember>(c, "/members/me", { query: { fields: "username" } })]);
    // One source per open board: its lists are the columns.
    const activeSources: ActiveWorkflowSource[] = [...boards.values()]
      .filter((b) => !b.closed)
      .map((b) => ({ kind: "column", transitions: "move", ref: { kind: "column", boardRemoteId: b.id }, name: b.name }));
    // The documented budget of a token: N calls per window of M ms, in headers.
    const max = Number(who?.headers.get("x-rate-limit-api-token-max"));
    const interval = Number(who?.headers.get("x-rate-limit-api-token-interval-ms"));
    return {
      capabilities: trelloCapabilities,
      activeSources,
      rateLimit: max > 0 && interval > 0 ? { perSecond: Math.max(1, Math.floor(max / (interval / 1000))), origin: "detected" } : { perSecond: 10, origin: "typical" },
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // A pass is one page: Trello lists a member's cards whole (a page token can only be a stale one).
    decodePageToken<unknown>(x.conn, "issues", V, q.since, q.page);
    const at = Date.now();
    const boards = await myBoards(c);
    // A first read has no use for archived cards; a later one needs them to know which went.
    const cards = await trOk<TrelloCard[]>(c, "/members/me/cards", { query: { ...CARD_QUERY, filter: since === null ? "visible" : "all" } });
    // The list has no "changed since": cards are filtered by their last activity here.
    const changed = (since === null ? cards : cards.filter((k) => (instantFrom(k.dateLastActivity) ?? 0) >= since)).sort(
      (a, b) => a.dateLastActivity.localeCompare(b.dateLastActivity) || a.id.localeCompare(b.id),
    );
    // Cards of a closed board are not read, as on a first read: they stay as they were.
    const live = changed.filter((k) => !k.closed && boards.get(k.idBoard)?.closed !== true);
    const items = await issuesOf(x, c, live, boards);

    const gone = new Map<string, ReportedIssueGone>();
    if (since !== null) {
      for (const k of changed) if (k.closed) gone.set(k.id, { remoteId: k.id, reason: "deleted" });
      // Deleted cards, and cards the user was taken off, are only in the boards' action logs.
      const open = [...boards.values()].filter((b) => !b.closed);
      for (let n = 0; n < open.length; n += BOARD_BATCH) {
        const logs = await Promise.all(open.slice(n, n + BOARD_BATCH).map((b) => trActions(c, `/boards/${b.id}/actions`, { filter: "deleteCard,removeMemberFromCard", since: new Date(since).toISOString() })));
        for (const a of logs.flat()) {
          const id = a.data.card?.id;
          if (!id) continue;
          if (a.type === "deleteCard") gone.set(id, { remoteId: id, reason: "deleted" });
          else if (a.type === "removeMemberFromCard" && a.data.idMember === x.conn.remoteAccountId && !gone.has(id)) gone.set(id, { remoteId: id, reason: "movedOut" });
        }
      }
      // Taken off and put back, or archived and restored: the card as it is now is the answer.
      for (const i of items) gone.delete(i.remoteId);
    }
    return { last: true as const, items, gone: [...gone.values()], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    return issueBy(x, await credsOf(x), idOf(ref));
  },

  async findIssue(x, handle) {
    const i = await issueBy(x, await credsOf(x), handle.remoteId ?? handle.key ?? "");
    return i ? { kind: "found", issue: i } : { kind: "none" };
  },

  async searchText(x, input, limit) {
    const c = await credsOf(x);
    // 1,000 is the most a search returns for a model type.
    const n = Math.min(1000, Math.max(1, limit));
    // Without `partial`, only whole words match.
    const r = await trOk<{ cards: TrelloCard[] }>(c, "/search", {
      query: { query: input.trim(), modelTypes: "cards", cards_limit: n, partial: true, card_fields: CARD_FIELDS, card_members: true },
    });
    const cards = r.cards.filter((k) => !k.closed);
    const items = await issuesOf(x, c, cards.slice(0, limit), await myBoards(c));
    return { items, complete: r.cards.length < n };
  },

  async statuses(x, source) {
    const c = await credsOf(x);
    if (source.ref.kind !== "column") return [];
    const lists = await trOk<TrelloList[]>(c, `/boards/${source.ref.boardRemoteId}/lists`, { query: { filter: "open", fields: "name,closed,pos,idBoard" } });
    const s = shapeOf(x);
    return [...lists].sort((a, b) => a.pos - b.pos).map((l) => statusOf(s, l));
  },

  async description(x, ref) {
    const r = await tr<{ desc?: string }>(await credsOf(x), `/cards/${encodeURIComponent(idOf(ref))}`, { query: { fields: "desc" }, missingIsNull: true });
    // Trello keeps Markdown in the description; an empty one is "".
    return r?.data.desc ? { kind: "text", format: "commonmark", text: r.data.desc } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const card = await cardBy(c, idOf(ref));
      if (!card) throw new ProviderError("notFound", `Trello: no card ${ref.key}`);
      // Any open list of the card's board, from any list: Trello has no transition table.
      const lists = await trOk<TrelloList[]>(c, `/boards/${card.idBoard}/lists`, { query: { filter: "open", fields: "name,closed,pos,idBoard" } });
      const s = shapeOf(x);
      return [...lists]
        .sort((a, b) => a.pos - b.pos)
        .filter((l) => l.id !== card.idList)
        .map<Transition>((l) => ({ id: l.id, name: l.name, to: statusOf(s, l), requirements: [], remoteUrl: card.shortUrl }));
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      await trOk<TrelloCard>(c, `/cards/${encodeURIComponent(idOf(ref))}`, { method: "PUT", body: { idList: transitionId, pos: "bottom" } });
      // The answer is the bare card (no members): read it again whole.
      return issueBy(x, c, idOf(ref));
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      // Newest first, 50 by default: asked for in pages of 100 by `before`.
      const actions = await trActions(c, `/cards/${encodeURIComponent(idOf(ref))}/actions`, { filter: "commentCard" });
      return actions.map(toRemoteComment).reverse();
    },
    async add(x, ref, body) {
      const a = await trOk<TrelloAction>(await credsOf(x), `/cards/${encodeURIComponent(idOf(ref))}/actions/comments`, { method: "POST", body: { text: body } });
      // Without its author the comment isn't one to show: the engine reads the list again.
      return { comment: a.memberCreator ? toRemoteComment(a) : null, warnings: [] };
    },
  },

  async watch(x, ref, on) {
    await trOk<unknown>(await credsOf(x), `/cards/${encodeURIComponent(idOf(ref))}/subscribed`, { method: "PUT", body: { value: on } });
  },

  async statusHistory(x, ref) {

    return statusSteps(await trelloProvider.history!(x, ref), (c) => c.field.id === "idList");

  },


  async history(x, ref) {
    const actions = await trActions(await credsOf(x), `/cards/${encodeURIComponent(idOf(ref))}/actions`, { filter: HISTORY_ACTIONS });
    return actions.flatMap(toChanges).sort((a, b) => a.at - b.at);
  },
};

// ---------- Webhooks ----------

/**
 * Trello's webhooks: `X-Trello-Webhook` is the base64 HMAC-SHA1 of the raw
 * body followed by the callback URL the webhook was registered with, under
 * the secret of the API key's app (not a secret chosen per webhook). The raw
 * body, never a re-serialized one. A delivery has no id of its own: its
 * action's id is what a retry repeats.
 */
export const trelloWebhook = {
  sign(secret: string, callbackUrl: string, rawBody: string): string {
    return createHmac("sha1", secret).update(rawBody + callbackUrl, "utf8").digest("base64");
  },
  verify(a: { secret: string; callbackUrl: string; rawBody: string; headers: Record<string, string> | Headers }): boolean {
    const given = a.headers instanceof Headers ? a.headers.get("x-trello-webhook") : Object.entries(a.headers).find(([k]) => k.toLowerCase() === "x-trello-webhook")?.[1];
    return !!given && sameSecret(given, trelloWebhook.sign(a.secret, a.callbackUrl, a.rawBody));
  },
  action(rawBody: string): { id?: unknown; type?: unknown; date?: unknown } | null {
    try {
      const a = (JSON.parse(rawBody) as { action?: unknown }).action;
      return a && typeof a === "object" ? a : null;
    } catch {
      return null;
    }
  },
  deliveryId(rawBody: string): string | null {
    const id = trelloWebhook.action(rawBody)?.id;
    return typeof id === "string" && id !== "" ? id : null;
  },
  sentAt(rawBody: string): Instant | null {
    const d = trelloWebhook.action(rawBody)?.date;
    return typeof d === "string" ? instantFrom(d) : null;
  },
  /** Which of the declared events it is; null for actions inkledger doesn't read. */
  event(rawBody: string): "issueChanged" | "issueRemoved" | "commentAdded" | null {
    const type = trelloWebhook.action(rawBody)?.type;
    if (type === "commentCard") return "commentAdded";
    if (type === "deleteCard") return "issueRemoved";
    return typeof type === "string" && /^(createCard|updateCard|addMemberToCard|removeMemberFromCard|addLabelToCard|removeLabelFromCard|moveCardToBoard|moveCardFromBoard|copyCard)$/.test(type) ? "issueChanged" : null;
  },
};
