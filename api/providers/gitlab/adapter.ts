// GitLab (gitlab.com and self-managed) as a tracker, through the provider
// contract. Issues assigned to the user, keyed group/subgroup/project#12 (the
// number is the project's own `iid`; the id behind remoteId is the instance's);
// their status is the service's own opened/closed, and optionally one scoped
// label set (workflow::doing) the connection's options give categories to.
// Time two ways, by what the server has: timelogs through GraphQL (14+ reads,
// 15+ writes), else /spend notes and the system notes they leave (legacyTime.ts).
// Built on a simulator, not verified on a real account: docs/dev/spikes.md.
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, type Instant } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import {
  mappingId,
  mappingVersion,
  type ActiveWorkflowSource,
  type CallContext,
  type IssueRef,
  type RemoteChange,
  type RemoteComment,
  type RemoteIssue,
  type RemotePerson,
  type RemoteStatus,
  type RemoteWorklog,
  type Transition,
  type TrackerProvider,
} from "../types";
import {
  gidOf,
  gl,
  glOk,
  glPages,
  gql,
  idOfGid,
  ISSUE_BY_ID,
  ISSUE_TIMELOGS,
  USER_TIMELOGS,
  webBaseOf,
  apiRootOf,
  type GitLabCreds,
  type GitLabIssue,
  type GitLabLabelEvent,
  type GitLabMilestoneEvent,
  type GitLabNote,
  type GitLabStateEvent,
  type GitLabTimelog,
  type GitLabUser,
  type TimelogPage,
  TIMELOG_CREATE,
  TIMELOG_DELETE,
} from "./client";
import { createByNote, deleteByNote, forgetTimeMode, isNoteEntry, listByNotes, timeModeOf } from "./legacyTime";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

// The catalogue's entry for gitlab, here where the adapter keeps to it (the
// registry holds the two together).
export const gitlabCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["glfm"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: true,
  history: true,
  // Open/closed and scoped labels; Premium work item statuses (verify: gitlab-statuses) only once shown
  workflow: { sources: [{ kind: "boolean", transitions: "direct", reasons: false }, { kind: "labelSet", transitions: "direct" }] },
  // timelogs: no update (delete and log again), no future dates; feed by re-reading a window.
  // timelogCreate with spentAt on 15+, a /spend note with its day before (verify: gitlab-timelog).
  // A moved issue keeps moved_to_id: a transfer with its successor.
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "session",
      write: { mode: "entry", update: "recreate", delete: true },
      feed: { kind: "window", by: "entryDate", days: 30, overlapDays: 2 },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
      activities: { read: false, write: false, required: "no" },
      onBehalf: { read: false, write: false },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "none",
      limits: { noFuture: true },
    },
  },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "withSuccessor" },
    // Signals until a payload is shown to hold all the adapter needs (spikes: webhook payloads).
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const gitlabTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: true,
  devLinks: true,
  attachments: { read: true, upload: true },
  timeboxes: ["milestone", "iteration"],
  fields: ["due", "start", "estimate", "points", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({
  /**
   * The scoped label set that carries the workflow (`workflow` for workflow::doing)
   * with the category of each of its values. GitLab doesn't say what a label means:
   * never inferred from a name, so only the values listed here are statuses.
   */
  workflow: z
    .strictObject({
      scope: z.string().min(1).max(100).refine((s) => !s.includes("::"), "a scope has no ::"),
      categories: z.record(z.string().min(1).max(100), z.enum(STATUS_CATEGORIES)),
    })
    .nullable()
    .default(null),
});
export type GitLabOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"gitlab", GitLabOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
type IssuePage = { page: number; at: number };
type TimelogPageAt = { after: string | null; from: string; to: string; username: string; at: number };

/** Overlap read again at each pass: updates may land after the clock that stamps them. */
const OVERLAP_MS = 60_000;
const PER_PAGE = 50;
const DAY_MS = 86_400_000;
/** The feed window the capabilities declare. */
const WINDOW_DAYS = 30;

async function credsOf(x: X): Promise<GitLabCreds> {
  const cred = await x.conn.credential();
  const token = cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password;
  return { apiBase: apiRootOf(x.conn.baseUrl), token };
}

/** What turning an issue into the layer's shape needs of its connection. */
type Shape = { connId: number; webBase: string; workflow: GitLabOptions["workflow"] };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, webBase: webBaseOf(x.conn.baseUrl), workflow: x.conn.options.workflow });

// ---------- Keys and links ----------

/** group/subgroup/project#12, as GitLab writes a full reference. */
export const ISSUE_KEY = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)#(\d{1,9})$/;
const normalizeKey = (raw: string) => (ISSUE_KEY.test(raw.trim()) ? raw.trim() : null);
const iidOf = (key: string) => {
  const m = ISSUE_KEY.exec(key);
  return m ? Number(m[2]) : null;
};
const pathOf = (key: string) => ISSUE_KEY.exec(key)?.[1] ?? null;

// ---------- Statuses ----------

const OPENED: RemoteStatus = { id: "opened", name: "Open", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };
const CLOSED: RemoteStatus = { id: "closed", name: "Closed", category: "done", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };

/** "workflow::doing" is scope "workflow", value "doing" (the scope is all but the last ::). */
function scoped(label: string): { scope: string; value: string } | null {
  const at = label.lastIndexOf("::");
  return at > 0 && at < label.length - 2 ? { scope: label.slice(0, at), value: label.slice(at + 2) } : null;
}

const sameScope = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
function labelStatus(s: Shape, scope: string, value: string, category: StatusCategory): RemoteStatus {
  return { id: value, name: value, category, categoryOrigin: { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) }, source: { kind: "labelSet", scope } };
}

/** Closed is closed; open takes the one status label of the configured set, else plain Open (several is no answer). */
function statusOf(s: Shape, i: Pick<GitLabIssue, "state" | "labels">): RemoteStatus {
  if (i.state === "closed") return CLOSED;
  const wf = s.workflow;
  if (wf) {
    const hits = i.labels.flatMap((l) => {
      const p = scoped(l);
      return p && sameScope(p.scope, wf.scope) && p.value in wf.categories ? [p] : [];
    });
    if (hits.length === 1) return labelStatus(s, wf.scope, hits[0].value, wf.categories[hits[0].value]);
  }
  return OPENED;
}

// ---------- Shaping ----------

/** Self-managed GitLab may send an avatar as a path on its own site. */
const absolute = (web: string, url: string | null | undefined) => (url ? new URL(url, `${web}/`).toString() : null);

function person(web: string, u: GitLabUser): RemotePerson {
  return { remoteId: String(u.id), name: u.name || u.username, avatarUrl: absolute(web, u.avatar_url), handle: u.username };
}

const projectPathOf = (i: GitLabIssue) => i.references.full.slice(0, i.references.full.lastIndexOf("#"));

export function toRemoteIssue(s: Shape, i: GitLabIssue): RemoteIssue {
  const path = projectPathOf(i);
  const task = i.issue_type === "task";
  const type = i.issue_type ?? "issue";
  return {
    remoteId: String(i.id),
    key: i.references.full,
    url: i.web_url,
    title: i.title,
    type: { id: type, name: type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " "), level: task ? "sub" : "standard" },
    status: statusOf(s, i),
    // The project by its id: stable when it is renamed or moved to another group (the path is the key).
    container: { remoteId: String(i.project_id), key: path, name: path.slice(path.lastIndexOf("/") + 1), kind: "project" },
    priority: null,
    labels: i.labels,
    assignees: (i.assignees ?? []).map((u) => person(s.webBase, u)),
    reporter: i.author ? person(s.webBase, i.author) : null,
    due: i.due_date ? localDate(i.due_date) : null,
    estimateSeconds: i.time_stats?.time_estimate ? i.time_stats.time_estimate : null,
    spentSeconds: i.time_stats?.total_time_spent ?? null,
    createdAt: instantFrom(i.created_at),
    updatedAt: instantFrom(i.updated_at),
    statusChangedAt: instantFrom(i.closed_at ?? null),
  };
}

const refOf = (i: GitLabIssue): IssueRef => ({ remoteId: String(i.id), key: i.references.full, container: { remoteId: String(i.project_id), key: projectPathOf(i) } });

// ---------- Finding an issue ----------

const projectIssue = (project: string, iid: number) => `/projects/${encodeURIComponent(project)}/issues/${iid}`;

async function byProjectIid(c: GitLabCreds, project: string, iid: number): Promise<GitLabIssue | null> {
  return (await gl<GitLabIssue>(c, projectIssue(project, iid), { missingIsNull: true }))?.data ?? null;
}

/** The project and number behind an instance-wide id: GitLab's REST has this for administrators only, GraphQL for everyone. */
async function byGlobalId(c: GitLabCreds, id: string): Promise<GitLabIssue | null> {
  const r = await gql<{ issue: { iid: string; project: { id: string } } | null }>(c, "IssueById", ISSUE_BY_ID, { id: gidOf("Issue", id) });
  return r.issue ? byProjectIid(c, idOfGid(r.issue.project.id), Number(r.issue.iid)) : null;
}

type Where = { remoteId?: string; key?: string; container?: { remoteId: string } };

/**
 * An issue as it is now. The project id (hint) first, then the key's path, each
 * accepted only if it is the issue asked for (a path freed by a rename may belong
 * to another project now); then the instance-wide id, which survives a move.
 */
async function locate(c: GitLabCreds, w: Where): Promise<GitLabIssue | null> {
  const iid = w.key ? iidOf(w.key) : null;
  if (iid !== null && w.key) {
    const path = pathOf(w.key);
    for (const project of new Set([w.container?.remoteId, path].filter((p): p is string => !!p))) {
      const i = await byProjectIid(c, project, iid);
      if (i && (!w.remoteId || String(i.id) === w.remoteId)) return i;
    }
  }
  return w.remoteId ? byGlobalId(c, w.remoteId) : null;
}

async function mustLocate(c: GitLabCreds, ref: IssueRef): Promise<GitLabIssue> {
  const i = await locate(c, ref);
  if (!i) throw new ProviderError("notFound", `GitLab: no issue ${ref.key}`);
  return i;
}

const issueUrl = (i: GitLabIssue) => projectIssue(String(i.project_id), i.iid);

// ---------- Search ----------

async function search(x: X, text: string, limit: number) {
  const c = await credsOf(x);
  const per = Math.min(100, limit + 1);
  // Only the user's own: assigned to or created by them (scope=all would be every public issue of the instance).
  const lists = await Promise.all(
    (["assigned_to_me", "created_by_me"] as const).map((scope) =>
      glOk<GitLabIssue[]>(c, `/issues?${new URLSearchParams({ scope, state: "all", search: text, in: "title,description", order_by: "updated_at", sort: "desc", per_page: String(per) }).toString()}`),
    ),
  );
  const byId = new Map(lists.flat().map((i) => [i.id, i]));
  const all = [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const shape = shapeOf(x);
  return { items: all.slice(0, limit).map((i) => toRemoteIssue(shape, i)), complete: all.length <= limit && lists.every((l) => l.length < per) };
}

// ---------- Time ----------

function toRemoteWorklog(t: GitLabTimelog): RemoteWorklog {
  return {
    remoteId: idOfGid(t.id),
    issue: t.issue
      ? { remoteId: idOfGid(t.issue.id), key: `${t.issue.project.fullPath}#${t.issue.iid}`, container: { remoteId: idOfGid(t.issue.project.id), key: t.issue.project.fullPath } }
      : null,
    span: { kind: "session", start: instantFrom(t.spentAt) ?? instant(0), seconds: t.timeSpent },
    comment: t.summary ?? "",
    authorRemoteId: idOfGid(t.user.id),
    createdAt: null,
    updatedAt: null,
    editable: { update: false, delete: true },
  };
}

/** The UTC day an instant falls on (GraphQL's startDate/endDate snap to UTC days, not the user's). */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A call that only a newer server answers: one that answers it isn't there reads the server's schema again next time. */
async function modern<T>(c: GitLabCreds, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ProviderError && /doesn't exist on type/.test(e.message)) forgetTimeMode(c);
    throw e;
  }
}

// ---------- Quick actions ----------

/**
 * A line starting with / is a quick action in a GitLab note (/close, /assign,
 * /spend): typed in a comment it would run, and a note of only those isn't
 * created. A backslash keeps it text; fenced code is left alone.
 */
export function withoutQuickActions(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : line.replace(/^(\s*)\/([A-Za-z])/, "$1\\/$2");
    })
    .join("\n");
}

const toRemoteComment = (web: string, n: GitLabNote): RemoteComment => ({
  id: String(n.id),
  author: person(web, n.author),
  body: { kind: "text", format: "glfm", text: n.body },
  createdAt: instantFrom(n.created_at),
  updatedAt: instantFrom(n.updated_at),
});

// ---------- Webhooks ----------

type Headers2 = { get(name: string): string | null };
const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * GitLab's webhooks (the provider contract has no webhook operation yet: the
 * receiving route calls these). The secret token is sent as is in X-Gitlab-Token
 * (GitLab signs nothing), so it is compared in constant time.
 */
export const gitlabWebhook = {
  verify(headers: Headers2, secret: string): boolean {
    const sent = headers.get("x-gitlab-token");
    return secret.length > 0 && sent !== null && timingSafeEqual(digest(sent), digest(secret));
  },
  /** A delivery's own id (X-Gitlab-Event-UUID; Idempotency-Key on versions that have no UUID header): retries repeat it. */
  deliveryId(headers: Headers2): string | null {
    return headers.get("x-gitlab-event-uuid") ?? headers.get("idempotency-key");
  },
  /** When the change happened, from the payload: "2026-10-21 10:00:00 UTC" on older versions, ISO on newer. */
  sentAt(body: unknown): Instant | null {
    const at = (body as { object_attributes?: { updated_at?: unknown } } | null)?.object_attributes?.updated_at;
    return typeof at === "string" ? instantFrom(at.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) UTC$/, "$1T$2Z").replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})$/, "$1T$2$3")) : null;
  },
  /** Which of the declared events it is; null for hooks inkledger doesn't read (merge requests, pushes, notes on other things). */
  event(headers: Headers2, body: unknown): "issueChanged" | "commentAdded" | null {
    const name = headers.get("x-gitlab-event");
    if (name === "Issue Hook" || name === "Confidential Issue Hook") return "issueChanged";
    const noteable = (body as { object_attributes?: { noteable_type?: unknown } } | null)?.object_attributes?.noteable_type;
    return (name === "Note Hook" || name === "Confidential Note Hook") && noteable === "Issue" ? "commentAdded" : null;
  },
};

// ---------- The adapter ----------

export const gitlabProvider: TrackerProvider<"gitlab", GitLabOptions> = {
  // Deliveries carry the connection's secret in X-Gitlab-Token (its change time is not the delivery's: no staleness check).
  webhook: {
    verify: (req, secret) => gitlabWebhook.verify(new Headers(req.headers), secret),
    deliveryId: (req) => gitlabWebhook.deliveryId(new Headers(req.headers)),
  },
  role: "tracker",
  type: "gitlab",
  capabilities: gitlabCapabilities,
  traits: gitlabTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `GitLab options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text) {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      const url = new URL(text.trim());
      const web = new URL(webBaseOf(r.baseUrl));
      if (url.origin !== web.origin) return null;
      const prefix = web.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith(`${prefix}/`)) return null;
      // …/group/sub/project/-/issues/12 (or /-/work_items/12; the old form has no /-/)
      const m = /^\/(.+?)\/(?:-\/)?(?:issues|work_items)\/(\d+)\/?$/.exec(url.pathname.slice(prefix.length));
      return m ? ((k) => (k ? { key: k } : null))(normalizeKey(`${m[1]}#${m[2]}`)) : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await glOk<GitLabUser>(await credsOf(x), "/user");
    return { ...person(webBaseOf(x.conn.baseUrl), me), login: me.username, ...(me.email ? { email: me.email } : {}) };
  },

  async probe(x) {
    const r = await gl<GitLabUser>(await credsOf(x), "/user");
    // gitlab.com sends RateLimit-Limit per minute; self-managed may send none (gitlab-rate-headers).
    const perMinute = Number(r?.headers.get("ratelimit-limit"));
    const wf = x.conn.options.workflow;
    const sources: ActiveWorkflowSource[] = [
      { kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / closed" },
      ...(wf ? [{ kind: "labelSet" as const, transitions: "direct" as const, ref: { kind: "labelSet" as const, scope: wf.scope }, name: `${wf.scope}::*` }] : []),
    ];
    return {
      capabilities: gitlabCapabilities,
      activeSources: sources,
      ...(perMinute > 0 ? { rateLimit: { perHour: Math.round(perMinute * 60), origin: "detected" as const } } : {}),
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const shape = shapeOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const at = decodePageToken<IssuePage>(x.conn, "issues", V, q.since, q.page) ?? { page: 1, at: Date.now() };
    // scope defaults to created_by_me, state to all, per_page tops out at 100.
    const params = new URLSearchParams({ scope: "assigned_to_me", state: "all", order_by: "updated_at", sort: "asc", per_page: String(PER_PAGE), page: String(at.page) });
    if (since !== null) params.set("updated_after", new Date(since).toISOString());
    const r = await gl<GitLabIssue[]>(c, `/issues?${params.toString()}`);
    const items: RemoteIssue[] = [];
    const gone: { remoteId: string; reason: "transferred"; successor: IssueRef }[] = [];
    for (const i of r?.data ?? []) {
      // A moved issue stays here, closed, pointing at its successor.
      const successor = i.moved_to_id ? await byGlobalId(c, String(i.moved_to_id)) : null;
      if (successor) gone.push({ remoteId: String(i.id), reason: "transferred", successor: refOf(successor) });
      else items.push(toRemoteIssue(shape, i));
    }
    // The Link header says whether there is more (GitLab omits totals past 10,000 rows, never the next link).
    if (r?.next) return { last: false, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, { page: at.page + 1, at: at.at } satisfies IssuePage) };
    return { last: true, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const i = await locate(await credsOf(x), ref);
    return i ? toRemoteIssue(shapeOf(x), i) : null;
  },

  async findIssue(x, handle) {
    const i = await locate(await credsOf(x), handle);
    // A path is unique on an instance: never ambiguous.
    return i ? { kind: "found", issue: toRemoteIssue(shapeOf(x), i) } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    return search(x, text, limit);
  },

  async statuses(x, source) {
    const s = shapeOf(x);
    if (source.kind === "boolean") return [OPENED, CLOSED];
    const wf = s.workflow;
    if (source.kind !== "labelSet" || !wf || !sameScope(source.ref.scope, wf.scope)) return [];
    return Object.entries(wf.categories).map(([value, category], order) => ({ ...labelStatus(s, wf.scope, value, category), order }));
  },

  async description(x, ref) {
    const i = await locate(await credsOf(x), ref);
    return i?.description ? { kind: "text", format: "glfm", text: i.description } : null;
  },

  transitions: {
    async list(x, ref) {
      const i = await mustLocate(await credsOf(x), ref);
      const s = shapeOf(x);
      const now = statusOf(s, i);
      const common = { requirements: [], remoteUrl: i.web_url };
      if (i.state === "closed") return [{ id: "reopen", name: "Reopen", to: statusOf(s, { ...i, state: "opened" }), ...common }] satisfies Transition[];
      const wf = s.workflow;
      const labels = Object.entries(wf?.categories ?? {})
        .filter(([value]) => !(now.source.kind === "labelSet" && now.id === value))
        .map(([value, category]): Transition => ({ id: `label:${value}`, name: `Move to ${value}`, to: labelStatus(s, wf?.scope ?? "", value, category), ...common }));
      return [...labels, { id: "close", name: "Close", to: CLOSED, ...common }];
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const i = await mustLocate(c, ref);
      const wf = x.conn.options.workflow;
      let body: Record<string, string>;
      if (transitionId === "close") body = { state_event: "close" };
      else if (transitionId === "reopen") body = { state_event: "reopen" };
      else if (wf && transitionId.startsWith("label:") && transitionId.slice(6) in wf.categories) {
        const value = transitionId.slice(6);
        // GitLab keeps one label per scope when one is added; the old one is removed explicitly as well.
        const old = i.labels.filter((l) => {
          const p = scoped(l);
          return p && sameScope(p.scope, wf.scope) && p.value !== value;
        });
        body = { add_labels: `${wf.scope}::${value}`, ...(old.length ? { remove_labels: old.join(",") } : {}) };
      } else throw new ProviderError("invalid", `GitLab: no transition ${transitionId}`);
      const updated = await glOk<GitLabIssue>(c, issueUrl(i), { method: "PUT", body: JSON.stringify(body) });
      return toRemoteIssue(shapeOf(x), updated);
    },
  },

  worklogs: {
    async list(x, ref) {
      const c = await credsOf(x);
      if (!(await timeModeOf(c)).readTimelogs) {
        const i = await locate(c, ref);
        return i ? listByNotes(c, i) : [];
      }
      const out: RemoteWorklog[] = [];
      let after: string | null = null;
      for (let n = 0; n < 50; n++) {
        const r: { issue: { timelogs: TimelogPage } | null } = await modern(c, () => gql(c, "IssueTimelogs", ISSUE_TIMELOGS, { id: gidOf("Issue", ref.remoteId), after }));
        if (!r.issue) return out;
        out.push(...r.issue.timelogs.nodes.map(toRemoteWorklog));
        if (!r.issue.timelogs.pageInfo.hasNextPage) break;
        after = r.issue.timelogs.pageInfo.endCursor;
      }
      return out;
    },
    async changed(x, q) {
      const c = await credsOf(x);
      // Only validated: a window is always read whole (an entry can be dated before it was logged).
      decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since);
      if (!(await timeModeOf(c)).readTimelogs) {
        // No timelogs to ask for: the notes of the user's issues touched in the window (logging time touches its issue).
        const now = Date.now();
        const since = new Date(now - (WINDOW_DAYS + 1) * DAY_MS).toISOString();
        const lists = await Promise.all(
          (["assigned_to_me", "created_by_me"] as const).map((scope) => glPages<GitLabIssue>(c, `/issues?${new URLSearchParams({ scope, state: "all", updated_after: since, order_by: "updated_at", sort: "desc" }).toString()}`, 5)),
        );
        const issues = [...new Map(lists.flat().map((i) => [i.id, i])).values()];
        const items = (await Promise.all(issues.map((i) => listByNotes(c, i)))).flat();
        return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: now } satisfies Since) };
      }
      const pageAt =
        decodePageToken<TimelogPageAt>(x.conn, "worklogs", V, q.since, q.page) ??
        ((now: number): TimelogPageAt => ({
          after: null,
          // Whole UTC days, a day wider at both ends than the window: startDate and endDate are days in UTC, not the user's.
          from: utcDay(now - (WINDOW_DAYS + 1) * DAY_MS),
          to: utcDay(now + DAY_MS),
          username: "",
          at: now,
        }))(Date.now());
      const username = pageAt.username || (await glOk<GitLabUser>(c, "/user")).username;
      const r = await modern(c, () => gql<{ timelogs: TimelogPage }>(c, "UserTimelogs", USER_TIMELOGS, { username, startDate: pageAt.from, endDate: pageAt.to, after: pageAt.after }));
      const items = r.timelogs.nodes.map(toRemoteWorklog);
      if (r.timelogs.pageInfo.hasNextPage) {
        return { last: false, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { ...pageAt, username, after: r.timelogs.pageInfo.endCursor } satisfies TimelogPageAt) };
      }
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: pageAt.at } satisfies Since) };
    },
    async create(x, ref, w) {
      if (w.time.kind !== "session") throw new ProviderError("invalid", `GitLab keeps time with a start, not a ${w.time.kind}`);
      const c = await credsOf(x);
      const i = await mustLocate(c, ref);
      if (!(await timeModeOf(c)).writeTimelogs) {
        return createByNote(c, i, x.conn.remoteAccountId, { seconds: w.time.seconds, start: w.time.start, comment: w.comment }, withoutQuickActions);
      }
      const input = { issuableId: gidOf("Issue", i.id), timeSpent: `${w.time.seconds}s`, spentAt: new Date(w.time.start).toISOString(), summary: w.comment };
      const r = await modern(c, () => gql<{ timelogCreate: { timelog: GitLabTimelog | null; errors: string[] } }>(c, "TimelogCreate", TIMELOG_CREATE, { input }, "write"));
      if (!r.timelogCreate.timelog) throw new ProviderError("invalid", `GitLab: ${r.timelogCreate.errors.join("; ") || "no timelog made"}`);
      return toRemoteWorklog(r.timelogCreate.timelog);
    },
    async delete(x, ref, id) {
      const c = await credsOf(x);
      // An entry logged by note is taken back by note, whatever the server writes now.
      if (isNoteEntry(id)) {
        const i = await locate(c, ref);
        if (i) await deleteByNote(c, i, id);
        return;
      }
      const r = await modern(c, () => gql<{ timelogDelete: { errors: string[] } | null }>(c, "TimelogDelete", TIMELOG_DELETE, { input: { id: gidOf("Timelog", id) } }, "write"));
      const errors = r.timelogDelete?.errors ?? [];
      // Already gone is what was asked.
      if (errors.length && !errors.some((e) => /not found|doesn't exist|does not exist/i.test(e))) throw new ProviderError("invalid", `GitLab: ${errors.join("; ")}`);
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const i = await mustLocate(c, ref);
      const web = webBaseOf(x.conn.baseUrl);
      // System notes ("changed the description", "assigned to @x") share the list: they are history, not comments.
      const notes = await glPages<GitLabNote>(c, `${issueUrl(i)}/notes?sort=asc&order_by=created_at`);
      return notes.filter((n) => !n.system).map((n) => toRemoteComment(web, n));
    },
    async add(x, ref, body) {
      const c = await credsOf(x);
      const i = await mustLocate(c, ref);
      // GLFM takes CommonMark as is, but a line starting with / would run as a command.
      const r = await gl<Partial<GitLabNote>>(c, `${issueUrl(i)}/notes`, { method: "POST", body: JSON.stringify({ body: withoutQuickActions(body) }), accept: [202] });
      const n = r?.data;
      // A note that was only commands answers 202 with no note: read again.
      return { comment: n && typeof n.id === "number" && n.author ? toRemoteComment(webBaseOf(x.conn.baseUrl), n as GitLabNote) : null, warnings: [] };
    },
  },

  async watch(x, ref, on) {
    const c = await credsOf(x);
    const i = await mustLocate(c, ref);
    // Subscribing when subscribed (or the reverse) answers 304: what was asked is so.
    await gl(c, `${issueUrl(i)}/${on ? "subscribe" : "unsubscribe"}`, { method: "POST", accept: [304] });
  },

  async history(x, ref) {
    const c = await credsOf(x);
    const i = await mustLocate(c, ref);
    const web = webBaseOf(x.conn.baseUrl);
    const base = issueUrl(i);
    const [labels, states, milestones] = await Promise.all([
      glPages<GitLabLabelEvent>(c, `${base}/resource_label_events`),
      glPages<GitLabStateEvent>(c, `${base}/resource_state_events`),
      glPages<GitLabMilestoneEvent>(c, `${base}/resource_milestone_events`),
    ]);
    const actor = (u: GitLabUser | null | undefined) => (u ? person(web, u) : null);
    const at = (text: string) => instantFrom(text) ?? instant(0);
    const changes: RemoteChange[] = [
      ...labels.map((e): RemoteChange => {
        // A label deleted since leaves the event with no label.
        const v = [{ text: e.label?.name ?? "(deleted label)", ...(e.label ? { id: String(e.label.id) } : {}) }];
        return { at: at(e.created_at), actor: actor(e.user), field: { id: "labels", name: "Labels" }, from: e.action === "remove" ? v : [], to: e.action === "add" ? v : [] };
      }),
      ...states.map((e): RemoteChange => ({ at: at(e.created_at), actor: actor(e.user), field: { id: "state", name: "State" }, from: [], to: [{ text: e.state }] })),
      ...milestones.map((e): RemoteChange => {
        const v = [{ text: e.milestone?.title ?? "(deleted milestone)", ...(e.milestone ? { id: String(e.milestone.id) } : {}) }];
        return { at: at(e.created_at), actor: actor(e.user), field: { id: "milestone", name: "Milestone" }, from: e.action === "remove" ? v : [], to: e.action === "add" ? v : [] };
      }),
    ];
    return changes.sort((a, b) => a.at - b.at);
  },
};
