// ClickUp as a tracker, through the provider contract. Tasks assigned to the
// user, keyed by the workspace's custom task id when it has them (ENG-123),
// else CU-<id> (ClickUp's own short form of the task id, alphanumeric). A
// task's status belongs to its list and has a type (open, custom, done,
// closed), which gives its category. Time is ClickUp's time entries: a start
// and a duration in milliseconds, per workspace, read in a 30 day window.
// Built on a simulator, not verified on a real account: SPIKES.md.
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { DAY_MS } from "@contracts/time";
import { instant, jsonPayload, localDateOf, type Instant, type LocalDate, type TimeZone } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { sameSecret } from "../core/webhooks";
import type {
  ActiveWorkflowSource,
  CallContext,
  ConversionWarning,
  IssueHandle,
  IssueRef,
  Limited,
  RemoteComment,
  RemoteIssue,
  RemotePerson,
  RemoteStatus,
  RemoteWorklog,
  TrackerProvider,
  Transition,
  WorklogInput,
} from "../types";
import {
  clickup,
  clickupOk,
  webBaseOf,
  withQuery,
  type ClickUpBlock,
  type ClickUpComment,
  type ClickUpCreds,
  type ClickUpEntry,
  type ClickUpList,
  type ClickUpSpace,
  type ClickUpStatus,
  type ClickUpTask,
  type ClickUpTeam,
  type ClickUpUser,
} from "./client";

// The catalogue's entry for clickup, here where the adapter keeps to it (the
// registry holds the two together).
export const clickupCapabilities: TrackerCapabilities = {
  // A task's status belongs to its list; set by name, any status of the list.
  workflow: { sources: [{ kind: "itemState", transitions: "direct" }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  // Comments are read as blocks (rich); written as plain text.
  comments: { mode: "readWrite", formats: ["rich"], writePreserves: ["paragraph"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: true,
  history: false,
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "session",
      write: { mode: "entry", update: "native", delete: true },
      // The list of entries is by start; each says when it last changed (`at`): the window is read whole.
      feed: { kind: "window", by: "updatedAt", lookbackMs: 30 * 86_400_000, overlapMs: 3_600_000 },
      reconcile: { kind: "period" },
      billable: { read: true, write: true },
      activities: { read: false, write: false, required: "no" },
      onBehalf: { read: false, write: false },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "none",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    // Signals: an event says what changed, the connection is read again.
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
      { event: "worklogChanged", payload: "signal" },
      { event: "worklogRemoved", payload: "signal" },
    ],
  },
};

export const clickupTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: [],
  fields: ["priority", "due", "start", "estimate", "points", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({
  /** Only this workspace (ClickUp calls it a team, by id); none: every workspace the token sees. */
  workspace: z
    .string()
    .regex(/^\d{1,20}$/, "a workspace id is digits")
    .nullable()
    .default(null),
});
export type ClickUpOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"clickup", ClickUpOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
type IssuePage = { ws: string[]; step: number; page: number; at: number };
type EntryPage = { ws: string[]; i: number; at: number };

/** Overlap read again at each pass: updates may land after the clock that stamps them. */
const OVERLAP_MS = 60_000;
/** The window feed's lookback (the capabilities' lookbackMs): entries started before it are not read. */
const LOOKBACK_MS = 30 * DAY_MS;
/** The team task list gives 100 a page. */
const TASKS_PER_PAGE = 100;
/** A first read takes the closed tasks changed in this window, with everything still open. */
const CLOSED_WINDOW_DAYS = 30;
/** Comments come 25 a call. */
const COMMENTS_PER_CALL = 25;
const MAX_COMMENT_CALLS = 40;
/** Searching has no server side: this many pages of the user's newest tasks are read. */
const SEARCH_PAGES = 5;

async function credsOf(x: X): Promise<ClickUpCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

const enc = encodeURIComponent;

// ---------- Keys and links ----------

/** CU-<id>: ClickUp's short form of a task id (lowercase letters and digits). */
const CU_KEY = /^CU-([a-z0-9]{6,12})$/i;
/** A custom task id: the workspace's prefix, a dash, a number. */
const CUSTOM_KEY = /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/i;

const keyOfTask = (t: { id: string; custom_id?: string | null }) => (t.custom_id ? t.custom_id.toUpperCase() : `CU-${t.id}`);
function normalizeKey(raw: string): string | null {
  const k = raw.trim();
  const cu = CU_KEY.exec(k);
  if (cu) return `CU-${cu[1].toLowerCase()}`;
  return CUSTOM_KEY.test(k) ? k.toUpperCase() : null;
}
const idOfKey = (key: string | undefined) => (key ? (CU_KEY.exec(key.trim())?.[1].toLowerCase() ?? null) : null);

// ---------- Shaping ----------

const msOf = (text: string | number | null | undefined): Instant | null => {
  if (text === null || text === undefined || text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? instant(Math.trunc(n)) : null;
};

function person(u: ClickUpUser): RemotePerson {
  const id = String(u.id);
  return { remoteId: id, name: u.username || u.email || id, avatarUrl: u.profilePicture ?? null };
}

const CATEGORY: Record<string, StatusCategory> = { open: "todo", custom: "doing", done: "done", closed: "done" };

/** A list's status: its name is its id (set by name), its type says its category. */
export function statusOf(s: ClickUpStatus, listId: string | undefined): RemoteStatus {
  const order = Number(s.orderindex);
  return {
    id: s.status.toLowerCase(),
    name: s.status,
    category: CATEGORY[s.type] ?? "doing",
    categoryOrigin: { by: "native" },
    source: listId ? { kind: "itemState", containerRemoteId: listId } : { kind: "itemState" },
    nativeReason: s.type,
    ...(s.color ? { color: s.color } : {}),
    ...(Number.isFinite(order) ? { order } : {}),
  };
}

/** A due date is an instant: the day it falls on in the user's zone, with a time of day or without. */
const dueOf = (t: ClickUpTask, zone: TimeZone): LocalDate | null => {
  const at = msOf(t.due_date);
  return at === null ? null : localDateOf(at, zone);
};

const itemType = (n: number | null | undefined) => (n === 1 ? { id: "milestone", name: "Milestone" } : n ? { id: String(n), name: `Custom type ${String(n)}` } : { id: "task", name: "Task" });

export function toRemoteIssue(zone: TimeZone, t: ClickUpTask): RemoteIssue {
  const list = t.list;
  const listId = list?.id;
  const priority = t.priority;
  const rank = priority?.orderindex ? Number(priority.orderindex) - 1 : null;
  return {
    remoteId: t.id,
    key: keyOfTask(t),
    url: t.url,
    title: t.name,
    type: { ...itemType(t.custom_item_id), level: t.parent ? "sub" : "standard" },
    status: statusOf(t.status, listId),
    container: {
      remoteId: listId ?? "0",
      key: list?.name ?? listId ?? "0",
      name: list?.name ?? listId ?? "0",
      kind: "list",
      group: t.folder && !t.folder.hidden ? (t.folder.name ?? null) : null,
    },
    priority: priority ? { id: priority.id ?? priority.priority, name: priority.priority, rank: rank !== null && Number.isFinite(rank) ? rank : null } : null,
    labels: (t.tags ?? []).map((g) => g.name),
    assignees: (t.assignees ?? []).map(person),
    reporter: t.creator ? person(t.creator) : null,
    due: dueOf(t, zone),
    estimateSeconds: t.time_estimate ? Math.round(t.time_estimate / 1000) : null,
    spentSeconds: t.time_spent ? Math.round(t.time_spent / 1000) : null,
    createdAt: msOf(t.date_created),
    updatedAt: msOf(t.date_updated),
    statusChangedAt: msOf(t.date_closed ?? t.date_done),
    parent: t.parent ? { remoteId: t.parent, key: `CU-${t.parent}` } : null,
  };
}

const isClosedType = (t: ClickUpTask) => t.status.type === "closed" || t.status.type === "done";

// ---------- Workspaces and finding a task ----------

/** The workspaces to read: the option's, else every one of the token. */
async function workspacesOf(c: ClickUpCreds, x: X): Promise<string[]> {
  const { teams } = await clickupOk<{ teams: ClickUpTeam[] }>(c, "/team");
  const all = teams.map((t) => String(t.id));
  const only = x.conn.options.workspace;
  if (only === null) return all;
  if (!all.includes(only)) throw new ProviderError("invalid", `ClickUp: the token has no workspace ${only}`);
  return [only];
}

/** One task as it is now. By its id, or by its custom id inside a workspace; null when it isn't there or out of reach. */
async function fetchTask(c: ClickUpCreds, id: string, inTeam?: string): Promise<ClickUpTask | null> {
  const path = withQuery(`/task/${enc(id)}`, { include_markdown_description: true, ...(inTeam ? { custom_task_ids: true, team_id: inTeam } : {}) });
  try {
    return (await clickup<ClickUpTask>(c, path, { missingIsNull: true }))?.data ?? null;
  } catch (e) {
    // Out of reach (a 401 about the team) is not a failure of the token; a workspace without custom ids refuses the custom form.
    if (e instanceof ProviderError && (e.kind === "forbidden" || (inTeam && e.kind === "invalid"))) return null;
    throw e;
  }
}

/** Every task a handle can mean: one by id, but a custom id can be in several workspaces. */
async function locateAll(c: ClickUpCreds, x: X, h: { remoteId?: string; key?: string }): Promise<ClickUpTask[]> {
  const id = h.remoteId ?? idOfKey(h.key);
  if (id) {
    const t = await fetchTask(c, id);
    return t ? [t] : [];
  }
  const custom = h.key ? normalizeKey(h.key) : null;
  if (!custom) return [];
  const found: ClickUpTask[] = [];
  for (const ws of await workspacesOf(c, x)) {
    const t = await fetchTask(c, custom, ws);
    if (t) found.push(t);
  }
  return found;
}

async function mustLocate(c: ClickUpCreds, x: X, ref: IssueRef): Promise<ClickUpTask> {
  const [t] = await locateAll(c, x, ref);
  if (!t) throw new ProviderError("notFound", `ClickUp: no task ${ref.key}`);
  return t;
}

const teamOf = (t: ClickUpTask) => {
  if (!t.team_id) throw new ProviderError("incompatible", `ClickUp: task ${t.id} has no team_id`);
  return String(t.team_id);
};

// ---------- Search ----------

/** The user's tasks, newest change first, a page at a time. */
async function recentPage(c: ClickUpCreds, ws: string, me: string, page: number) {
  const path = withQuery(`/team/${enc(ws)}/task`, { assignees: [me], include_closed: true, subtasks: true, order_by: "updated", reverse: true, page, include_markdown_description: true });
  const r = await clickupOk<{ tasks: ClickUpTask[]; last_page?: boolean }>(c, path);
  return { tasks: r.tasks, last: r.last_page ?? r.tasks.length < TASKS_PER_PAGE };
}

/** ClickUp's public API has no text search: the user's newest tasks are read and matched here, so it says when it stopped short. */
async function search(x: X, text: string, limit: number): Promise<Limited<RemoteIssue>> {
  const c = await credsOf(x);
  const needle = text.trim().toLowerCase();
  const found: ClickUpTask[] = [];
  let cut = false;
  for (const ws of await workspacesOf(c, x)) {
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const r = await recentPage(c, ws, x.conn.remoteAccountId, page);
      found.push(...r.tasks.filter((t) => `${t.name}\n${t.markdown_description ?? t.description ?? ""}\n${keyOfTask(t)}`.toLowerCase().includes(needle)));
      if (r.last) break;
      if (page === SEARCH_PAGES - 1) cut = true;
    }
  }
  found.sort((a, b) => Number(b.date_updated ?? 0) - Number(a.date_updated ?? 0) || b.id.localeCompare(a.id));
  return { items: found.slice(0, limit).map((t) => toRemoteIssue(x.conn.timeZone, t)), complete: found.length <= limit && !cut };
}

// ---------- Time ----------

/** An entry's task as a handle; ClickUp writes "0" (or nothing) for time on no task. */
function handleOf(task: ClickUpEntry["task"]): IssueHandle | null {
  if (!task || typeof task === "string") return null;
  return task.id && task.id !== "0" ? { remoteId: task.id, key: keyOfTask(task) } : null;
}

/** An entry as read; null for a running timer (a negative duration: not a span yet). */
export function toRemoteWorklog(e: ClickUpEntry, me: string): RemoteWorklog | null {
  const duration = Number(e.duration);
  const start = msOf(e.start);
  if (!Number.isFinite(duration) || duration <= 0 || start === null) return null;
  const mine = e.user !== undefined && e.user !== null && String(e.user.id) === me;
  return {
    remoteId: e.id,
    issue: handleOf(e.task),
    span: { kind: "session", start, seconds: Math.max(1, Math.round(duration / 1000)) },
    comment: e.description ?? "",
    authorRemoteId: e.user ? String(e.user.id) : "",
    createdAt: null,
    updatedAt: msOf(e.at),
    billable: typeof e.billable === "boolean" ? e.billable : null,
    editable: { update: mine, delete: mine },
  };
}

/** The update and the delete answer a list; the others a record. */
const oneEntry = (d: ClickUpEntry | ClickUpEntry[]): ClickUpEntry => {
  const e = Array.isArray(d) ? d[0] : d;
  if (!e) throw new ProviderError("incompatible", "ClickUp: a time entry answer with no entry");
  return e;
};

function entryBody(w: WorklogInput) {
  if (w.time.kind !== "session") throw new ProviderError("invalid", `ClickUp keeps time as a start and a duration, not a ${w.time.kind}`);
  return {
    start: w.time.start,
    duration: w.time.seconds * 1000,
    description: w.comment,
    ...(w.billable === undefined ? {} : { billable: w.billable }),
  };
}

const entriesPath = (ws: string) => `/team/${enc(ws)}/time_entries`;

// ---------- Comments ----------

/** One block of a comment as Markdown (bold, italic, strike, code, link); a mention is @name. */
function inlineOf(b: ClickUpBlock): string {
  if (b.type === "tag") return `@${b.user?.username ?? String(b.user?.id ?? "someone")}`;
  if (b.type === "image") return b.image?.url ? `![](${b.image.url})` : "";
  const text = b.text ?? "";
  const a = b.attributes ?? {};
  if (!text.trim()) return text;
  let out = text;
  if (a.code === true) out = `\`${out}\``;
  if (a.bold === true) out = `**${out}**`;
  if (a.italic === true) out = `*${out}*`;
  if (a.strike === true) out = `~~${out}~~`;
  if (typeof a.link === "string" && a.link) out = `[${out}](${a.link})`;
  return out;
}

/**
 * A comment's blocks as Markdown, for the preview: ClickUp's blocks are a
 * Quill-like list where the "\n" block carries what kind of line it ends
 * (a list item, a quote, a code line).
 */
export function previewOf(blocks: ClickUpBlock[]): string {
  const lines: string[] = [];
  let line = "";
  let ordered = 0;
  const finish = (a: Record<string, unknown>) => {
    const list = (a.list as { list?: string } | undefined)?.list;
    if (list === "bullet") lines.push(`- ${line}`);
    else if (list === "ordered") lines.push(`${String(++ordered)}. ${line}`);
    else if (a["block-quote"] !== undefined) lines.push(`> ${line}`);
    else if (a["code-block"] !== undefined) lines.push(`    ${line}`);
    else lines.push(line);
    if (list !== "ordered") ordered = 0;
    line = "";
  };
  for (const b of blocks) {
    if (b.text === undefined || b.type !== undefined) {
      line += inlineOf(b);
      continue;
    }
    if (b.text === "\n") {
      finish(b.attributes ?? {});
      continue;
    }
    // A text with newlines inside: every part but the last ends a plain line.
    const parts = b.text.split("\n");
    parts.forEach((part, n) => {
      line += inlineOf({ ...b, text: part });
      if (n < parts.length - 1) finish({});
    });
  }
  if (line) lines.push(line);
  return lines.join("\n").replace(/^\n+/, "").trimEnd();
}

function toRemoteComment(c: ClickUpComment): RemoteComment {
  const payload = c.comment?.length ? jsonPayload(c.comment) : null;
  return {
    id: c.id,
    author: c.user ? person(c.user) : { remoteId: "", name: "" },
    body: payload !== null ? { kind: "structured", format: "rich", payload, preview: previewOf(c.comment ?? []) } : { kind: "text", format: "plain", text: c.comment_text ?? "" },
    createdAt: msOf(c.date),
    updatedAt: null,
  };
}

/**
 * Markdown as the plain text ClickUp's comment_text takes: the marks are
 * dropped (links keep their address in brackets, lists and quotes their
 * marker), and each feature the page loses is said.
 */
export function toClickUpText(md: string): { text: string; warnings: ConversionWarning[] } {
  const warnings = new Map<string, ConversionWarning>();
  const approximate = (feature: NonNullable<ConversionWarning["feature"]>) => warnings.set(feature, { code: "approximated", feature, serverDetail: `markdown ${feature} sent to ClickUp as plain text` });
  let fenced = false;
  const out: string[] = [];
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      approximate("codeBlock");
      continue;
    }
    if (fenced) {
      out.push(raw);
      continue;
    }
    let line = raw;
    if (/^#{1,6}\s/.test(line)) {
      approximate("heading");
      line = line.replace(/^#{1,6}\s+/, "");
    }
    if (/^>\s?/.test(line)) approximate("quote");
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) approximate("list");
    if (/^\|.*\|\s*$/.test(line)) approximate("table");
    line = line
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
        approximate("image");
        return alt ? `${alt} (${url})` : url;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
        approximate("link");
        return `${label} (${url})`;
      })
      .replace(/(\*\*|__)(.+?)\1/g, (_m, _d: string, inner: string) => {
        approximate("strong");
        return inner;
      })
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)|(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => {
        approximate("emphasis");
        return `${p1 ?? p2 ?? ""}${a ?? b ?? ""}`;
      })
      .replace(/`([^`\n]+)`/g, (_m, code: string) => {
        approximate("code");
        return code;
      });
    out.push(line);
  }
  return { text: out.join("\n").trim(), warnings: [...warnings.values()] };
}

// ---------- Webhooks ----------

type Headers2 = Record<string, string>;

/**
 * ClickUp's webhooks. Creating one returns its secret; every delivery is signed
 * with it (X-Signature, the hex HMAC-SHA256 of the raw body). A delivery has no
 * id of its own, its history items do; each item has a date.
 */
export const clickupWebhook = {
  verify(headers: Headers2, rawBody: string, secret: string): boolean {
    const given = headers["x-signature"];
    if (!secret || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
    return sameSecret(given.toLowerCase(), createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  },
  /** The webhook and its first history item: the same delivery sent again has the same id (null when it has no item). */
  deliveryId(rawBody: string): string | null {
    const body = parseBody(rawBody);
    const first = body?.history_items?.[0]?.id;
    return body && typeof body.webhook_id === "string" && typeof first === "string" ? `${body.webhook_id}:${first}` : null;
  },
  /** When the latest history item happened (null when none says). */
  sentAt(rawBody: string): Instant | null {
    const times = (parseBody(rawBody)?.history_items ?? []).flatMap((i) => msOf(i.date) ?? []);
    return times.length ? instant(Math.max(...times)) : null;
  },
  /** Which of the declared events a delivery is. */
  events(rawBody: string): ("issueChanged" | "issueRemoved" | "commentAdded" | "worklogChanged" | "worklogRemoved")[] {
    const event = parseBody(rawBody)?.event;
    if (typeof event !== "string") return [];
    if (event === "taskDeleted") return ["issueRemoved"];
    if (event === "taskCommentPosted") return ["commentAdded"];
    // An update or a removal of time are the same event.
    if (event === "taskTimeTrackedUpdated") return ["worklogChanged", "worklogRemoved"];
    return /^task(Created|Updated|Status|Priority|Assignee|DueDate|Tag|Moved|Parent|TimeEstimate|CommentUpdated)/.test(event) ? ["issueChanged"] : [];
  },
};

type HookBody = { webhook_id?: unknown; event?: unknown; history_items?: { id?: unknown; date?: string | number | null }[] };
function parseBody(raw: string): HookBody | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v) : null;
  } catch {
    return null;
  }
}

// ---------- The adapter ----------

export const clickupProvider: TrackerProvider<"clickup", ClickUpOptions> = {
  webhook: {
    verify: (req, secret) => clickupWebhook.verify(req.headers, req.body, secret),
    deliveryId: (req) => clickupWebhook.deliveryId(req.body),
    sentAt: (req) => clickupWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "clickup",
  capabilities: clickupCapabilities,
  traits: clickupTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `ClickUp options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      const url = new URL(input.trim());
      if (url.origin !== new URL(webBaseOf(r.baseUrl)).origin) return null;
      // /t/<id> or /t/<workspace>/<custom id or id>
      const m = /^\/t\/(?:\d+\/)?([A-Za-z0-9-]+)\/?$/.exec(url.pathname);
      if (!m) return null;
      const custom = CUSTOM_KEY.test(m[1]) && !CU_KEY.test(m[1]) ? m[1].toUpperCase() : null;
      return custom ? { key: custom } : /^[a-z0-9]{6,12}$/i.test(m[1]) ? { key: `CU-${m[1].toLowerCase()}`, remoteId: m[1].toLowerCase() } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const { user } = await clickupOk<{ user: ClickUpUser }>(await credsOf(x), "/user");
    return { ...person(user), ...(user.email ? { email: user.email } : {}), ...(user.username ? { login: user.username } : {}) };
  },

  async probe(x) {
    const r = await clickup<{ user: ClickUpUser }>(await credsOf(x), "/user");
    const limit = Number(r?.headers.get("x-ratelimit-limit"));
    // 100 calls a minute on most plans, more on the larger ones: the header says.
    const perHour = (Number.isInteger(limit) && limit > 0 ? limit : 100) * 60;
    const sources: ActiveWorkflowSource[] = [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "List status" }];
    return { capabilities: clickupCapabilities, activeSources: sources, rateLimit: { perHour, origin: Number.isInteger(limit) && limit > 0 ? "detected" : "typical" }, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const pass = decodePageToken<IssuePage>(x.conn, "issues", V, q.since, q.page) ?? { ws: await workspacesOf(c, x), step: 0, page: 0, at: Date.now() };
    // A first read is two steps a workspace (what is open, then what closed lately); a later one is one (everything changed since).
    const phases = since === null ? (["open", "closed"] as const) : (["since"] as const);
    const ws = pass.ws[Math.floor(pass.step / phases.length)];
    const phase = phases[pass.step % phases.length];
    let items: RemoteIssue[] = [];
    let last = true;
    if (ws !== undefined) {
      const path = withQuery(`/team/${enc(ws)}/task`, {
        assignees: [x.conn.remoteAccountId],
        subtasks: true,
        // Created never changes: a page number stays good while tasks are edited.
        order_by: "created",
        page: pass.page,
        include_markdown_description: false,
        ...(phase === "open" ? {} : { include_closed: true }),
        ...(phase === "closed" ? { date_updated_gt: String(pass.at - CLOSED_WINDOW_DAYS * DAY_MS) } : {}),
        ...(phase === "since" ? { date_updated_gt: String(since ?? 0) } : {}),
      });
      const r = await clickupOk<{ tasks: ClickUpTask[]; last_page?: boolean }>(c, path);
      // The closed step also returns open tasks changed lately: those came with the first step.
      const tasks = phase === "closed" ? r.tasks.filter(isClosedType) : r.tasks;
      items = tasks.map((t) => toRemoteIssue(x.conn.timeZone, t));
      last = r.last_page ?? r.tasks.length < TASKS_PER_PAGE;
    }
    const more: IssuePage | null = !last ? { ...pass, page: pass.page + 1 } : pass.step + 1 < pass.ws.length * phases.length ? { ...pass, step: pass.step + 1, page: 0 } : null;
    if (more) return { last: false, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, more) };
    return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: pass.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const [t] = await locateAll(await credsOf(x), x, ref);
    return t ? toRemoteIssue(x.conn.timeZone, t) : null;
  },

  async findIssue(x, handle) {
    const found = (await locateAll(await credsOf(x), x, handle)).map((t) => toRemoteIssue(x.conn.timeZone, t));
    const [first, second, ...rest] = found;
    if (!first) return { kind: "none" };
    // A custom id is only unique inside a workspace: never a silent pick.
    return second ? { kind: "ambiguous", candidates: [first, second, ...rest] } : { kind: "found", issue: first };
  },

  searchText: search,

  async statuses(x, source) {
    if (source.kind !== "itemState") return [];
    const c = await credsOf(x);
    const listId = source.ref.containerRemoteId;
    if (listId) {
      const l = await clickupOk<ClickUpList>(c, `/list/${enc(listId)}`);
      return (l.statuses ?? []).map((s) => statusOf(s, listId));
    }
    // No list: the statuses of the spaces (what a list inherits unless it has its own), once each.
    const seen = new Map<string, RemoteStatus>();
    for (const ws of await workspacesOf(c, x)) {
      const { spaces } = await clickupOk<{ spaces: ClickUpSpace[] }>(c, `/team/${enc(ws)}/space`);
      for (const space of spaces) for (const s of space.statuses ?? []) if (!seen.has(s.status.toLowerCase())) seen.set(s.status.toLowerCase(), statusOf(s, undefined));
    }
    return [...seen.values()];
  },

  async description(x, ref) {
    const [t] = await locateAll(await credsOf(x), x, ref);
    const md = t?.markdown_description?.trim();
    if (md) return { kind: "text", format: "gfm", text: t?.markdown_description ?? md };
    return t?.description?.trim() ? { kind: "text", format: "plain", text: t.description } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      const listId = t.list?.id;
      if (!listId) return [];
      // Statuses are the list's: another list of the same space may have others.
      const l = await clickupOk<ClickUpList>(c, `/list/${enc(listId)}`);
      return (l.statuses ?? [])
        .filter((s) => s.status.toLowerCase() !== t.status.status.toLowerCase())
        .map((s): Transition => ({ id: s.status.toLowerCase(), name: s.status, to: statusOf(s, listId), requirements: [], remoteUrl: t.url }));
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      const listId = t.list?.id;
      const l = listId ? await clickupOk<ClickUpList>(c, `/list/${enc(listId)}`) : null;
      const target = l?.statuses?.find((s) => s.status.toLowerCase() === transitionId);
      if (!target) throw new ProviderError("invalid", `ClickUp: no status ${transitionId} in this task's list`);
      // Set by name, exactly as the list writes it.
      const done = await clickupOk<ClickUpTask>(c, withQuery(`/task/${enc(t.id)}`, { include_markdown_description: false }), { method: "PUT", data: { status: target.status } });
      return toRemoteIssue(x.conn.timeZone, done);
    },
  },

  worklogs: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      // task_id with no dates would give only the last 30 days: ask for all of them.
      const path = withQuery(entriesPath(teamOf(t)), { task_id: t.id, start_date: 946_684_800_000, end_date: Date.now() + DAY_MS });
      const { data } = await clickupOk<{ data: ClickUpEntry[] }>(c, path);
      return data.flatMap((e) => toRemoteWorklog(e, x.conn.remoteAccountId) ?? []);
    },
    async get(x, ref, id) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      const r = await clickup<{ data: ClickUpEntry | ClickUpEntry[] }>(c, `${entriesPath(teamOf(t))}/${enc(id)}`, { missingIsNull: true });
      return r ? toRemoteWorklog(oneEntry(r.data.data), x.conn.remoteAccountId) : null;
    },
    /** Entries started in the window, changed since the checkpoint: the list is by start, so the window is read whole and `at` picks. */
    async changed(x, q) {
      const c = await credsOf(x);
      const since = decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since)?.at ?? null;
      const pass = decodePageToken<EntryPage>(x.conn, "worklogs", V, q.since, q.page) ?? { ws: await workspacesOf(c, x), i: 0, at: Date.now() };
      const ws = pass.ws[pass.i];
      let items: RemoteWorklog[] = [];
      if (ws !== undefined) {
        try {
          const path = withQuery(entriesPath(ws), { start_date: pass.at - LOOKBACK_MS, end_date: pass.at + DAY_MS });
          const { data } = await clickupOk<{ data: ClickUpEntry[] }>(c, path);
          items = data
            .filter((e) => since === null || (msOf(e.at) ?? 0) >= since)
            .flatMap((e) => toRemoteWorklog(e, x.conn.remoteAccountId) ?? []);
        } catch (e) {
          // A workspace with the Time Tracking ClickApp off refuses: the others are still read.
          if (!(e instanceof ProviderError && e.kind === "forbidden")) throw e;
        }
      }
      if (pass.i + 1 < pass.ws.length) return { last: false, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { ...pass, i: pass.i + 1 } satisfies EntryPage) };
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: pass.at - OVERLAP_MS } satisfies Since) };
    },
    async create(x, ref, w) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      const r = await clickupOk<{ data: ClickUpEntry | ClickUpEntry[] }>(c, entriesPath(teamOf(t)), { method: "POST", data: { ...entryBody(w), tid: t.id } });
      const made = toRemoteWorklog(oneEntry(r.data), x.conn.remoteAccountId);
      if (!made) throw new ProviderError("incompatible", "ClickUp: a created time entry that is not a span");
      return made;
    },
    async update(x, ref, id, w) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      const r = await clickupOk<{ data: ClickUpEntry | ClickUpEntry[] }>(c, `${entriesPath(teamOf(t))}/${enc(id)}`, { method: "PUT", data: entryBody(w) });
      const changed = toRemoteWorklog(oneEntry(r.data), x.conn.remoteAccountId);
      if (!changed) throw new ProviderError("incompatible", "ClickUp: a changed time entry that is not a span");
      return changed;
    },
    async delete(x, ref, id) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      // Deleting what is already gone is a success.
      await clickup<unknown>(c, `${entriesPath(teamOf(t))}/${enc(id)}`, { method: "DELETE", missingIsNull: true });
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      // Newest first, 25 a call: continue after the oldest seen with its date and id (comments can share a millisecond).
      const all: ClickUpComment[] = [];
      let from: { start: string; id: string } | null = null;
      for (let n = 0; n < MAX_COMMENT_CALLS; n++) {
        const path = withQuery(`/task/${enc(t.id)}/comment`, from ? { start: from.start, start_id: from.id } : {});
        const { comments } = await clickupOk<{ comments: ClickUpComment[] }>(c, path);
        all.push(...comments);
        const oldest = comments[comments.length - 1];
        if (comments.length < COMMENTS_PER_CALL || !oldest) break;
        from = { start: oldest.date, id: oldest.id };
      }
      return all.sort((a, b) => Number(a.date) - Number(b.date) || a.id.localeCompare(b.id)).map(toRemoteComment);
    },
    async add(x, ref, body) {
      const c = await credsOf(x);
      const t = await mustLocate(c, x, ref);
      const { text, warnings } = toClickUpText(body);
      // The answer is only { id, hist_id, date }: the comment is read again.
      await clickupOk<unknown>(c, `/task/${enc(t.id)}/comment`, { method: "POST", data: { comment_text: text, notify_all: false } });
      return { comment: null, warnings };
    },
  },

  async watch(x, ref, on) {
    const c = await credsOf(x);
    const t = await mustLocate(c, x, ref);
    const me = Number(x.conn.remoteAccountId);
    // Watching twice, or unwatching twice, is what was asked.
    await clickupOk<unknown>(c, withQuery(`/task/${enc(t.id)}`, { include_markdown_description: false }), { method: "PUT", data: { watchers: on ? { add: [me], rem: [] } : { add: [], rem: [me] } } });
  },
};
