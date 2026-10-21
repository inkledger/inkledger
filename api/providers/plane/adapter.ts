// Plane (plane.so cloud and self-hosted) as a tracker, through the provider
// contract. Work items assigned to the user, keyed PROJ-12 (the project's
// identifier and the item's sequence id; the uuid behind remoteId is what
// stays when an identifier is renamed). Their status is the project's own
// workflow state, categorized by the state's group (backlog, unstarted,
// started, completed, cancelled), never by its name. Time is Plane's
// worklogs: whole minutes on a day, created and read, not changed.
// Built on a simulator, not verified on a real account: docs/dev/spikes.md.
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, localDateOf, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { hmacHex, sameSecret } from "../core/webhooks";
import type {
  ActiveWorkflowSource,
  CallContext,
  ConversionWarning,
  IssueHandle,
  IssueRef,
  RemoteChange,
  RemoteComment,
  RemoteIssue,
  RemotePerson,
  RemoteStatus,
  RemoteWorklog,
  TrackerProvider,
  Transition,
} from "../types";
import {
  EXPAND,
  addressOf,
  inWorkspace,
  plane,
  planeAll,
  planeOk,
  planePage,
  webBaseOf,
  withQuery,
  type PlaneActivity,
  type PlaneComment,
  type PlaneCreds,
  type PlaneIssue,
  type PlaneProject,
  type PlaneSearchHit,
  type PlaneState,
  type PlaneStateGroup,
  type PlaneUser,
  type PlaneWorklog,
} from "./client";

// The catalogue's entry for plane, here where the adapter keeps to it (the
// registry holds the two together).
export const planeCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["html"], writePreserves: ["paragraph"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: false,
  inbox: false,
  otherFields: false,
  history: true,
  // The project's states, set directly.
  workflow: { sources: [{ kind: "itemState", transitions: "direct" }] },
  // Worklog update/delete and the plan they need (verify: plane-worklogs): none until then
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "none", delete: false },
      feed: { kind: "window", by: "entryDate", days: 30, overlapDays: 2 },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
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
    // Signals until a payload is shown to hold all the adapter needs (spikes: webhook payloads).
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const planeTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: ["cycle"],
  fields: ["priority", "due", "start", "points", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({
  /**
   * The workspace's slug (app.plane.so/<slug>). Left out, it is the last part
   * of the connection's address (https://api.plane.so/<slug>).
   */
  workspace: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "not a workspace slug")
    .nullable()
    .default(null),
});
export type PlaneOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"plane", PlaneOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** Where a pass is: the project (they are read in uuid order), the cursor inside it, and when the pass began. */
type Walk = { p: string | null; c: string | null; at: number };

/** Overlap read again at each pass: updates may land after the clock that stamps them. */
const OVERLAP_MS = 60_000;
const PER_PAGE = 50;
const DAY_MS = 86_400_000;
/** The feed window the capabilities declare, and its overlap. */
const WINDOW_DAYS = 30;
const OVERLAP_DAYS = 2;

// ---------- Keys and links ----------

/** PROJ-12: the project's identifier (letters and digits, up to 12), a dash, the sequence id. */
export const ISSUE_KEY = /^([A-Za-z0-9]{1,12})-(\d{1,9})$/;
const normalizeKey = (raw: string) => {
  const m = ISSUE_KEY.exec(raw.trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
};

// ---------- One call's lookups ----------

/** What a call keeps of what it has read: the projects, their states and the members are fetched once per call. */
type Ctx = {
  c: PlaneCreds;
  web: string;
  zone: TimeZone;
  /** The user's id on Plane */
  me: string;
  projects: Map<string, PlaneProject> | null;
  states: Map<string, PlaneState[]>;
  members: Map<string, PlaneUser> | null;
};

async function ctxOf(x: X): Promise<Ctx> {
  const cred = await x.conn.credential();
  const token = cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password;
  const { root, workspace } = addressOf(x.conn.baseUrl, x.conn.options.workspace);
  return { c: { root, workspace, token }, web: webBaseOf(root), zone: x.conn.timeZone, me: x.conn.remoteAccountId, projects: null, states: new Map(), members: null };
}

const ws = (k: Ctx, rest: string) => inWorkspace(k.c, rest);

/** Every project the user can see (archived ones included: their items can still be read). */
async function projectsOf(k: Ctx): Promise<Map<string, PlaneProject>> {
  if (!k.projects) {
    const list = await planeAll<PlaneProject>(k.c, ws(k, "/projects/"));
    k.projects = new Map(list.filter((p) => !p.deleted_at).map((p) => [p.id, p]));
  }
  return k.projects;
}

async function projectById(k: Ctx, id: string): Promise<PlaneProject> {
  const known = (await projectsOf(k)).get(id);
  if (known) return known;
  const r = await plane<PlaneProject>(k.c, ws(k, `/projects/${id}/`), { missingIsNull: true, forbiddenIsNull: true });
  if (!r) throw new ProviderError("notFound", `Plane: no project ${id}`);
  k.projects?.set(id, r.data);
  return r.data;
}

async function statesOf(k: Ctx, projectId: string): Promise<PlaneState[]> {
  let s = k.states.get(projectId);
  if (!s) {
    s = await planeAll<PlaneState>(k.c, ws(k, `/projects/${projectId}/states/`));
    k.states.set(projectId, s);
  }
  return s;
}

async function membersOf(k: Ctx): Promise<Map<string, PlaneUser>> {
  if (!k.members) {
    // Some versions wrap each user in a membership ({ member: {…}, role }).
    const list = await planeOk<(PlaneUser | { member: PlaneUser })[]>(k.c, ws(k, "/members/"));
    const users = (Array.isArray(list) ? list : []).map((m) => ("member" in m ? m.member : m));
    k.members = new Map(users.map((u) => [u.id, u]));
  }
  return k.members;
}

// ---------- Shaping ----------

const CATEGORY: Record<PlaneStateGroup, StatusCategory> = { triage: "triage", backlog: "backlog", unstarted: "todo", started: "doing", completed: "done", cancelled: "cancelled" };

/** A workflow state as a status; the project is its source (states belong to one project). */
export function statusOf(s: PlaneState, projectId: string): RemoteStatus {
  const category = CATEGORY[s.group];
  if (!category) throw new ProviderError("incompatible", `Plane: unknown state group "${s.group}"`);
  return {
    id: s.id,
    name: s.name,
    category,
    categoryOrigin: { by: "native" },
    source: { kind: "itemState", containerRemoteId: projectId },
    nativeReason: s.group,
    ...(s.color ? { color: s.color } : {}),
    ...(s.sequence != null ? { order: s.sequence } : {}),
  };
}

/** A self-hosted server may send an avatar as a path on its own site. */
const absolute = (web: string, url: string | null | undefined) => (url ? new URL(url, `${web}/`).toString() : null);

function person(web: string, u: PlaneUser): RemotePerson {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.display_name || u.email || u.id;
  return { remoteId: u.id, name, avatarUrl: absolute(web, u.avatar_url ?? u.avatar), ...(u.display_name ? { handle: u.display_name } : {}) };
}

/** A person as Plane gives one: the object, or only the uuid (then the workspace's members tell who). */
async function personOf(k: Ctx, u: PlaneUser | string | null | undefined): Promise<RemotePerson | null> {
  if (!u) return null;
  if (typeof u === "object") return person(k.web, u);
  const known = (await membersOf(k)).get(u);
  return known ? person(k.web, known) : { remoteId: u, name: u, avatarUrl: null };
}

/** urgent … low on the coarse 0–4 scale shared by every provider; "none" is no priority, not the lowest. */
const PRIORITIES: Record<string, { name: string; rank: number }> = { urgent: { name: "Urgent", rank: 0 }, high: { name: "High", rank: 1 }, medium: { name: "Medium", rank: 3 }, low: { name: "Low", rank: 4 } };

const plainDate = (d: string | null | undefined): LocalDate | null => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? localDate(d.slice(0, 10)) : null);

const keyOf = (p: PlaneProject, i: Pick<PlaneIssue, "sequence_id">) => `${p.identifier}-${i.sequence_id}`;
const urlOf = (k: Ctx, key: string) => `${k.web}/${k.c.workspace}/browse/${key}/`;
const containerOf = (p: PlaneProject) => ({ remoteId: p.id, key: p.identifier, name: p.name, kind: "project" as const });

async function shape(k: Ctx, i: PlaneIssue): Promise<RemoteIssue> {
  const p = await projectById(k, i.project);
  const stateId = typeof i.state === "string" ? i.state : i.state.id;
  const state = typeof i.state === "object" ? i.state : (await statesOf(k, i.project)).find((s) => s.id === stateId);
  if (!state) throw new ProviderError("incompatible", `Plane: state ${stateId} is not one of project ${p.identifier}'s`);
  const key = keyOf(p, i);
  const prio = i.priority ? PRIORITIES[i.priority] : undefined;
  const assignees = (await Promise.all(i.assignees.map((u) => personOf(k, u)))).filter((u): u is RemotePerson => u !== null);
  return {
    remoteId: i.id,
    key,
    url: urlOf(k, key),
    title: i.name,
    type: { id: "issue", name: "Work item", level: i.parent ? "sub" : "standard" },
    status: statusOf(state, p.id),
    container: containerOf(p),
    priority: prio && i.priority ? { id: i.priority, name: prio.name, rank: prio.rank } : null,
    // Labels come as objects with expand; bare uuids (a server that ignores expand) can't be named here.
    labels: i.labels.flatMap((l) => (typeof l === "object" ? [l.name] : [])),
    assignees,
    reporter: await personOf(k, i.created_by),
    due: plainDate(i.target_date),
    estimateSeconds: null,
    createdAt: instantFrom(i.created_at),
    updatedAt: instantFrom(i.updated_at),
    statusChangedAt: instantFrom(i.completed_at ?? null),
    ...(typeof i.estimate_point === "number" ? { fields: { estimatePoint: i.estimate_point } } : {}),
  };
}

// ---------- Finding an issue ----------

const issuePath = (projectId: string, id: string) => `/projects/${projectId}/work-items/${id}/`;
const expanded = (path: string) => withQuery(path, { expand: EXPAND });
const live = (i: PlaneIssue | undefined | null): PlaneIssue | null => (i && !i.deleted_at ? i : null);

type Where = { remoteId?: string; key?: string; container?: { remoteId: string } };

/**
 * An issue as it is now. The project hint with the uuid first; then the key
 * (PROJ-12, across the workspace), accepted only if it is the issue asked for
 * (an identifier freed by a rename may belong to another project now); a uuid
 * with no project is looked for in each project. Not there, deleted, or in a
 * project the user left: none (Plane answers 404 or 403 for the last two).
 */
async function locate(k: Ctx, w: Where): Promise<PlaneIssue | null> {
  const lookup = { missingIsNull: true, forbiddenIsNull: true } as const;
  if (w.remoteId && w.container?.remoteId) {
    const r = await plane<PlaneIssue>(k.c, ws(k, expanded(issuePath(w.container.remoteId, w.remoteId))), lookup);
    if (live(r?.data)) return r?.data ?? null;
  }
  const key = w.key ? normalizeKey(w.key) : null;
  if (key) {
    const r = await plane<PlaneIssue>(k.c, ws(k, expanded(`/work-items/${key}/`)), lookup);
    const i = live(r?.data);
    if (i && (!w.remoteId || i.id === w.remoteId)) return i;
  }
  if (w.remoteId && !w.container?.remoteId) {
    for (const p of (await projectsOf(k)).values()) {
      const r = await plane<PlaneIssue>(k.c, ws(k, expanded(issuePath(p.id, w.remoteId))), lookup);
      if (live(r?.data)) return r?.data ?? null;
    }
  }
  return null;
}

async function mustLocate(k: Ctx, ref: IssueRef): Promise<PlaneIssue> {
  const i = await locate(k, ref);
  if (!i) throw new ProviderError("notFound", `Plane: no work item ${ref.key}`);
  return i;
}

/** The project and uuid an operation on an issue calls: the ref's own when it carries them, else found. */
async function targetOf(k: Ctx, ref: IssueRef): Promise<{ project: string; id: string }> {
  if (ref.container?.remoteId && ref.remoteId) return { project: ref.container.remoteId, id: ref.remoteId };
  const i = await mustLocate(k, ref);
  return { project: i.project, id: i.id };
}

// ---------- Reading a pass ----------

const isMine = (k: Ctx, i: PlaneIssue) => i.assignees.some((a) => (typeof a === "string" ? a : a.id) === k.me);

/**
 * One page of the user's items: a page of one project's items, newest change
 * first (Plane filters none of this on its side as far as is known: the
 * assignment is checked here), then the next project. A project's reading stops
 * at the first page that ends before `stopBefore`. Drafts, archived and deleted
 * items are not the user's.
 */
async function walk(k: Ctx, w: Walk, stopBefore: number | null): Promise<{ issues: PlaneIssue[]; next: Walk | null }> {
  const projects = [...(await projectsOf(k)).values()].filter((p) => !p.archived_at).sort((a, b) => (a.id < b.id ? -1 : 1));
  // The project the pass was in may be gone meanwhile: go on with the next one.
  const here = w.p === null ? projects[0] : projects.find((p) => p.id >= (w.p ?? ""));
  if (!here) return { issues: [], next: null };
  const cursor = here.id === w.p ? w.c : null;
  const page = await planePage<PlaneIssue>(k.c, ws(k, withQuery(`/projects/${here.id}/work-items/`, { expand: EXPAND, order_by: "-updated_at" })), cursor, PER_PAGE);
  const updated = (i: PlaneIssue) => Date.parse(i.updated_at);
  const issues = page.results.filter((i) => isMine(k, i) && !i.deleted_at && !i.archived_at && !i.is_draft && (stopBefore === null || updated(i) >= stopBefore));
  const last = page.results.at(-1);
  const more = page.next !== null && !(stopBefore !== null && last && updated(last) < stopBefore);
  if (more) return { issues, next: { ...w, p: here.id, c: page.next } };
  const after = projects.find((p) => p.id > here.id);
  return { issues, next: after ? { ...w, p: after.id, c: null } : null };
}

// ---------- Texts ----------

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown the service won't show as written: it gets the text, as paragraphs, until the RichText layer converts it. */
const MARKS: [ConversionWarning["feature"], RegExp][] = [
  ["strong", /\*\*[^*]+\*\*/],
  ["emphasis", /(^|[^*])\*[^*\s][^*]*\*/],
  ["code", /`[^`]+`/],
  ["codeBlock", /^```/m],
  ["link", /\[[^\]]+\]\([^)]+\)/],
  ["heading", /^#{1,6} /m],
  ["list", /^\s*([-*+]|\d+\.) /m],
  ["quote", /^> /m],
  ["table", /^\|.*\|$/m],
  ["image", /!\[[^\]]*\]\([^)]+\)/],
];
const warningsFor = (md: string): ConversionWarning[] => MARKS.filter(([, re]) => re.test(md)).map(([feature]) => ({ code: "approximated" as const, feature, serverDetail: `markdown ${feature} sent to Plane as plain paragraphs` }));
const paragraphs = (md: string) =>
  md
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");

/** "<p></p>" is what an item with no description has. */
const hasContent = (html: string | null | undefined): html is string => !!html && (/<(img|hr|video|iframe|table)\b/i.test(html) || html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() !== "");

async function toRemoteComment(k: Ctx, c: PlaneComment): Promise<RemoteComment> {
  return {
    id: c.id,
    author: (await personOf(k, c.actor)) ?? { remoteId: "", name: "", avatarUrl: null },
    body: { kind: "text", format: "html", text: c.comment_html ?? "" },
    createdAt: instantFrom(c.created_at),
    updatedAt: instantFrom(c.updated_at),
  };
}

// ---------- History ----------

const FIELD_NAMES: Record<string, string> = { name: "Title", state: "State", priority: "Priority", assignees: "Assignees", labels: "Labels", target_date: "Due date", start_date: "Start date", description: "Description", parent: "Parent", estimate_point: "Estimate" };
const fieldName = (f: string) => FIELD_NAMES[f] ?? f.charAt(0).toUpperCase() + f.slice(1).replace(/_/g, " ");

// ---------- Time ----------

/** The entry's day: the one Plane gives, else the day it was created in the user's zone (created_at is UTC). */
function dayOf(k: Ctx, w: PlaneWorklog): LocalDate {
  return plainDate(w.logged_at) ?? localDateOf(instantFrom(w.created_at) ?? instant(0), k.zone);
}

function toRemoteWorklog(k: Ctx, w: PlaneWorklog, issue: IssueHandle): RemoteWorklog {
  return {
    remoteId: w.id,
    issue,
    // Whole minutes, as Plane keeps them.
    span: { kind: "date", date: dayOf(k, w), seconds: Math.round(w.duration) * 60 },
    comment: w.description ?? "",
    authorRemoteId: w.logged_by,
    createdAt: instantFrom(w.created_at),
    updatedAt: instantFrom(w.updated_at),
    // No update, no delete until Plane's worklogs are shown to have them (plane-worklogs).
    editable: { update: false, delete: false },
  };
}

const handleOf = (ref: IssueRef): IssueHandle => ({ remoteId: ref.remoteId, key: ref.key, ...(ref.container ? { container: ref.container } : {}) });

// ---------- Webhooks ----------

/**
 * Plane's webhooks: `X-Plane-Signature` is the hex HMAC-SHA256 of the raw body
 * under the webhook's secret key, `X-Plane-Delivery` the delivery's own id and
 * `X-Plane-Event` what it is about (issue, issue_comment…); the body says what
 * was done (`action`: create, update, delete). No timestamp is documented:
 * nothing is refused as stale.
 */
export const planeWebhook = {
  verify(headers: Record<string, string>, body: string, secret: string): boolean {
    const sent = headers["x-plane-signature"];
    // A hook with no secret key is open to anyone: never accepted.
    return secret.length > 0 && !!sent && /^[0-9a-f]{64}$/i.test(sent) && sameSecret(sent.toLowerCase(), hmacHex(secret, body));
  },
  deliveryId: (headers: Record<string, string>): string | null => headers["x-plane-delivery"] ?? null,
  /** Which of the declared events it is; null for the ones inkledger doesn't read (projects, cycles, modules). */
  event(headers: Record<string, string>, body: string): "issueChanged" | "issueRemoved" | "commentAdded" | null {
    let action: unknown;
    try {
      action = (JSON.parse(body) as { action?: unknown }).action;
    } catch {
      return null;
    }
    const what = headers["x-plane-event"];
    if (what === "issue") return action === "delete" || action === "deleted" ? "issueRemoved" : "issueChanged";
    if (what === "issue_comment") return "commentAdded";
    return null;
  },
};

// ---------- The adapter ----------

export const planeProvider: TrackerProvider<"plane", PlaneOptions> = {
  webhook: {
    verify: (req, secret) => planeWebhook.verify(req.headers, req.body, secret),
    deliveryId: (req) => planeWebhook.deliveryId(req.headers),
  },
  role: "tracker",
  type: "plane",
  capabilities: planeCapabilities,
  traits: planeTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Plane options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text): IssueHandle | null {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      const url = new URL(text.trim());
      const { root, workspace } = addressOf(r.baseUrl, r.options.workspace);
      const web = new URL(webBaseOf(root));
      if (url.origin !== web.origin) return null;
      const prefix = web.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith(`${prefix}/`)) return null;
      const path = url.pathname.slice(prefix.length);
      // /<workspace>/browse/PROJ-12/ (and older links: /<workspace>/projects/<uuid>/issues/<uuid>)
      const m = /^\/([^/]+)\/(?:browse\/([^/]+)|projects\/([0-9a-f-]{36})\/(?:issues|work-items)\/([0-9a-f-]{36}))\/?$/i.exec(path);
      if (!m || (workspace && m[1].toLowerCase() !== workspace.toLowerCase())) return null;
      if (m[2]) {
        const k = normalizeKey(m[2]);
        return k ? { key: k } : null;
      }
      return { remoteId: m[4], container: { remoteId: m[3], key: "" } };
    } catch {
      return null;
    }
  },

  async verify(x) {
    const k = await ctxOf(x);
    const me = await planeOk<PlaneUser>(k.c, "/users/me/");
    return { ...person(k.web, me), ...(me.display_name ? { login: me.display_name } : {}), ...(me.email ? { email: me.email } : {}) };
  },

  async probe(x) {
    const k = await ctxOf(x);
    // Listing the projects also proves the workspace slug and the token's reach.
    const projects = [...(await projectsOf(k)).values()].filter((p) => !p.archived_at);
    const sources: ActiveWorkflowSource[] = projects.length
      ? projects.map((p) => ({ kind: "itemState", transitions: "direct", ref: { kind: "itemState", containerRemoteId: p.id }, name: p.name }))
      : [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Plane workflow" }];
    // Documented: 60 requests a minute per API key.
    return { capabilities: planeCapabilities, activeSources: sources, rateLimit: { perHour: 3600, origin: "typical" }, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const k = await ctxOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const w = decodePageToken<Walk>(x.conn, "issues", V, q.since, q.page) ?? { p: null, c: null, at: Date.now() };
    const { issues, next } = await walk(k, w, since);
    const items: RemoteIssue[] = [];
    for (const i of issues) items.push(await shape(k, i));
    if (next) return { last: false, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, next satisfies Walk) };
    return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: w.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const k = await ctxOf(x);
    const i = await locate(k, ref);
    return i ? shape(k, i) : null;
  },

  async findIssue(x, handle) {
    const k = await ctxOf(x);
    const i = await locate(k, handle);
    // An identifier is unique in a workspace: never ambiguous.
    return i ? { kind: "found", issue: await shape(k, i) } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    const k = await ctxOf(x);
    const r = await planeOk<{ issues?: PlaneSearchHit[]; results?: PlaneSearchHit[] }>(k.c, ws(k, withQuery("/work-items/search/", { search: text.trim() })));
    const hits = r.issues ?? r.results ?? [];
    const items: RemoteIssue[] = [];
    // The hits are bare (name and key): each is read whole.
    for (const h of hits.slice(0, limit)) {
      const full = await plane<PlaneIssue>(k.c, ws(k, expanded(issuePath(h.project_id, h.id))), { missingIsNull: true, forbiddenIsNull: true });
      const i = live(full?.data);
      if (i) items.push(await shape(k, i));
    }
    return { items, complete: hits.length <= limit };
  },

  async statuses(x, source) {
    const k = await ctxOf(x);
    const project = source.ref.kind === "itemState" ? source.ref.containerRemoteId : undefined;
    if (project) return (await statesOf(k, project)).map((s) => statusOf(s, project));
    const out: RemoteStatus[] = [];
    for (const p of (await projectsOf(k)).values()) if (!p.archived_at) out.push(...(await statesOf(k, p.id)).map((s) => statusOf(s, p.id)));
    return out;
  },

  async description(x, ref) {
    const k = await ctxOf(x);
    const i = await locate(k, ref);
    return i && hasContent(i.description_html) ? { kind: "text", format: "html", text: i.description_html } : null;
  },

  transitions: {
    async list(x, ref) {
      const k = await ctxOf(x);
      const i = await mustLocate(k, ref);
      const p = await projectById(k, i.project);
      const now = typeof i.state === "object" ? i.state.id : i.state;
      // Any state of the project, from any state. Intake (triage) is not one to move an item into.
      return (await statesOf(k, i.project))
        .filter((s) => s.id !== now && s.group !== "triage")
        .map<Transition>((s) => ({ id: s.id, name: s.name, to: statusOf(s, p.id), requirements: [], remoteUrl: urlOf(k, keyOf(p, i)) }));
    },
    async apply(x, ref, transitionId) {
      const k = await ctxOf(x);
      const i = await mustLocate(k, ref);
      const state = (await statesOf(k, i.project)).find((s) => s.id === transitionId && s.group !== "triage");
      if (!state) throw new ProviderError("invalid", `Plane: no state ${transitionId} in this project`);
      await planeOk(k.c, ws(k, issuePath(i.project, i.id)), { method: "PATCH", body: JSON.stringify({ state: state.id }) });
      // A change answers with uuids instead of objects: the item is read again, as it now is.
      const after = await planeOk<PlaneIssue>(k.c, ws(k, expanded(issuePath(i.project, i.id))));
      return shape(k, after);
    },
  },

  worklogs: {
    async list(x, ref) {
      const k = await ctxOf(x);
      const t = await targetOf(k, ref);
      const logs = await planeAll<PlaneWorklog>(k.c, ws(k, `${issuePath(t.project, t.id)}worklogs/`));
      return logs.map((w) => toRemoteWorklog(k, w, handleOf(ref)));
    },

    /**
     * The user's own entries of the last days, by their day. Plane has no
     * list of a person's time, so the issues they hold that changed within the
     * window are read (newest change first: a project's reading stops at the
     * first page that ends before it), each with its worklogs.
     */
    async changed(x, q) {
      const k = await ctxOf(x);
      // Only validated: a window is always read whole.
      decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since);
      const w = decodePageToken<Walk>(x.conn, "worklogs", V, q.since, q.page) ?? { p: null, c: null, at: Date.now() };
      const from = localDateOf(instant(w.at - (WINDOW_DAYS + OVERLAP_DAYS) * DAY_MS), k.zone);
      // A day wider than the window at its edge: the zone of the stamps is not the user's.
      const { issues, next } = await walk(k, w, w.at - (WINDOW_DAYS + OVERLAP_DAYS + 1) * DAY_MS);
      const items: RemoteWorklog[] = [];
      for (const i of issues) {
        const p = await projectById(k, i.project);
        const handle: IssueHandle = { remoteId: i.id, key: keyOf(p, i), container: { remoteId: p.id, key: p.identifier } };
        for (const log of await planeAll<PlaneWorklog>(k.c, ws(k, `${issuePath(i.project, i.id)}worklogs/`))) {
          if (log.logged_by === k.me && dayOf(k, log) >= from) items.push(toRemoteWorklog(k, log, handle));
        }
      }
      if (next) return { last: false, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, next satisfies Walk) };
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: w.at } satisfies Since) };
    },

    async create(x, ref, w) {
      const k = await ctxOf(x);
      if (w.time.kind !== "date") throw new ProviderError("invalid", "Plane keeps time on days, not sessions");
      const t = await targetOf(k, ref);
      // Whole minutes (at least one: a short entry is not lost).
      const duration = Math.max(1, Math.round(w.time.seconds / 60));
      const made = await planeOk<PlaneWorklog>(k.c, ws(k, `${issuePath(t.project, t.id)}worklogs/`), {
        method: "POST",
        body: JSON.stringify({ duration, logged_at: w.time.date, ...(w.comment ? { description: w.comment } : {}) }),
      });
      return toRemoteWorklog(k, made, handleOf(ref));
    },
  },

  comments: {
    async list(x, ref) {
      const k = await ctxOf(x);
      const t = await targetOf(k, ref);
      const list = await planeAll<PlaneComment>(k.c, ws(k, `${issuePath(t.project, t.id)}comments/`));
      return Promise.all(list.map((c) => toRemoteComment(k, c)));
    },
    async add(x, ref, body) {
      const k = await ctxOf(x);
      const t = await targetOf(k, ref);
      const made = await planeOk<PlaneComment>(k.c, ws(k, `${issuePath(t.project, t.id)}comments/`), { method: "POST", body: JSON.stringify({ comment_html: paragraphs(body) }) });
      return { comment: await toRemoteComment(k, made), warnings: warningsFor(body) };
    },
  },

  async history(x, ref) {
    const k = await ctxOf(x);
    const t = await targetOf(k, ref);
    const list = await planeAll<PlaneActivity>(k.c, ws(k, `${issuePath(t.project, t.id)}activities/`));
    const some = (text: string | null | undefined, id?: string | null) => (text ? [{ text, ...(id ? { id } : {}) }] : []);
    const changes: RemoteChange[] = [];
    for (const a of list) {
      const at = instantFrom(a.created_at) ?? instant(0);
      const actor = await personOf(k, a.actor);
      if (!a.field) {
        if (a.verb === "created") changes.push({ at, actor, field: { name: "Work item" }, from: [], to: [{ text: "created" }] });
        continue;
      }
      // Lists (assignees, labels) record each addition as "created" and each removal as "deleted".
      const from = a.verb === "created" ? [] : some(a.old_value, a.old_identifier);
      const to = a.verb === "deleted" ? [] : some(a.new_value, a.new_identifier);
      changes.push({ at, actor, field: { id: a.field, name: fieldName(a.field) }, from, to });
    }
    return changes.sort((a, b) => a.at - b.at);
  },
};
