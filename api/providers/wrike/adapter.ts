// Wrike as a tracker, through the provider contract. Tasks the user is
// responsible for, keyed WRIKE-<n>: <n> is the number in the task's link
// (open.htm?id=<n>), which is not the API id (16 letters and digits, what the
// adapter keeps as the remote id; GET /ids converts the number). A task's
// status is a custom status of its folder's workflow, whose group (Active,
// Completed, Deferred, Cancelled) says what it means. Time is Wrike's timelogs:
// a tracked day and decimal hours, a category, billable or not.
// Built on a simulator, not verified on a real account: docs/dev/spikes.md.
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { DAY_MS } from "@contracts/time";
import { instant, instantFrom, localDate, localDateOf, type Instant, type LocalDate } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { sameSecret } from "../core/webhooks";
import type {
  ActiveWorkflowSource,
  CallContext,
  ConversionWarning,
  ContainerRef,
  IssueHandle,
  IssueRef,
  Limited,
  ReportedIssueGone,
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
  TASK_FIELDS,
  webBaseOf,
  wrike,
  wrikeByIds,
  wrikeInstant,
  wrikeList,
  wrikeOne,
  type WrikeCategory,
  type WrikeComment,
  type WrikeContact,
  type WrikeCreds,
  type WrikeFolder,
  type WrikeGroup,
  type WrikeTask,
  type WrikeTimelog,
  type WrikeWorkflow,
} from "./client";

// The catalogue's entry for wrike, here where the adapter keeps to it (the
// registry holds the two together).
export const wrikeCapabilities: TrackerCapabilities = {
  workflow: { sources: [{ kind: "itemState", transitions: "direct" }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["html"], writePreserves: ["paragraph", "emphasis", "strong", "link", "list"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: true,
  inbox: false,
  otherFields: false,
  history: false,
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "native", delete: true },
      feed: { kind: "window", by: "updatedAt", lookbackMs: 30 * 86_400_000, overlapMs: 3_600_000 },
      reconcile: { kind: "period" },
      billable: { read: true, write: true },
      activities: { read: true, write: true, required: "no" },
      onBehalf: { read: false, write: false },
      approvals: { read: true },
      idempotency: "local",
      concurrency: "none",
      limits: { maxSeconds: 24 * 3600 },
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
    ],
  },
};

export const wrikeTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: [],
  fields: ["priority", "due", "start", "estimate", "multiAssignee", "custom"],
};

// Nothing to choose: the statuses and their groups are Wrike's own.
const optionsSchema = z.strictObject({});
export type WrikeOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"wrike", WrikeOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
type Stage = "open" | "recent" | "changed" | "deleted";
type IssuePage = { stage: Stage; token: string | null; at: number };

/** Overlap read again at each pass: updates land after the clock that stamps them, and Wrike stamps whole seconds. */
const OVERLAP_MS = 60_000;
const PER_PAGE = 100;
/** A first read takes the tasks completed or cancelled in this window, with everything still active or deferred. */
const FINISHED_WINDOW_DAYS = 30;
const FIRST_STAGES: Stage[] = ["open", "recent"];
const LATER_STAGES: Stage[] = ["changed", "deleted"];

async function credsOf(x: X): Promise<WrikeCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

// ---------- Keys and links ----------

/** WRIKE-<n>, n the number of the task's permalink. */
const KEY = /^WRIKE-(\d{1,15})$/;
const keyOfNum = (n: string) => `WRIKE-${n}`;
const normalizeKey = (raw: string) => {
  const k = raw.trim().toUpperCase();
  return KEY.test(k) ? k : null;
};
const numOfKey = (key: string) => KEY.exec(key)?.[1] ?? null;
/** The number in a permalink (open.htm?id=<n>). */
const numOfLink = (link: string) => /[?&]id=(\d{1,15})(?:&|$)/.exec(link)?.[1] ?? null;

/** An API id is letters and digits; anything else can't be one, and Wrike answers 400 to it. */
const apiIdLike = (id: string) => /^[A-Za-z0-9]{10,24}$/.test(id);

/** The API id a handle points to: its remote id, else the key's number converted (null: Wrike doesn't know it). */
async function idOfHandle(c: WrikeCreds, h: { remoteId?: string; key?: string }): Promise<string | null> {
  if (h.remoteId) return h.remoteId;
  const num = h.key ? numOfKey(h.key) : null;
  if (!num) return null;
  const found = await wrikeList<{ id: string; uid?: number }>(c, "/ids", { query: { type: "ApiV2Task", ids: [Number(num)] } });
  return found[0]?.id ?? null;
}

// ---------- Statuses ----------

type Flow = { list: WrikeWorkflow[]; byStatus: Map<string, { workflow: WrikeWorkflow; status: RemoteStatus }> };

/**
 * Wrike says what a status means: its group. Active has no further grain, so
 * the first Active status of a workflow (where a task starts) is todo and the
 * other Active ones are doing; Deferred is backlog.
 */
function categoryOf(group: WrikeGroup, firstActive: boolean): StatusCategory {
  if (group === "Active") return firstActive ? "todo" : "doing";
  if (group === "Deferred") return "backlog";
  return group === "Completed" ? "done" : "cancelled";
}

/** A task whose status Wrike no longer lists (a deleted custom status) reads as its group. */
const groupStatus = (group: WrikeGroup): RemoteStatus => ({ id: `group:${group}`, name: group, category: categoryOf(group, true), categoryOrigin: { by: "native" }, source: { kind: "itemState" } });

async function flowOf(c: WrikeCreds): Promise<Flow> {
  const list = (await wrikeList<WrikeWorkflow>(c, "/workflows")).filter((w) => !w.hidden);
  const byStatus = new Map<string, { workflow: WrikeWorkflow; status: RemoteStatus }>();
  for (const workflow of list) {
    const first = workflow.customStatuses.findIndex((s) => s.group === "Active");
    workflow.customStatuses.forEach((s, order) => {
      byStatus.set(s.id, { workflow, status: { id: s.id, name: s.name, category: categoryOf(s.group, order === first), categoryOrigin: { by: "native" }, source: { kind: "itemState" }, ...(s.color ? { color: s.color } : {}), order } });
    });
  }
  return { list, byStatus };
}

const statusOf = (flow: Flow, t: Pick<WrikeTask, "status" | "customStatusId">): RemoteStatus => (t.customStatusId ? flow.byStatus.get(t.customStatusId)?.status : undefined) ?? groupStatus(t.status);

// ---------- Shaping ----------

const person = (c: WrikeContact): RemotePerson => ({ remoteId: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profiles?.[0]?.email || c.id, avatarUrl: c.avatarUrl ?? null });
const unknownPerson = (id: string): RemotePerson => ({ remoteId: id, name: id, avatarUrl: null });

/** Task dates are floating local times ("2026-11-05T17:00:00"): the day they say. One with a zone is an instant, which falls on the user's day. */
function dayOf(text: string | undefined, zone: Parameters<typeof localDateOf>[1]): LocalDate | null {
  if (!text) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const at = instantFrom(text);
    return at === null ? null : localDateOf(at, zone);
  }
  const d = /^\d{4}-\d{2}-\d{2}/.exec(text)?.[0];
  return d ? localDate(d) : null;
}

const IMPORTANCE: Record<string, { name: string; rank: number }> = { High: { name: "High", rank: 0 }, Normal: { name: "Normal", rank: 2 }, Low: { name: "Low", rank: 4 } };

/** What turning a page of tasks into the layer's shape needs of Wrike: statuses, people, folders. */
type Lookups = { flow: Flow; people: Map<string, WrikeContact>; folders: Map<string, WrikeFolder>; zone: Parameters<typeof localDateOf>[1]; accountId: string };

function containerOf(t: WrikeTask, l: Lookups): ContainerRef {
  const id = (t.parentIds ?? [])[0];
  if (!id) return { remoteId: t.accountId ?? l.accountId, key: "none", name: "No folder", kind: "workspace" };
  const f = l.folders.get(id);
  return { remoteId: id, key: f?.title ?? id, name: f?.title ?? id, kind: f?.project ? "project" : "folder" };
}

export function toRemoteIssue(t: WrikeTask, l: Lookups): RemoteIssue {
  const num = numOfLink(t.permalink);
  if (!num) throw new ProviderError("incompatible", `Wrike: no number in the permalink of ${t.id}`);
  const who = (id: string) => {
    const c = l.people.get(id);
    return c ? person(c) : unknownPerson(id);
  };
  const milestone = t.dates?.type === "Milestone";
  const sub = (t.superTaskIds ?? []).length > 0;
  const imp = t.importance ? IMPORTANCE[t.importance] : undefined;
  const effort = t.effortAllocation?.totalEffort;
  return {
    remoteId: t.id,
    key: keyOfNum(num),
    url: t.permalink,
    title: t.title,
    type: milestone ? { id: "milestone", name: "Milestone", level: "standard" } : sub ? { id: "subtask", name: "Subtask", level: "sub" } : { id: "task", name: "Task", level: "standard" },
    status: statusOf(l.flow, t),
    container: containerOf(t, l),
    priority: imp && t.importance ? { id: t.importance, name: imp.name, rank: imp.rank } : null,
    labels: [],
    assignees: (t.responsibleIds ?? []).map(who),
    reporter: t.authorIds?.[0] ? who(t.authorIds[0]) : null,
    due: dayOf(t.dates?.due, l.zone),
    estimateSeconds: typeof effort === "number" ? effort * 60 : null,
    spentSeconds: null,
    createdAt: instantFrom(t.createdDate),
    updatedAt: instantFrom(t.updatedDate),
    statusChangedAt: instantFrom(t.completedDate ?? null),
    parent: null,
  };
}

/** A page of tasks as issues: the workflows once, the people and folders they name by id, a hundred to a call. */
async function shapeAll(c: WrikeCreds, x: X, tasks: WrikeTask[]): Promise<RemoteIssue[]> {
  if (tasks.length === 0) return [];
  const [flow, contacts, folders] = await Promise.all([
    flowOf(c),
    wrikeByIds<WrikeContact>(c, "/contacts", tasks.flatMap((t) => [...(t.responsibleIds ?? []), ...(t.authorIds ?? [])])),
    wrikeByIds<WrikeFolder>(c, "/folders", tasks.flatMap((t) => (t.parentIds ?? []).slice(0, 1))),
  ]);
  const l: Lookups = { flow, people: new Map(contacts.map((p) => [p.id, p])), folders: new Map(folders.map((f) => [f.id, f])), zone: x.conn.timeZone, accountId: tasks[0].accountId ?? "" };
  return tasks.map((t) => toRemoteIssue(t, l));
}

// ---------- Finding a task ----------

const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;

/** A task as it is now; null when it isn't there (404), the user cannot see it (403) or it is in the recycle bin (Wrike still answers it, scope RbTask). */
async function locate(c: WrikeCreds, id: string | null): Promise<WrikeTask | null> {
  if (!id || !apiIdLike(id)) return null;
  try {
    const r = await wrike<WrikeTask>(c, taskPath(id), { query: { fields: TASK_FIELDS }, missingIsNull: true });
    const t = r?.data[0];
    return t && t.scope !== "RbTask" ? t : null;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "forbidden") return null;
    throw e;
  }
}

async function mustLocate(c: WrikeCreds, ref: IssueRef): Promise<WrikeTask> {
  const t = await locate(c, ref.remoteId);
  if (!t) throw new ProviderError("notFound", `Wrike: no task ${ref.key}`);
  return t;
}

// ---------- Search ----------

async function search(x: X, text: string, limit: number): Promise<Limited<RemoteIssue>> {
  const c = await credsOf(x);
  // The title filter is a substring match; one more than asked tells whether there is more.
  const r = await wrike<WrikeTask>(c, "/tasks", {
    query: { responsibles: [x.conn.remoteAccountId], title: text, pageSize: Math.min(1000, limit + 1), sortField: "UpdatedDate", sortOrder: "Desc", fields: TASK_FIELDS },
  });
  const tasks = r?.data ?? [];
  return { items: await shapeAll(c, x, tasks.slice(0, limit)), complete: tasks.length <= limit && r?.next == null };
}

// ---------- Time ----------

const APPROVALS = { Draft: "draft", Pending: "submitted", Approved: "approved", Rejected: "rejected" } as const;

function toRemoteWorklog(l: WrikeTimelog, me: string, categories: Map<string, string>): RemoteWorklog {
  const state = l.approvalStatus ?? null;
  // A timelog waiting for approval or approved is locked for everyone.
  const locked = state === "Approved" ? ({ cause: "approved" } as const) : state === "Pending" ? ({ cause: "submitted" } as const) : null;
  const mine = l.userId === me;
  return {
    remoteId: l.id,
    issue: { remoteId: l.taskId },
    span: { kind: "date", date: localDate(l.trackedDate), seconds: Math.round(l.hours * 3600) },
    comment: l.comment ?? "",
    authorRemoteId: l.userId,
    createdAt: instantFrom(l.createdDate ?? null),
    updatedAt: instantFrom(l.updatedDate ?? null),
    billable: l.billingType === "Billable" ? true : l.billingType === "NonBillable" ? false : null,
    activity: l.categoryId ? { id: l.categoryId, name: categories.get(l.categoryId) ?? "" } : null,
    approval: state ? APPROVALS[state] : null,
    locked,
    editable: { update: mine && !locked, delete: mine && !locked },
  };
}

/** Category names, read only when a timelog has a category. */
async function categoryNames(c: WrikeCreds, logs: WrikeTimelog[]): Promise<Map<string, string>> {
  if (!logs.some((l) => l.categoryId)) return new Map();
  return new Map((await wrikeList<WrikeCategory>(c, "/timelog_categories")).map((k) => [k.id, k.name]));
}

async function shapeLogs(c: WrikeCreds, x: X, logs: WrikeTimelog[]): Promise<RemoteWorklog[]> {
  const names = await categoryNames(c, logs);
  return logs.map((l) => toRemoteWorklog(l, x.conn.remoteAccountId, names));
}

/** Wrike keeps decimal hours, to two decimals: a duration is rounded to the nearest hundredth of an hour (36 s), at least one. */
const hoursOf = (seconds: number) => Math.max(1, Math.round(seconds / 36)) / 100;

function logForm(w: WorklogInput) {
  if (w.time.kind !== "date") throw new ProviderError("invalid", `Wrike keeps time on a day, not a ${w.time.kind}`);
  return {
    hours: hoursOf(w.time.seconds),
    trackedDate: w.time.date,
    comment: w.comment,
    plainText: true,
    ...(w.activityId ? { categoryId: w.activityId } : {}),
    ...(w.billable === undefined ? {} : { billingType: w.billable ? "Billable" : "NonBillable" }),
  };
}

// ---------- Comments ----------

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline Markdown as the few tags Wrike keeps in a comment (b, i, strike, code, a); code spans are left alone. */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, n) => {
      if (n % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part)
        .replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label || url}</a>`)
        .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<b>${a ?? b}</b>`)
        .replace(/~~([^~\n]+)~~/g, "<strike>$1</strike>")
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?!\w)|(^|[^_\w])_([^_\s][^_\n]*)_(?!\w)/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) => `${p1 ?? p2 ?? ""}<i>${a ?? b}</i>`);
    })
    .join("");
}

/**
 * Markdown as a Wrike comment: HTML in which a newline is not a break (so
 * lines are joined by <br />) and only a short list of tags survives (the rest
 * is stripped by Wrike without a word, so none is sent). What can't be kept
 * (headings, quotes, code blocks, tables, images) is written as plain text
 * and said so.
 */
export function toWrikeHtml(md: string): { html: string; warnings: ConversionWarning[] } {
  const warnings = new Map<string, ConversionWarning>();
  const approximate = (feature: NonNullable<ConversionWarning["feature"]>) => warnings.set(feature, { code: "approximated", feature, serverDetail: `markdown ${feature} sent to Wrike as plain text` });
  let html = "";
  let started = false;
  let afterList = false;
  let blank = false;
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let fenced = false;
  const line = (s: string) => {
    html += `${started && !afterList ? "<br />" : ""}${s}`;
    started = true;
    afterList = false;
  };
  const flush = () => {
    if (!list) return;
    html += `<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`;
    started = true;
    afterList = true;
    list = null;
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      approximate("codeBlock");
      continue;
    }
    if (fenced) {
      flush();
      line(escapeHtml(raw));
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) {
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (list && list.tag !== tag) flush();
      list ??= { tag, items: [] };
      list.items.push(inline(item[2]));
      blank = false;
      continue;
    }
    flush();
    if (raw.trim() === "") {
      // One empty line is a paragraph break; more are the same.
      if (!blank && started) line("");
      blank = true;
      continue;
    }
    blank = false;
    let text = raw;
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
    line(inline(text));
  }
  flush();
  return { html: html.replace(/(<br \/>)+$/, ""), warnings: [...warnings.values()] };
}

async function commentsOf(c: WrikeCreds, list: WrikeComment[]): Promise<RemoteComment[]> {
  const people = new Map((await wrikeByIds<WrikeContact>(c, "/contacts", list.map((k) => k.authorId))).map((p) => [p.id, p]));
  return list.map((k) => ({
    id: k.id,
    author: people.get(k.authorId) ? person(people.get(k.authorId)!) : unknownPerson(k.authorId),
    body: { kind: "text", format: "html", text: k.text },
    createdAt: instantFrom(k.createdDate),
    updatedAt: instantFrom(k.updatedDate ?? null),
  }));
}

// ---------- Webhooks ----------

type Headers2 = Record<string, string>;
type WrikeEvent = "issueChanged" | "issueRemoved" | "commentAdded" | "worklogChanged";

/**
 * Wrike's webhooks. Each delivery is a JSON list of events (webhookId,
 * eventType, taskId, lastUpdatedDate…), and X-Hook-Secret carries the hex
 * HMAC-SHA256 of the raw body under the webhook's secret. Deliveries have no
 * id of their own; their age is the latest event's time.
 */
export const wrikeWebhook = {
  verify(headers: Headers2, rawBody: string, secret: string): boolean {
    const given = headers["x-hook-secret"];
    if (!secret || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
    return sameSecret(given.toLowerCase(), createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"));
  },
  /** When the latest event happened, from the body (null: none says). */
  sentAt(rawBody: string): Instant | null {
    try {
      const events = JSON.parse(rawBody) as { lastUpdatedDate?: unknown }[];
      const times = (Array.isArray(events) ? events : []).flatMap((e) => (typeof e.lastUpdatedDate === "string" ? [instantFrom(e.lastUpdatedDate)] : [])).filter((t): t is Instant => t !== null);
      return times.length ? instant(Math.max(...times)) : null;
    } catch {
      return null;
    }
  },
  /** Which of the declared events a delivery holds; nothing for folders, projects and the like. */
  events(rawBody: string): WrikeEvent[] {
    let events: { eventType?: unknown }[] = [];
    try {
      const parsed: unknown = JSON.parse(rawBody);
      events = Array.isArray(parsed) ? (parsed as typeof events) : [];
    } catch {
      return [];
    }
    const found = new Set<WrikeEvent>();
    for (const e of events) {
      const type = typeof e.eventType === "string" ? e.eventType : "";
      if (type === "TaskDeleted") found.add("issueRemoved");
      else if (/^Comment/.test(type)) found.add("commentAdded");
      else if (/^Timelog/.test(type)) found.add("worklogChanged");
      else if (/^Task/.test(type)) found.add("issueChanged");
    }
    return [...found];
  },
};

// ---------- The adapter ----------

export const wrikeProvider: TrackerProvider<"wrike", WrikeOptions> = {
  // Deliveries signed with the webhook's secret; no id to refuse a replay by, a time (the latest event) to refuse a stale one by.
  webhook: {
    verify: (req, secret) => wrikeWebhook.verify(req.headers, req.body, secret),
    deliveryId: () => null,
    sentAt: (req) => wrikeWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "wrike",
  capabilities: wrikeCapabilities,
  traits: wrikeTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Wrike options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      const url = new URL(input.trim());
      if (url.origin !== new URL(webBaseOf(r.baseUrl)).origin) return null;
      // open.htm?id=<n>: the link Wrike gives for a task. The number is not the API id: the key keeps it, GET /ids converts it.
      const n = url.pathname === "/open.htm" ? /^\d{1,15}$/.exec(url.searchParams.get("id") ?? "")?.[0] : null;
      return n ? { key: keyOfNum(n) } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await wrikeOne<WrikeContact>(await credsOf(x), "/contacts", { query: { me: true } });
    const email = me.profiles?.[0]?.email;
    return { ...person(me), ...(email ? { email, login: email } : {}) };
  },

  async probe(x) {
    await wrikeOne<WrikeContact>(await credsOf(x), "/contacts", { query: { me: true } });
    const sources: ActiveWorkflowSource[] = [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Task status" }];
    // Wrike limits requests per minute and answers only when exceeded (429): no figure to give.
    return { capabilities: wrikeCapabilities, activeSources: sources, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    const stages = since === null ? FIRST_STAGES : LATER_STAGES;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const pass = decodePageToken<IssuePage>(x.conn, "issues", V, q.since, q.page) ?? { stage: stages[0], token: null, at: Date.now() };
    const n = stages.indexOf(pass.stage);
    if (n < 0) throw new ProviderError("invalidCheckpoint", "Wrike: a page of another kind of pass");
    const from = since === null ? 0 : wrikeInstant(since);
    const query: Record<string, unknown> = { responsibles: [x.conn.remoteAccountId], pageSize: PER_PAGE, sortField: "UpdatedDate", sortOrder: "Asc", nextPageToken: pass.token ?? undefined };
    if (pass.stage === "open") Object.assign(query, { status: ["Active", "Deferred"], fields: TASK_FIELDS });
    else if (pass.stage === "recent") Object.assign(query, { status: ["Completed", "Cancelled"], updatedDate: { start: wrikeInstant(pass.at - FINISHED_WINDOW_DAYS * DAY_MS) }, fields: TASK_FIELDS });
    else if (pass.stage === "changed") Object.assign(query, { updatedDate: { start: from }, fields: TASK_FIELDS });
    else Object.assign(query, { deleted: true, updatedDate: { start: from } });
    const r = await wrike<WrikeTask>(c, "/tasks", { query });
    const tasks = r?.data ?? [];
    // Tasks in the recycle bin are what the user no longer has: Wrike lists them apart.
    const gone: ReportedIssueGone[] = pass.stage === "deleted" ? tasks.map((t) => ({ remoteId: t.id, reason: "deleted" })) : [];
    const items = pass.stage === "deleted" ? [] : await shapeAll(c, x, tasks);
    const more: IssuePage | null = r?.next ? { ...pass, token: r.next } : n + 1 < stages.length ? { stage: stages[n + 1], token: null, at: pass.at } : null;
    if (more) return { last: false, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, more) };
    return { last: true, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: pass.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const c = await credsOf(x);
    const t = await locate(c, ref.remoteId);
    return t ? (await shapeAll(c, x, [t]))[0] : null;
  },

  async findIssue(x, handle) {
    const c = await credsOf(x);
    const t = await locate(c, await idOfHandle(c, handle));
    // An API id is unique on the service, and a number converts to one: never ambiguous.
    return t ? { kind: "found", issue: (await shapeAll(c, x, [t]))[0] } : { kind: "none" };
  },

  searchText: search,

  async statuses(x, source) {
    if (source.kind !== "itemState") return [];
    const flow = await flowOf(await credsOf(x));
    return flow.list.flatMap((w) => w.customStatuses.filter((s) => !s.hidden).map((s) => flow.byStatus.get(s.id)!.status));
  },

  async description(x, ref) {
    const c = await credsOf(x);
    if (!apiIdLike(ref.remoteId)) return null;
    const r = await wrike<WrikeTask>(c, taskPath(ref.remoteId), { query: { fields: ["description"] }, missingIsNull: true });
    const html = r?.data[0]?.description;
    return html?.trim() ? { kind: "text", format: "html", text: html } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const flow = await flowOf(c);
      // The ways out are the other statuses of the workflow the task's status belongs to; hidden ones can't be set.
      const here = t.customStatusId ? flow.byStatus.get(t.customStatusId) : undefined;
      if (!here) return [];
      return here.workflow.customStatuses.flatMap((s): Transition[] =>
        s.hidden || s.id === t.customStatusId ? [] : [{ id: s.id, name: `Move to ${s.name}`, to: flow.byStatus.get(s.id)!.status, requirements: [], remoteUrl: t.permalink }],
      );
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const flow = await flowOf(c);
      const here = t.customStatusId ? flow.byStatus.get(t.customStatusId) : undefined;
      if (!here?.workflow.customStatuses.some((s) => s.id === transitionId && !s.hidden)) throw new ProviderError("invalid", `Wrike: no transition ${transitionId}`);
      const moved = await wrikeOne<WrikeTask>(c, taskPath(t.id), { method: "PUT", form: { customStatus: transitionId }, query: { fields: TASK_FIELDS } });
      return (await shapeAll(c, x, [moved]))[0];
    },
  },

  worklogs: {
    async list(x, ref) {
      const c = await credsOf(x);
      if (!apiIdLike(ref.remoteId)) throw new ProviderError("notFound", `Wrike: no task ${ref.key}`);
      return shapeLogs(c, x, await wrikeList<WrikeTimelog>(c, `${taskPath(ref.remoteId)}/timelogs`, { query: { plainText: true } }));
    },
    async get(x, _ref, id) {
      const c = await credsOf(x);
      const r = await wrike<WrikeTimelog>(c, `/timelogs/${encodeURIComponent(id)}`, { query: { plainText: true }, missingIsNull: true });
      return r?.data[0] ? (await shapeLogs(c, x, [r.data[0]]))[0] : null;
    },
    /** The user's timelogs updated in the last 30 days: a window, always read whole (Wrike has no deletion feed). */
    async changed(x, q) {
      const c = await credsOf(x);
      decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since);
      decodePageToken<Since>(x.conn, "worklogs", V, q.since, q.page);
      const at = Date.now();
      const logs = await wrikeList<WrikeTimelog>(c, "/timelogs", { query: { me: true, updatedDate: { start: wrikeInstant(at - 30 * DAY_MS) }, plainText: true } });
      return { last: true, items: await shapeLogs(c, x, logs), gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at } satisfies Since) };
    },
    async create(x, ref, w) {
      const c = await credsOf(x);
      if (!apiIdLike(ref.remoteId)) throw new ProviderError("notFound", `Wrike: no task ${ref.key}`);
      const l = await wrikeOne<WrikeTimelog>(c, `${taskPath(ref.remoteId)}/timelogs`, { method: "POST", form: logForm(w) });
      return (await shapeLogs(c, x, [l]))[0];
    },
    async update(x, _ref, id, w) {
      const c = await credsOf(x);
      const l = await wrikeOne<WrikeTimelog>(c, `/timelogs/${encodeURIComponent(id)}`, { method: "PUT", form: logForm(w) });
      return (await shapeLogs(c, x, [l]))[0];
    },
    async delete(x, _ref, id) {
      // Deleting what is already gone is a success.
      await wrike<WrikeTimelog>(await credsOf(x), `/timelogs/${encodeURIComponent(id)}`, { method: "DELETE", missingIsNull: true });
    },
    /** The timelog categories of the account (an entry has at most one). */
    async activities(x, _scope, limit) {
      const cats = (await wrikeList<WrikeCategory>(await credsOf(x), "/timelog_categories")).filter((k) => !k.hidden);
      return { items: cats.slice(0, limit).map((k) => ({ id: k.id, name: k.name })), complete: cats.length <= limit };
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      return commentsOf(c, await wrikeList<WrikeComment>(c, `${taskPath(t.id)}/comments`, { query: { plainText: false } }));
    },
    async add(x, ref, body) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const { html, warnings } = toWrikeHtml(body);
      const made = await wrikeOne<WrikeComment>(c, `${taskPath(t.id)}/comments`, { method: "POST", form: { text: html, plainText: false } });
      return { comment: (await commentsOf(c, [made]))[0], warnings };
    },
  },

  async watch(x, ref, on) {
    const c = await credsOf(x);
    if (!apiIdLike(ref.remoteId)) throw new ProviderError("notFound", `Wrike: no task ${ref.key}`);
    // Following twice, or unfollowing twice, is what was asked.
    await wrikeList<WrikeTask>(c, taskPath(ref.remoteId), { method: "PUT", form: { [on ? "addFollowers" : "removeFollowers"]: [x.conn.remoteAccountId] } });
  },
};
