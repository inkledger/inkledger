// Asana as a tracker, through the provider contract. Tasks assigned to the
// user, keyed ASANA-<gid>: a task has no number of its own, only its gid,
// which never changes (a move between projects changes the container, not the
// key). A task's status is the section it sits in (in its first project)
// once the connection's options give that section a category, else Open /
// Completed. Time is Asana's time tracking entries: a date, whole minutes, a
// category (attributable_to) and a billable status.
// Built on a simulator, not verified on a real account: docs/dev/spikes.md.
import { secretOf } from "../core/context";
import { wholeMinutes } from "../core/time";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { DAY_MS } from "@contracts/time";
import { instant, instantFrom, localDate, localDateOf, type Instant, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { sameSecret } from "../core/webhooks";
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
  type RemoteStatusStep,
  type RemoteWorklog,
  type TrackerProvider,
  type Transition,
  type WorklogInput,
} from "../types";
import {
  asana,
  asanaOk,
  asanaPage,
  asanaPages,
  ENTRY_FIELDS,
  STORY_FIELDS,
  TASK_FIELDS,
  USER_FIELDS,
  webBaseOf,
  type AsanaCreds,
  type AsanaEntry,
  type AsanaRef,
  type AsanaStory,
  type AsanaTask,
  type AsanaUser,
} from "./client";

// The catalogue's entry for asana, here where the adapter keeps to it (the
// registry holds the two together).
export const asanaCapabilities: TrackerCapabilities = {
  // The section a task sits in, completed or not; a custom task type's status as a
  // project field (verify: asana-status) only once shown.
  workflow: { sources: [{ kind: "column", transitions: "move" }, { kind: "boolean", transitions: "direct", reasons: false }] },
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
  statusHistory: true,
  // No documented change filter on time entries (verify: asana-time-feed): no feed, reconciled by period
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "native", delete: true },
      feed: { kind: "none" },
      reconcile: { kind: "period" },
      billable: { read: true, write: true },
      activities: { read: true, write: true, required: "no" },
      onBehalf: { read: false, write: false },
      approvals: { read: true },
      idempotency: "local",
      concurrency: "none",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: true, lostAccess: false, movedOut: true, transfer: "none" },
    // Signals: an event says what changed, the connection is read again.
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
      { event: "worklogChanged", payload: "signal" },
    ],
  },
};

export const asanaTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: [],
  fields: ["due", "start", "estimate", "labels", "custom"],
};

/** A section is matched by its name, whichever project it is in (case and surrounding spaces aside). */
const sectionKey = (name: string) => name.trim().toLowerCase();

const optionsSchema = z.strictObject({
  /** Only this workspace (by gid); none: every workspace the token sees. */
  workspace: z
    .string()
    .regex(/^\d{1,25}$/, "a workspace gid is digits")
    .nullable()
    .default(null),
  /**
   * The category of each section name that is a status. Asana doesn't say what a
   * section means: never inferred from a name, so only the names listed here are
   * statuses; the rest of the tasks read Open (or Completed).
   */
  columns: z
    .record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES))
    .default({})
    .transform((r): Record<string, StatusCategory> => Object.fromEntries(Object.entries(r).map(([k, v]) => [sectionKey(k), v]))),
});
export type AsanaOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"asana", AsanaOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
type IssuePage = { ws: string[]; i: number; offset: string | null; at: number };

/** Overlap read again at each pass: updates may land after the clock that stamps them. */
const OVERLAP_MS = 60_000;
const PER_PAGE = 50;
/** A first read takes the tasks completed in this window, with everything still open. */
const COMPLETED_WINDOW_DAYS = 30;

async function credsOf(x: X): Promise<AsanaCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

/** What turning a task into the layer's shape needs of its connection. */
type Shape = { connId: number; columns: Record<string, StatusCategory>; zone: TimeZone };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, columns: x.conn.options.columns, zone: x.conn.timeZone });

// ---------- Keys and links ----------

/** ASANA-<gid>: the only thing a task is known by. */
const KEY = /^ASANA-(\d{1,25})$/;
const keyOfGid = (gid: string) => `ASANA-${gid}`;
const normalizeKey = (raw: string) => {
  const k = raw.trim().toUpperCase();
  return KEY.test(k) ? k : null;
};
const gidOfKey = (key: string) => KEY.exec(key)?.[1] ?? null;
const gidOfHandle = (h: { remoteId?: string; key?: string }) => h.remoteId ?? (h.key ? gidOfKey(h.key) : null);

// ---------- Statuses ----------

const OPEN: RemoteStatus = { id: "open", name: "Open", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };
const COMPLETED: RemoteStatus = { id: "completed", name: "Completed", category: "done", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };

// The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
function columnStatus(s: Shape, project: string, section: AsanaRef, category: StatusCategory): RemoteStatus {
  return { id: section.gid, name: section.name ?? "", category, categoryOrigin: { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) }, source: { kind: "column", boardRemoteId: project } };
}

type Membership = NonNullable<AsanaTask["memberships"]>[number];

/** A project's section, once the options give it a category. Only the first project counts (a task's memberships have no order of importance, but one has to be taken). */
function columnOf(s: Shape, memberships: Membership[]): RemoteStatus | null {
  const m = memberships.find((x) => x.project);
  const category = m?.section?.name ? s.columns[sectionKey(m.section.name)] : undefined;
  return m?.project && m.section && category ? columnStatus(s, m.project.gid, m.section, category) : null;
}

/** Completed is completed; open takes its section's status when the options say what it is, else plain Open. */
const statusOf = (s: Shape, t: Pick<AsanaTask, "completed" | "memberships">): RemoteStatus => (t.completed ? COMPLETED : (columnOf(s, t.memberships ?? []) ?? OPEN));

/**
 * The task's status through its stories, as statusOf computes it: created open,
 * in the section its first move left (none when that was empty). A story that
 * disagrees with the replay (completed twice, moved from another section) or a
 * task in several projects (a move doesn't say whose section) can't be read.
 */
export function replayStatus(s: Shape, task: Pick<AsanaTask, "memberships">, stories: readonly AsanaStory[]): RemoteStatusStep[] {
  const projects = (task.memberships ?? []).filter((m) => m.project);
  if (projects.length > 1) throw new ProviderError("incompatible", "Asana: a task in several projects (a move doesn't say whose section)");
  const project = projects[0]?.project;
  const moves = stories.filter((st) => st.resource_subtype === "section_changed");
  let section: AsanaRef | null = moves.length ? (moves[0].old_section ?? null) : (projects[0]?.section ?? null);
  let completed = false;
  const derive = () => statusOf(s, { completed, memberships: project && section ? [{ project, section }] : [] });
  const brief = (r: RemoteStatus) => ({ id: r.id, name: r.name });
  let current = derive();
  const steps: RemoteStatusStep[] = [];
  const relevant = stories.filter((st) => st.resource_subtype === "section_changed" || st.resource_subtype === "marked_complete" || st.resource_subtype === "marked_incomplete");
  relevant.forEach((st, n) => {
    const at = instantFrom(st.created_at) ?? instant(0);
    if (st.resource_subtype === "marked_complete" || st.resource_subtype === "marked_incomplete") {
      const on = st.resource_subtype === "marked_complete";
      if (completed === on) throw new ProviderError("incompatible", `Asana: ${st.resource_subtype} on a task already so`);
      completed = on;
    } else {
      if ((st.old_section?.gid ?? null) !== (section?.gid ?? null)) throw new ProviderError("incompatible", "Asana: a move from a section the task wasn't in");
      section = st.new_section ?? null;
    }
    // Stories of one instant make one step.
    if (instantFrom(relevant[n + 1]?.created_at ?? "") === at) return;
    const next = derive();
    if (next.id !== current.id) steps.push({ at, from: brief(current), to: brief(next) });
    current = next;
  });
  return steps;
}

// ---------- Shaping ----------

function person(u: AsanaUser): RemotePerson {
  return { remoteId: u.gid, name: u.name || u.email || u.gid, avatarUrl: u.photo?.image_128x128 ?? null };
}

/** due_on is a day; due_at a UTC instant, which falls on the user's day, not on UTC's. */
function dueOf(t: AsanaTask, zone: TimeZone): LocalDate | null {
  if (t.due_on) return localDate(t.due_on);
  const at = instantFrom(t.due_at ?? null);
  return at === null ? null : localDateOf(at, zone);
}

const TYPES: Record<string, string> = { default_task: "Task", milestone: "Milestone", approval: "Approval" };

/** The project a task is in (the first of its memberships), else its workspace. A subtask has none of its own: it takes its parent's. */
function containerOf(t: AsanaTask, borrowed: Membership[]): RemoteIssue["container"] {
  const m = [...(t.memberships ?? []), ...borrowed].find((x) => x.project);
  if (m?.project) return { remoteId: m.project.gid, key: m.project.name ?? m.project.gid, name: m.project.name ?? m.project.gid, kind: "project" };
  const w = t.workspace;
  return { remoteId: w?.gid ?? "0", key: w?.name ?? w?.gid ?? "0", name: w?.name ?? w?.gid ?? "0", kind: "workspace" };
}

export function toRemoteIssue(s: Shape, t: AsanaTask, borrowed: Membership[] = []): RemoteIssue {
  const subtype = t.resource_subtype ?? "default_task";
  return {
    remoteId: t.gid,
    key: keyOfGid(t.gid),
    url: t.permalink_url,
    title: t.name,
    type: { id: subtype, name: TYPES[subtype] ?? subtype, level: t.parent ? "sub" : "standard" },
    status: statusOf(s, t),
    container: containerOf(t, borrowed),
    priority: null,
    labels: (t.tags ?? []).map((g) => g.name ?? g.gid),
    assignees: t.assignee ? [person(t.assignee)] : [],
    reporter: t.created_by ? person(t.created_by) : null,
    due: dueOf(t, s.zone),
    spentSeconds: t.actual_time_minutes ? t.actual_time_minutes * 60 : null,
    createdAt: instantFrom(t.created_at),
    updatedAt: instantFrom(t.modified_at),
    statusChangedAt: instantFrom(t.completed_at ?? null),
    parent: t.parent ? { remoteId: t.parent.gid, key: keyOfGid(t.parent.gid) } : null,
  };
}

/** A subtask carries no memberships: read its parent's, once for all the subtasks of a parent. */
async function shapeAll(c: AsanaCreds, s: Shape, tasks: AsanaTask[]): Promise<RemoteIssue[]> {
  const parents = new Map<string, Promise<Membership[]>>();
  const homeOfParent = (gid: string) => {
    let p = parents.get(gid);
    if (!p) {
      p = asana<{ memberships?: Membership[] }>(c, `/tasks/${gid}?opt_fields=memberships.project.name`, { missingIsNull: true }).then(
        (r) => r?.data.memberships ?? [],
        (e: unknown) => {
          // A parent the user can't see: the subtask stays in its workspace.
          if (e instanceof ProviderError && e.kind === "forbidden") return [];
          throw e;
        },
      );
      parents.set(gid, p);
    }
    return p;
  };
  return Promise.all(tasks.map(async (t) => toRemoteIssue(s, t, t.parent && !(t.memberships ?? []).length ? await homeOfParent(t.parent.gid) : [])));
}

// ---------- Finding a task ----------

const taskPath = (gid: string) => `/tasks/${encodeURIComponent(gid)}`;

/** A task as it is now; null when it isn't there (a deleted task is a 404) or the user cannot see it (403). */
async function locate(c: AsanaCreds, gid: string | null): Promise<AsanaTask | null> {
  if (!gid || !/^\d{1,25}$/.test(gid)) return null;
  try {
    return (await asana<AsanaTask>(c, `${taskPath(gid)}?opt_fields=${TASK_FIELDS}`, { missingIsNull: true }))?.data ?? null;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "forbidden") return null;
    throw e;
  }
}

async function mustLocate(c: AsanaCreds, ref: IssueRef): Promise<AsanaTask> {
  const t = await locate(c, gidOfHandle(ref));
  if (!t) throw new ProviderError("notFound", `Asana: no task ${ref.key}`);
  return t;
}

/** The workspaces to read: the option's, else every one of the token. */
async function workspacesOf(c: AsanaCreds, x: X): Promise<string[]> {
  const me = await asanaOk<AsanaUser>(c, `/users/me?opt_fields=${USER_FIELDS}`);
  const all = (me.workspaces ?? []).map((w) => w.gid);
  const only = x.conn.options.workspace;
  if (only === null) return all;
  if (!all.includes(only)) throw new ProviderError("invalid", `Asana: the token has no workspace ${only}`);
  return [only];
}

// ---------- Search ----------

async function search(x: X, text: string, limit: number): Promise<Limited<RemoteIssue>> {
  const c = await credsOf(x);
  const s = shapeOf(x);
  const per = Math.min(100, limit + 1);
  const found = new Map<string, AsanaTask>();
  let cut = false;
  for (const ws of await workspacesOf(c, x)) {
    let tasks: AsanaTask[];
    try {
      // Search is a paid-plan endpoint, without paging: the newest `per` and nothing says there is more.
      const params = new URLSearchParams({ text, "assignee.any": "me", sort_by: "modified_at", sort_ascending: "false", limit: String(per), opt_fields: TASK_FIELDS });
      tasks = await asanaOk<AsanaTask[]>(c, `/workspaces/${ws}/tasks/search?${params.toString()}`);
      if (tasks.length >= per) cut = true;
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 402)) throw e;
      // A free plan: typeahead finds tasks of the whole workspace, other people's too.
      const params = new URLSearchParams({ resource_type: "task", query: text, count: "100", opt_fields: TASK_FIELDS });
      const raw = await asanaOk<AsanaTask[]>(c, `/workspaces/${ws}/typeahead?${params.toString()}`);
      if (raw.length >= 100) cut = true;
      tasks = raw.filter((t) => t.assignee?.gid === x.conn.remoteAccountId);
    }
    for (const t of tasks) found.set(t.gid, t);
  }
  const all = [...found.values()].sort((a, b) => b.modified_at.localeCompare(a.modified_at) || b.gid.localeCompare(a.gid));
  return { items: await shapeAll(c, s, all.slice(0, limit)), complete: all.length <= limit && !cut };
}

// ---------- Time ----------

const APPROVALS = { draft: "draft", submitted: "submitted", approved: "approved", rejected: "rejected" } as const;

function toRemoteWorklog(e: AsanaEntry, me: string): RemoteWorklog {
  const mine = e.created_by?.gid === me;
  const state = e.approval_status ?? null;
  // An entry in a submitted or approved timesheet is locked for everyone.
  const locked = state === "approved" ? ({ cause: "approved" } as const) : state === "submitted" ? ({ cause: "submitted" } as const) : null;
  return {
    remoteId: e.gid,
    issue: e.task ? { remoteId: e.task.gid, key: keyOfGid(e.task.gid) } : null,
    span: { kind: "date", date: localDate(e.entered_on), seconds: e.duration_minutes * 60 },
    comment: e.description ?? "",
    authorRemoteId: e.created_by?.gid ?? "",
    createdAt: instantFrom(e.created_at ?? null),
    updatedAt: null,
    billable: e.billable_status === "billable" ? true : e.billable_status === "nonBillable" ? false : null,
    activity: e.attributable_to ? { id: e.attributable_to.gid, name: e.attributable_to.name ?? "" } : null,
    approval: state ? APPROVALS[state] : null,
    locked,
    editable: { update: mine && !locked, delete: mine && !locked },
  };
}

/** Asana keeps whole minutes (at least one): a duration is rounded to the nearest. */
const minutesOf = wholeMinutes;

function entryBody(w: WorklogInput) {
  if (w.time.kind !== "date") throw new ProviderError("invalid", `Asana keeps time on a day, not a ${w.time.kind}`);
  return {
    duration_minutes: minutesOf(w.time.seconds),
    entered_on: w.time.date,
    description: w.comment,
    ...(w.activityId ? { attributable_to: w.activityId } : {}),
    ...(w.billable === undefined ? {} : { billable_status: w.billable ? "billable" : "nonBillable" }),
  };
}

// ---------- Comments ----------

const toRemoteComment = (s: AsanaStory): RemoteComment => ({
  id: s.gid,
  author: s.created_by ? person(s.created_by) : { remoteId: "", name: "" },
  body: { kind: "text", format: "html", text: s.html_text ?? `<body>${escapeHtml(s.text ?? "")}</body>` },
  createdAt: instantFrom(s.created_at),
  updatedAt: null,
});

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline Markdown as the few tags Asana takes in a comment (strong, em, s, code, a); code spans are left alone. */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, n) => {
      if (n % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label || url}</a>`)
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<strong>${a ?? b}</strong>`)
        .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_\n]*)_(?!\w)/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`);
    })
    .join("");
}

/**
 * Markdown as an Asana html_text: a <body> of text with line breaks as newlines
 * (no <p>, no headings: Asana refuses them) and lists as <ul>/<ol>. What it
 * can't keep (headings, quotes, code blocks, tables, images) is written as
 * plain text and said so.
 */
export function toAsanaHtml(md: string): { html: string; warnings: ConversionWarning[] } {
  const warnings = new Map<string, ConversionWarning>();
  const approximate = (feature: NonNullable<ConversionWarning["feature"]>) => warnings.set(feature, { code: "approximated", feature, serverDetail: `markdown ${feature} sent to Asana as plain text` });
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
      out.push(escapeHtml(line));
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(inline(item[2]));
      continue;
    }
    flush();
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
    out.push(inline(text));
  }
  flush();
  return { html: `<body>${out.join("\n").replace(/(<\/[uo]l>)\n/g, "$1").replace(/\n(<[uo]l>)/g, "$1")}</body>`, warnings: [...warnings.values()] };
}

// ---------- History ----------

const text = (v: string | null | undefined) => (v ? [{ text: v }] : []);

function toChange(s: AsanaStory): RemoteChange | null {
  if (s.type !== "system") return null;
  const base = { at: instantFrom(s.created_at) ?? instant(0), actor: s.created_by ? person(s.created_by) : null };
  switch (s.resource_subtype) {
    case "marked_complete":
      return { ...base, field: { id: "completed", name: "Completed" }, from: [{ text: "No" }], to: [{ text: "Yes" }] };
    case "marked_incomplete":
      return { ...base, field: { id: "completed", name: "Completed" }, from: [{ text: "Yes" }], to: [{ text: "No" }] };
    case "section_changed":
      return { ...base, field: { id: "section", name: "Section" }, from: text(s.old_section?.name), to: text(s.new_section?.name) };
    case "name_changed":
      return { ...base, field: { id: "name", name: "Name" }, from: text(s.old_name), to: text(s.new_name) };
    case "due_date_changed":
      return { ...base, field: { id: "due_on", name: "Due date" }, from: text(s.old_dates?.due_on), to: text(s.new_dates?.due_on) };
    case "assigned":
    case "unassigned":
      return { ...base, field: { id: "assignee", name: "Assignee" }, from: [], to: s.assignee ? [{ text: s.assignee.name ?? s.assignee.gid, id: s.assignee.gid }] : [] };
    default:
      return { ...base, field: { name: s.resource_subtype ?? "change" }, from: [], to: text(s.text) };
  }
}

// ---------- Webhooks ----------

type Headers2 = Record<string, string>;

/**
 * Asana's webhooks. Creating one is a handshake: Asana POSTs to the target with
 * X-Hook-Secret, and the receiver answers 200 with the same header echoed; that
 * secret then signs every delivery (X-Hook-Signature, the hex HMAC-SHA256 of
 * the raw body). Deliveries carry no id of their own, and every few hours an
 * empty heartbeat ({ events: [] }).
 */
export const asanaWebhook = {
  verify(headers: Headers2, rawBody: string, secret: string): boolean {
    const given = headers["x-hook-signature"];
    if (!secret || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
    return sameSecret(given.toLowerCase(), createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  },
  /** The secret to echo back when Asana opens a webhook (null: not a handshake). */
  handshake(headers: Headers2): string | null {
    return headers["x-hook-secret"] || null;
  },
  /** When the latest event happened, from the body (null for a heartbeat). */
  sentAt(rawBody: string): Instant | null {
    try {
      const events = (JSON.parse(rawBody) as { events?: { created_at?: unknown }[] }).events ?? [];
      const times = events.flatMap((e) => (typeof e.created_at === "string" ? [instantFrom(e.created_at)] : [])).filter((t): t is Instant => t !== null);
      return times.length ? instant(Math.max(...times)) : null;
    } catch {
      return null;
    }
  },
  /** Which of the declared events a delivery holds; nothing for projects, sections and the like. */
  events(rawBody: string): ("issueChanged" | "issueRemoved" | "commentAdded" | "worklogChanged")[] {
    let events: { action?: unknown; resource?: { resource_type?: unknown; resource_subtype?: unknown } }[] = [];
    try {
      events = (JSON.parse(rawBody) as { events?: typeof events }).events ?? [];
    } catch {
      return [];
    }
    const found = new Set<"issueChanged" | "issueRemoved" | "commentAdded" | "worklogChanged">();
    for (const e of events) {
      const type = e.resource?.resource_type;
      if (type === "task") found.add(e.action === "deleted" ? "issueRemoved" : "issueChanged");
      else if (type === "story") found.add(e.action === "added" && e.resource?.resource_subtype === "comment_added" ? "commentAdded" : "issueChanged");
      else if (type === "time_tracking_entry") found.add("worklogChanged");
    }
    return [...found];
  },
};

// ---------- The adapter ----------

export const asanaProvider: TrackerProvider<"asana", AsanaOptions> = {
  // Deliveries signed with the handshake secret; no id to refuse a replay by, a time (the latest event) to refuse a stale one by.
  webhook: {
    verify: (req, secret) => asanaWebhook.verify(req.headers, req.body, secret),
    deliveryId: () => null,
    sentAt: (req) => asanaWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "asana",
  capabilities: asanaCapabilities,
  traits: asanaTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Asana options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      const url = new URL(input.trim());
      const web = new URL(webBaseOf(r.baseUrl));
      if (url.origin !== web.origin) return null;
      // /0/<project>/<task>[/f] (0 for no project), /1/<workspace>/project/<project>/task/<task>, …/task/<task>
      const m = /^\/0\/(?:\d+)\/(\d+)(?:\/f)?\/?$/.exec(url.pathname) ?? /^\/1\/\d+\/(?:[a-z-]+\/\d+\/)*task\/(\d+)(?:\/[a-z]+)?\/?$/.exec(url.pathname);
      return m ? { key: keyOfGid(m[1]), remoteId: m[1] } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await asanaOk<AsanaUser>(await credsOf(x), `/users/me?opt_fields=${USER_FIELDS}`);
    return { ...person(me), ...(me.email ? { email: me.email, login: me.email } : {}) };
  },

  async probe(x) {
    const c = await credsOf(x);
    await asanaOk<AsanaUser>(c, "/users/me?opt_fields=name");
    const sources: ActiveWorkflowSource[] = [{ kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / completed" }];
    // Sections are statuses only once the options name some: then each project is a board (the first hundred of each workspace).
    if (Object.keys(x.conn.options.columns).length > 0) {
      for (const ws of await workspacesOf(c, x)) {
        const r = await asanaPage<AsanaRef>(c, "/projects", { limit: 100, params: { workspace: ws, archived: "false", opt_fields: "name" } });
        for (const p of r?.data ?? []) sources.push({ kind: "column", transitions: "move", ref: { kind: "column", boardRemoteId: p.gid }, name: p.name ?? p.gid });
      }
    }
    // Asana's limits depend on the plan and answer only when exceeded (429, Retry-After): no figure to give.
    return { capabilities: asanaCapabilities, activeSources: sources, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const shape = shapeOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const pass = decodePageToken<IssuePage>(x.conn, "issues", V, q.since, q.page) ?? { ws: await workspacesOf(c, x), i: 0, offset: null, at: Date.now() };
    const ws = pass.ws[pass.i];
    let items: RemoteIssue[] = [];
    let next: string | null = null;
    if (ws !== undefined) {
      // assignee needs its workspace. A first read bounds the completed tasks it takes; a later one is bounded by modified_since.
      const params: Record<string, string> = { assignee: "me", workspace: ws, opt_fields: TASK_FIELDS, ...(since === null ? { completed_since: new Date(pass.at - COMPLETED_WINDOW_DAYS * DAY_MS).toISOString() } : { modified_since: new Date(since).toISOString() }) };
      const r = await asanaPage<AsanaTask>(c, "/tasks", { limit: PER_PAGE, offset: pass.offset, params });
      items = await shapeAll(c, shape, r?.data ?? []);
      next = r?.next ?? null;
    }
    const more: IssuePage | null = next ? { ...pass, offset: next } : pass.i + 1 < pass.ws.length ? { ...pass, i: pass.i + 1, offset: null } : null;
    if (more) return { last: false, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, more) };
    return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: pass.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const c = await credsOf(x);
    const t = await locate(c, gidOfHandle(ref));
    return t ? (await shapeAll(c, shapeOf(x), [t]))[0] : null;
  },

  async findIssue(x, handle) {
    const c = await credsOf(x);
    const t = await locate(c, gidOfHandle(handle));
    // A gid is unique on the service: never ambiguous.
    return t ? { kind: "found", issue: (await shapeAll(c, shapeOf(x), [t]))[0] } : { kind: "none" };
  },

  searchText: search,

  async statuses(x, source) {
    if (source.kind === "boolean") return [OPEN, COMPLETED];
    if (source.kind !== "column") return [];
    const s = shapeOf(x);
    const sections = await asanaPages<AsanaRef>(await credsOf(x), `/projects/${encodeURIComponent(source.ref.boardRemoteId)}/sections`, { opt_fields: "name" });
    return sections.flatMap((section, order) => {
      const category = s.columns[sectionKey(section.name ?? "")];
      return category ? [{ ...columnStatus(s, source.ref.boardRemoteId, section, category), order }] : [];
    });
  },

  async description(x, ref) {
    const t = await locate(await credsOf(x), gidOfHandle(ref));
    return t?.notes?.trim() ? { kind: "text", format: "html", text: t.html_notes ?? `<body>${escapeHtml(t.notes)}</body>` } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const s = shapeOf(x);
      const common = { requirements: [], remoteUrl: t.permalink_url };
      if (t.completed) return [{ id: "reopen", name: "Reopen", to: statusOf(s, { completed: false, memberships: t.memberships }), ...common }] satisfies Transition[];
      const now = columnOf(s, t.memberships ?? []);
      const project = (t.memberships ?? []).find((m) => m.project)?.project;
      // Only the sections of the task's own project: adding it to another project's section would put it in that project.
      const sections = project ? await asanaPages<AsanaRef>(c, `/projects/${encodeURIComponent(project.gid)}/sections`, { opt_fields: "name" }) : [];
      const moves = sections.flatMap((section): Transition[] => {
        const category = s.columns[sectionKey(section.name ?? "")];
        return category && section.gid !== now?.id && project ? [{ id: `section:${section.gid}`, name: `Move to ${section.name}`, to: columnStatus(s, project.gid, section, category), ...common }] : [];
      });
      return [...moves, { id: "complete", name: "Complete", to: COMPLETED, ...common }];
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const shape = shapeOf(x);
      if (transitionId === "complete" || transitionId === "reopen") {
        const done = await asanaOk<AsanaTask>(c, `${taskPath(t.gid)}?opt_fields=${TASK_FIELDS}`, { method: "PUT", data: { completed: transitionId === "complete" } });
        return (await shapeAll(c, shape, [done]))[0];
      }
      const section = transitionId.startsWith("section:") ? transitionId.slice(8) : null;
      const project = (t.memberships ?? []).find((m) => m.project)?.project;
      if (!section || !project) throw new ProviderError("invalid", `Asana: no transition ${transitionId}`);
      const sections = await asanaPages<AsanaRef>(c, `/projects/${encodeURIComponent(project.gid)}/sections`, { opt_fields: "name" });
      const target = sections.find((sec) => sec.gid === section);
      if (!target || !shape.columns[sectionKey(target.name ?? "")]) throw new ProviderError("invalid", `Asana: no transition ${transitionId}`);
      await asanaOk<unknown>(c, `/sections/${encodeURIComponent(section)}/addTask`, { method: "POST", data: { task: t.gid } });
      // addTask answers an empty record: read the task again.
      const moved = await locate(c, t.gid);
      return moved ? (await shapeAll(c, shape, [moved]))[0] : null;
    },
  },

  worklogs: {
    async list(x, ref) {
      const c = await credsOf(x);
      const gid = gidOfHandle(ref);
      if (!gid) throw new ProviderError("notFound", `Asana: no task ${ref.key}`);
      const entries = await asanaPages<AsanaEntry>(c, `${taskPath(gid)}/time_tracking_entries`, { opt_fields: ENTRY_FIELDS });
      return entries.map((e) => toRemoteWorklog(e, x.conn.remoteAccountId));
    },
    async get(x, _ref, id) {
      const e = await asana<AsanaEntry>(await credsOf(x), `/time_tracking_entries/${encodeURIComponent(id)}?opt_fields=${ENTRY_FIELDS}`, { missingIsNull: true });
      return e ? toRemoteWorklog(e.data, x.conn.remoteAccountId) : null;
    },
    async create(x, ref, w) {
      const gid = gidOfHandle(ref);
      if (!gid) throw new ProviderError("notFound", `Asana: no task ${ref.key}`);
      const e = await asanaOk<AsanaEntry>(await credsOf(x), `${taskPath(gid)}/time_tracking_entries?opt_fields=${ENTRY_FIELDS}`, { method: "POST", data: entryBody(w) });
      return toRemoteWorklog(e, x.conn.remoteAccountId);
    },
    async update(x, _ref, id, w) {
      const e = await asanaOk<AsanaEntry>(await credsOf(x), `/time_tracking_entries/${encodeURIComponent(id)}?opt_fields=${ENTRY_FIELDS}`, { method: "PUT", data: entryBody(w) });
      return toRemoteWorklog(e, x.conn.remoteAccountId);
    },
    async delete(x, _ref, id) {
      // Deleting what is already gone is a success.
      await asana<unknown>(await credsOf(x), `/time_tracking_entries/${encodeURIComponent(id)}`, { method: "DELETE", missingIsNull: true });
    },
    /** The time tracking categories of the workspaces (an entry has at most one). */
    async activities(x, _scope, limit) {
      const c = await credsOf(x);
      const items: { id: string; name: string }[] = [];
      for (const ws of await workspacesOf(c, x)) {
        for (const cat of await asanaPages<AsanaRef>(c, "/time_tracking_categories", { workspace: ws, opt_fields: "name" })) items.push({ id: cat.gid, name: cat.name ?? cat.gid });
      }
      return { items: items.slice(0, limit), complete: items.length <= limit };
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      // System stories ("moved this task to…", "assigned to…") share the list: they are history, not comments.
      const stories = await asanaPages<AsanaStory>(c, `${taskPath(t.gid)}/stories`, { opt_fields: STORY_FIELDS });
      return stories.filter((s) => s.type === "comment").map(toRemoteComment);
    },
    async add(x, ref, body) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const { html, warnings } = toAsanaHtml(body);
      const story = await asanaOk<AsanaStory>(c, `${taskPath(t.gid)}/stories?opt_fields=${STORY_FIELDS}`, { method: "POST", data: { html_text: html } });
      return { comment: toRemoteComment(story), warnings };
    },
  },

  async watch(x, ref, on) {
    const gid = gidOfHandle(ref);
    if (!gid) throw new ProviderError("notFound", `Asana: no task ${ref.key}`);
    // Following twice, or unfollowing twice, is what was asked.
    await asanaOk<unknown>(await credsOf(x), `${taskPath(gid)}/${on ? "addFollowers" : "removeFollowers"}`, { method: "POST", data: { followers: ["me"] } });
  },

  async statusHistory(x, ref) {
    const c = await credsOf(x);
    const t = await mustLocate(c, ref);
    return replayStatus(shapeOf(x), t, await asanaPages<AsanaStory>(c, `${taskPath(t.gid)}/stories`, { opt_fields: STORY_FIELDS }));
  },

  async history(x, ref) {
    const c = await credsOf(x);
    const t = await mustLocate(c, ref);
    const stories = await asanaPages<AsanaStory>(c, `${taskPath(t.gid)}/stories`, { opt_fields: STORY_FIELDS });
    return stories.flatMap((s) => toChange(s) ?? []).sort((a, b) => a.at - b.at);
  },
};
