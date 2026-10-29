// Microsoft Planner (through Microsoft Graph v1.0) as a tracker, through the
// provider contract. Tasks assigned to the user, keyed PLANNER-<id>: a task has
// no number of its own, only its id (28 characters, case-sensitive, with "_"
// and "-"), which never changes. Planner keeps no modification time on a task:
// a pass reads every assigned task and tells the changed ones by their ETag
// (the checkpoint holds a short digest of each). A task's status is the bucket
// it sits in once the connection's options give that bucket a category, else
// its percentComplete (0 not started, 1-99 in progress, 100 completed).
// Time stays in inkledger's own register: Planner has none.
// Microsoft To Do (a different API: /me/todo) is not read.
// Built on a simulator, not verified on a real account: docs/dev/spikes.md.
import { createHash } from "node:crypto";
import { z } from "zod";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { DAY_MS } from "@contracts/time";
import { instant, instantFrom, localDate, localDateOf, type LocalDate, type TimeZone } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import {
  mappingId,
  mappingVersion,
  type ActiveWorkflowSource,
  type CallContext,
  type IssueHandle,
  type IssueRef,
  type RemoteIssue,
  type RemotePerson,
  type RemoteStatus,
  type ReportedIssueGone,
  type TrackerProvider,
  type Transition,
} from "../types";
import {
  graph,
  graphOk,
  graphPage,
  graphPages,
  WEB_BASE,
  type GraphUser,
  type PlannerBucket,
  type PlannerCreds,
  type PlannerDetails,
  type PlannerPlan,
  type PlannerPlanDetails,
  type PlannerTask,
} from "./client";

// The catalogue's entry for planner, here where the adapter keeps to it (the
// registry holds the two together).
export const plannerCapabilities: TrackerCapabilities = {
  // The bucket a task sits in, or its percentComplete.
  workflow: { sources: [{ kind: "column", transitions: "move" }, { kind: "itemState", transitions: "direct" }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: false,
  query: null,
  comments: { mode: "none" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: false,
  inbox: false,
  otherFields: false,
  history: false,
  time: { mode: "local", remoteTotals: false },
  sync: { issueCheckpoints: true, gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" }, webhooks: null },
};

export const plannerTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: false,
  devLinks: false,
  attachments: { read: false, upload: false },
  timeboxes: [],
  fields: ["priority", "due", "start", "labels", "multiAssignee"],
};

/** A bucket is matched by its name, whichever plan it is in (case and surrounding spaces aside). */
const bucketKey = (name: string) => name.trim().toLowerCase();

const optionsSchema = z.strictObject({
  /**
   * The category of each bucket name that is a status. Planner doesn't say what a
   * bucket means: never inferred from a name, so only the names listed here are
   * statuses; the rest of the tasks read Not started / In progress / Completed.
   */
  columns: z
    .record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES))
    .default({})
    .transform((r): Record<string, StatusCategory> => Object.fromEntries(Object.entries(r).map(([k, v]) => [bucketKey(k), v]))),
});
export type PlannerOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"planner", PlannerOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
/** A short digest of each task's ETag, by task id: the only way to tell what changed. */
type Seen = Record<string, string>;
type Since = { at: number; seen: Seen };
type IssuePage = { next: string | null; seen: Seen; at: number };

/** Completed tasks older than this are not read (a user can have years of them). */
const COMPLETED_WINDOW_DAYS = 30;
/** Tasks that left the list are looked at one by one: bounded. */
const MAX_GONE_CHECKS = 100;

async function credsOf(x: X): Promise<PlannerCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

type Shape = { connId: number; columns: Record<string, StatusCategory>; zone: TimeZone };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, columns: x.conn.options.columns, zone: x.conn.timeZone });

// ---------- Keys and links ----------

/** Case matters in the id: only the prefix is normalized. */
const KEY = /^PLANNER-([A-Za-z0-9_-]{16,64})$/i;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const keyOfId = (id: string) => `PLANNER-${id}`;
const normalizeKey = (raw: string) => {
  const m = KEY.exec(raw.trim());
  return m ? keyOfId(m[1]) : null;
};
const idOfKey = (key: string) => KEY.exec(key)?.[1] ?? null;
const idOfHandle = (h: { remoteId?: string; key?: string }) => h.remoteId ?? (h.key ? idOfKey(h.key) : null);

const WEB_HOSTS = new Set(["planner.cloud.microsoft", "tasks.office.com", "tasks.microsoft.com"]);
const webUrl = (t: Pick<PlannerTask, "id" | "planId">) => `${WEB_BASE}/webui/plan/${t.planId}/view/board/task/${t.id}`;

// ---------- Statuses ----------

const itemState = (id: string, name: string, category: StatusCategory): RemoteStatus => ({ id, name, category, categoryOrigin: { by: "native" }, source: { kind: "itemState" } });
const NOT_STARTED = itemState("0", "Not started", "todo");
const IN_PROGRESS = itemState("50", "In progress", "doing");
const COMPLETED = itemState("100", "Completed", "done");

// The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
function columnStatus(s: Shape, plan: string, bucket: { id: string; name: string }, category: StatusCategory): RemoteStatus {
  return { id: bucket.id, name: bucket.name, category, categoryOrigin: { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) }, source: { kind: "column", boardRemoteId: plan } };
}

/** Completed is completed; an open task takes its bucket's status when the options say what it is, else its percentComplete. */
function statusOf(s: Shape, percent: number, plan: PlanInfo | null, bucketId: string | null | undefined): RemoteStatus {
  if (percent >= 100) return COMPLETED;
  const name = bucketId ? plan?.buckets.get(bucketId) : undefined;
  const category = name === undefined ? undefined : s.columns[bucketKey(name)];
  if (plan && bucketId && name !== undefined && category) return columnStatus(s, plan.id, { id: bucketId, name }, category);
  return percent > 0 ? IN_PROGRESS : NOT_STARTED;
}

// ---------- Plans and people ----------

type PlanInfo = { id: string; title: string; buckets: Map<string, string>; categories: Record<string, string | null> };

/** The colour each label slot carries by default (Planner's labels have no text until someone names them). */
const CATEGORY_COLORS = [
  "Pink", "Red", "Yellow", "Green", "Blue", "Purple", "Bronze", "Lime", "Aqua", "Gray", "Silver", "Brown", "Cranberry",
  "Orange", "Peach", "Marigold", "LightGreen", "DarkGreen", "Teal", "LightBlue", "DarkBlue", "Lavender", "Plum", "LightGray", "DarkGray",
];

/** Not allowed or not there: the plan or user is simply unknown. */
async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === "forbidden" || e.kind === "notFound")) return null;
    throw e;
  }
}

/** What turning tasks into the layer's shape needs of the service, read once per call. */
function lookups(c: PlannerCreds) {
  const plans = new Map<string, Promise<PlanInfo | null>>();
  const people = new Map<string, Promise<RemotePerson>>();
  return {
    plan(id: string): Promise<PlanInfo | null> {
      let p = plans.get(id);
      if (!p) {
        const path = `/planner/plans/${encodeURIComponent(id)}`;
        p = Promise.all([
          soft(graphOk<PlannerPlan>(c, path)),
          soft(graphPages<PlannerBucket>(c, `${path}/buckets`)),
          soft(graphOk<PlannerPlanDetails>(c, `${path}/details`)),
        ]).then(([plan, buckets, details]) => (plan ? { id, title: plan.title ?? id, buckets: new Map((buckets ?? []).map((b) => [b.id, b.name])), categories: details?.categoryDescriptions ?? {} } : null));
        plans.set(id, p);
      }
      return p;
    },
    person(id: string): Promise<RemotePerson> {
      let p = people.get(id);
      if (!p) {
        // Names need User.ReadBasic.All: without it, or for a guest, the id stands in.
        p = soft(graphOk<GraphUser>(c, `/users/${encodeURIComponent(id)}`)).then((u) => (u ? person(u) : { remoteId: id, name: id }));
        people.set(id, p);
      }
      return p;
    },
  };
}

function person(u: GraphUser): RemotePerson {
  return { remoteId: u.id, name: u.displayName || u.mail || u.userPrincipalName || u.id, avatarUrl: null };
}

// ---------- Shaping ----------

/** 0-1 urgent, 2-4 important, 5-7 medium, 8-10 low. */
function priorityOf(n: number | undefined): RemoteIssue["priority"] {
  if (n === undefined || n < 0 || n > 10) return null;
  if (n <= 1) return { id: "urgent", name: "Urgent", rank: 0 };
  if (n <= 4) return { id: "important", name: "Important", rank: 1 };
  if (n <= 7) return { id: "medium", name: "Medium", rank: 3 };
  return { id: "low", name: "Low", rank: 4 };
}

/**
 * The apps store a picked day as that day at midnight UTC; an instant at any
 * other time (set through the API) falls on the user's day, not on UTC's.
 */
function dueOf(text: string | null | undefined, zone: TimeZone): LocalDate | null {
  const at = instantFrom(text ?? null);
  if (at === null) return null;
  return /T00:00:00(?:\.0+)?Z$/i.test(text ?? "") ? localDate((text ?? "").slice(0, 10)) : localDateOf(at, zone);
}

function labelsOf(t: PlannerTask, plan: PlanInfo | null): string[] {
  return Object.entries(t.appliedCategories ?? {}).flatMap(([slot, on]) => {
    if (!on) return [];
    const n = /^category(\d+)$/.exec(slot);
    const color = n ? CATEGORY_COLORS[Number(n[1]) - 1] : undefined;
    return [plan?.categories[slot]?.trim() || color || slot];
  });
}

async function shapeOne(s: Shape, t: PlannerTask, look: ReturnType<typeof lookups>): Promise<RemoteIssue> {
  const plan = await look.plan(t.planId);
  const ids = Object.keys(t.assignments ?? {});
  const assignees = await Promise.all(ids.map((id) => look.person(id)));
  const authorId = t.createdBy?.user?.id ?? null;
  return {
    remoteId: t.id,
    key: keyOfId(t.id),
    url: webUrl(t),
    title: t.title,
    type: { id: "task", name: "Task", level: "standard" },
    status: statusOf(s, t.percentComplete, plan, t.bucketId),
    container: { remoteId: t.planId, key: plan?.title ?? t.planId, name: plan?.title ?? t.planId, kind: "plan" },
    priority: priorityOf(t.priority),
    labels: labelsOf(t, plan),
    assignees,
    reporter: authorId ? await look.person(authorId) : null,
    due: dueOf(t.dueDateTime, s.zone),
    createdAt: instantFrom(t.createdDateTime ?? null),
    // Planner keeps no modification time on a task.
    updatedAt: null,
    statusChangedAt: instantFrom(t.completedDateTime ?? null),
    parent: null,
  };
}

const shapeAll = (c: PlannerCreds, s: Shape, tasks: PlannerTask[]) => {
  const look = lookups(c);
  return Promise.all(tasks.map((t) => shapeOne(s, t, look)));
};

// ---------- Finding a task ----------

const taskPath = (id: string) => `/planner/tasks/${encodeURIComponent(id)}`;

/** A task as it is now; null when it isn't there (a deleted task is a 404) or the user cannot see it (403). */
async function locate(c: PlannerCreds, id: string | null): Promise<PlannerTask | null> {
  if (!id || !ID.test(id)) return null;
  try {
    return (await graph<PlannerTask>(c, taskPath(id), { missingIsNull: true }))?.data ?? null;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "forbidden") return null;
    throw e;
  }
}

async function mustLocate(c: PlannerCreds, ref: IssueRef): Promise<PlannerTask> {
  const t = await locate(c, idOfHandle(ref));
  if (!t) throw new ProviderError("notFound", `Planner: no task ${ref.key}`);
  return t;
}

// ---------- Passes ----------

/** A short digest of a task's revision. */
const digest = (t: PlannerTask) => createHash("sha1").update(t["@odata.etag"] ?? JSON.stringify(t)).digest("base64url").slice(0, 8);

/** Whether a task is read at all: a completed one only while recent. */
const inWindow = (t: PlannerTask, at: number) => t.percentComplete < 100 || (instantFrom(t.completedDateTime ?? null) ?? 0) >= at - COMPLETED_WINDOW_DAYS * DAY_MS;

// ---------- Transitions ----------

type Change = { percentComplete?: number; bucketId?: string };

/** The change for a transition id: "percent:<0|50|100>" or "bucket:<id>" (a mapped bucket of the task's plan). */
async function changeOf(c: PlannerCreds, s: Shape, t: PlannerTask, id: string, look = lookups(c)): Promise<Change> {
  const percent = /^percent:(0|50|100)$/.exec(id);
  if (percent) return { percentComplete: Number(percent[1]) };
  const bucket = id.startsWith("bucket:") ? id.slice(7) : null;
  const plan = await look.plan(t.planId);
  const name = bucket ? plan?.buckets.get(bucket) : undefined;
  if (!bucket || name === undefined || !s.columns[bucketKey(name)]) throw new ProviderError("invalid", `Planner: no transition ${id}`);
  return { bucketId: bucket };
}

/** Whether a task is gone for good (404); one the user can't see (403) is not reported. */
async function isDeleted(c: PlannerCreds, id: string): Promise<boolean> {
  try {
    return (await graph<PlannerTask>(c, taskPath(id), { missingIsNull: true })) === null;
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "forbidden") return false;
    throw e;
  }
}

/** PATCH with the revision just read; a change meanwhile (412) is read again once. */
async function patched(c: PlannerCreds, id: string, change: Change): Promise<PlannerTask> {
  for (let attempt = 0; ; attempt++) {
    const t = await locate(c, id);
    if (!t) throw new ProviderError("notFound", `Planner: no task ${keyOfId(id)}`);
    const etag = t["@odata.etag"];
    if (!etag) throw new ProviderError("incompatible", "Planner: a task without an ETag");
    try {
      const done = await graph<PlannerTask | undefined>(c, taskPath(id), { method: "PATCH", body: change, etag, representation: true });
      // Without the representation (204) the task is read again.
      return done?.data ?? (await mustLocate(c, { remoteId: id, key: keyOfId(id) }));
    } catch (e) {
      if (!(e instanceof ProviderError && e.kind === "conflict" && attempt === 0)) throw e;
    }
  }
}

// ---------- The adapter ----------

export const plannerProvider: TrackerProvider<"planner", PlannerOptions> = {
  role: "tracker",
  type: "planner",
  capabilities: plannerCapabilities,
  traits: plannerTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Planner options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    try {
      const url = new URL(input.trim());
      if (!WEB_HOSTS.has(url.hostname.toLowerCase())) return null;
      // …/plan/<plan>/view/board/task/<task>, and the older …/Home/Task/<task>
      const m = /\/task\/([A-Za-z0-9_-]{16,64})\/?$/i.exec(url.pathname);
      return m ? { key: keyOfId(m[1]), remoteId: m[1] } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await graphOk<GraphUser>(await credsOf(x), "/me");
    return { ...person(me), ...(me.mail ? { email: me.mail } : {}), ...(me.userPrincipalName ? { login: me.userPrincipalName } : {}) };
  },

  async probe(x) {
    const c = await credsOf(x);
    await graphOk<GraphUser>(c, "/me");
    const sources: ActiveWorkflowSource[] = [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Progress" }];
    // Buckets are statuses only once the options name some: then each plan is a board (the plans shared with the user).
    if (Object.keys(x.conn.options.columns).length > 0) {
      for (const p of await graphPages<PlannerPlan>(c, "/me/planner/plans", 5)) sources.push({ kind: "column", transitions: "move", ref: { kind: "column", boardRemoteId: p.id }, name: p.title ?? p.id });
    }
    // Graph's limits depend on the tenant and answer only when exceeded (429, Retry-After): no figure to give.
    return { capabilities: plannerCapabilities, activeSources: sources, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const shape = shapeOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since);
    const pass = decodePageToken<IssuePage>(x.conn, "issues", V, q.since, q.page) ?? { next: "/me/planner/tasks", seen: {}, at: Date.now() };
    const r = pass.next ? await graphPage<PlannerTask>(c, pass.next) : null;
    const seen: Seen = { ...pass.seen };
    const changed: PlannerTask[] = [];
    for (const t of r?.data ?? []) {
      if (!inWindow(t, pass.at)) continue;
      const d = digest(t);
      seen[t.id] = d;
      if (since?.seen[t.id] !== d) changed.push(t);
    }
    const items = await shapeAll(c, shape, changed);
    if (r?.next) return { last: false, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, { next: r.next, seen, at: pass.at } satisfies IssuePage) };
    // Planner has no change feed: what was in the last pass and is not in this one is looked at, and only a 404 is a deletion
    // (unassigned, or a plan the user left, are not reported: the engine's reconciliation tells them).
    const gone: ReportedIssueGone[] = [];
    for (const id of Object.keys(since?.seen ?? {})
      .filter((id) => !(id in seen))
      .slice(0, MAX_GONE_CHECKS)) {
      if (await isDeleted(c, id)) gone.push({ remoteId: id, reason: "deleted" });
    }
    return { last: true, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: pass.at, seen } satisfies Since) };
  },

  async getIssue(x, ref) {
    const c = await credsOf(x);
    const t = await locate(c, idOfHandle(ref));
    return t ? (await shapeAll(c, shapeOf(x), [t]))[0] : null;
  },

  async findIssue(x, handle) {
    const c = await credsOf(x);
    const t = await locate(c, idOfHandle(handle));
    // An id is unique on the service: never ambiguous.
    return t ? { kind: "found", issue: (await shapeAll(c, shapeOf(x), [t]))[0] } : { kind: "none" };
  },

  async statuses(x, source) {
    if (source.kind === "itemState") return [NOT_STARTED, IN_PROGRESS, COMPLETED];
    if (source.kind !== "column") return [];
    const s = shapeOf(x);
    const buckets = await graphPages<PlannerBucket>(await credsOf(x), `/planner/plans/${encodeURIComponent(source.ref.boardRemoteId)}/buckets`);
    return buckets.flatMap((b, order) => {
      const category = s.columns[bucketKey(b.name)];
      return category ? [{ ...columnStatus(s, source.ref.boardRemoteId, b, category), order }] : [];
    });
  },

  async description(x, ref) {
    const id = idOfHandle(ref);
    if (!id || !ID.test(id)) return null;
    const d = await soft(graph<PlannerDetails>(await credsOf(x), `${taskPath(id)}/details`, { missingIsNull: true }));
    const text = d?.data.description?.replace(/\r\n?/g, "\n") ?? "";
    return text.trim() ? { kind: "text", format: "plain", text } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const s = shapeOf(x);
      const look = lookups(c);
      const plan = await look.plan(t.planId);
      const now = statusOf(s, t.percentComplete, plan, t.bucketId);
      const common = { requirements: [], remoteUrl: webUrl(t) };
      const to = (percent: number, bucketId = t.bucketId) => statusOf(s, percent, plan, bucketId);
      if (t.percentComplete >= 100) return [{ id: "percent:0", name: "Reopen", to: to(0), ...common }] satisfies Transition[];
      const moves = [...(plan?.buckets ?? [])].flatMap(([id, name]): Transition[] => {
        const category = s.columns[bucketKey(name)];
        return category && id !== t.bucketId ? [{ id: `bucket:${id}`, name: `Move to ${name}`, to: columnStatus(s, t.planId, { id, name }, category), ...common }] : [];
      });
      // Starting only changes the status of a task not in a mapped bucket: in one, the bucket is the status.
      const start: Transition[] = now.source.kind === "itemState" && t.percentComplete === 0 ? [{ id: "percent:50", name: "Start", to: IN_PROGRESS, ...common }] : [];
      return [...moves, ...start, { id: "percent:100", name: "Complete", to: COMPLETED, ...common }];
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const t = await mustLocate(c, ref);
      const shape = shapeOf(x);
      const change = await changeOf(c, shape, t, transitionId);
      const done = await patched(c, t.id, change);
      return (await shapeAll(c, shape, [done]))[0];
    },
  },
};
