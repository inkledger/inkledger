// Todoist as a tracker, through the provider contract. Tasks assigned to the
// user (and the unassigned ones of the user's own, unshared projects), keyed
// by their id: Todoist has no display key, and an id is opaque (16 or so
// letters and digits) and kept when the task moves. A task's status is
// "Completed" once checked; open, the section (column) it sits in; open with
// no section, "Open". Todoist gives sections no meaning, so their categories
// come from the connection's own mapping (options.categories); a section
// nobody mapped is "todo". Todoist keeps no time inkledger can use: the time
// stays in inkledger's own register.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { STATUS_CATEGORIES, type StatusCategory, type TrackerCapabilities, type TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, localDateOf, type Instant, type JsonValue, type LocalDate, type TimeZone } from "@contracts/values";
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
  type RemoteStatusStep,
  type ReportedIssueGone,
  type TrackerProvider,
  type Transition,
} from "../types";
import {
  td,
  tdAll,
  tdDo,
  tdOk,
  tdSync,
  type TodoistActivity,
  type TodoistCollaborator,
  type TodoistComment,
  type TodoistCreds,
  type TodoistDue,
  type TodoistProject,
  type TodoistSection,
  type TodoistTask,
  type TodoistUser,
} from "./client";

// The catalogue's entry for todoist, here where the adapter keeps to it (the
// registry holds the two together).
export const todoistCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["commonmark"], writePreserves: ["paragraph", "emphasis", "strong", "code", "link"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: false,
  inbox: false,
  otherFields: false,
  history: true,
  statusHistory: true,
  // Completed or not; and the section an open task sits in, which it moves between.
  workflow: { sources: [{ kind: "boolean", transitions: "direct", reasons: false }, { kind: "column", transitions: "move" }] },
  time: { mode: "local", remoteTotals: false },
  sync: {
    issueCheckpoints: true,
    // A deleted task is reported by the sync; one the user lost sight of is not told apart from one reassigned.
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const todoistTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: false,
  devLinks: false,
  attachments: { read: false, upload: false },
  timeboxes: [],
  fields: ["priority", "due", "labels"],
};

const optionsSchema = z.strictObject({
  /**
   * The category of each section, by the section's id or by its name (any
   * case). Todoist doesn't say what a section means: only what is listed
   * here is read as more than "todo".
   */
  categories: z.record(z.string().min(1).max(200), z.enum(STATUS_CATEGORIES)).default({}),
});
export type TodoistOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"todoist", TodoistOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
/** The Sync API's token: opaque, "*" for everything. */
type Since = { token: string };

/** The documented budget of a token: 450 requests per 15 minutes. */
const RATE = { perHour: 1800, origin: "typical" } as const;
const WEB = "https://app.todoist.com";

async function credsOf(x: X): Promise<TodoistCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

// ---------- Keys and links ----------

/** An id: letters and digits, at least one digit (so that no plain word is taken for one). Legacy numeric ids match too. */
const ID = /^(?=.*\d)[A-Za-z0-9]{8,24}$/;
const normalizeKey = (raw: string) => (ID.test(raw.trim()) ? raw.trim() : null);
/** The numeric ids of the old API, which the unified API no longer reads. */
const isLegacyId = (k: string) => /^\d+$/.test(k);

const WEB_HOSTS = new Set(["app.todoist.com", "todoist.com", "www.todoist.com"]);

/** What a pasted address says: /app/task/<slug>-<id> (the slug follows the title: only the id counts), /app/task/<id>, or the old showTask?id=<number>. */
function keyOfUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || !WEB_HOSTS.has(url.hostname)) return null;
    if (url.pathname.replace(/\/+$/, "") === "/showTask") return normalizeKey(url.searchParams.get("id") ?? "");
    const m = /\/task\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    return m ? normalizeKey(m[1]) : null;
  } catch {
    return null;
  }
}

// ---------- Shapes ----------

const person = (u: Pick<TodoistUser, "id" | "full_name" | "email" | "avatar_big">): RemotePerson => ({
  remoteId: u.id,
  name: u.full_name || u.email || u.id,
  avatarUrl: u.avatar_big ?? null,
});

/** What turning a task into the layer's shape needs of its connection. */
type Shape = { connId: number; zone: TimeZone; categories: TodoistOptions["categories"] };
const shapeOf = (x: X): Shape => ({ connId: x.conn.id, zone: x.conn.timeZone, categories: x.conn.options.categories });

function categoryOf(s: Shape, section: Pick<TodoistSection, "id" | "name">): StatusCategory {
  const byId = s.categories[section.id];
  if (byId) return byId;
  const name = section.name.trim().toLowerCase();
  const hit = Object.entries(s.categories).find(([k]) => k.toLowerCase() === name);
  return hit ? hit[1] : "todo";
}

const OPEN: RemoteStatus = { id: "open", name: "Open", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };
const COMPLETED: RemoteStatus = { id: "completed", name: "Completed", category: "done", categoryOrigin: { by: "native" }, source: { kind: "boolean" } };

// The connection's options are its category mapping until the engine's own mapping table exists: id = the connection, version 1.
export function sectionStatus(s: Shape, section: TodoistSection): RemoteStatus {
  return {
    id: section.id,
    name: section.name,
    category: categoryOf(s, section),
    categoryOrigin: { by: "mapping", mapping: mappingId(s.connId), version: mappingVersion(1) },
    source: { kind: "column", boardRemoteId: section.project_id },
    order: section.section_order,
  };
}

/** 4 is "p1" in the app, 1 the default ("p4", none): on the coarse scale shared by every provider. */
const PRIORITIES: Record<number, { name: string; rank: number }> = { 4: { name: "P1 (urgent)", rank: 0 }, 3: { name: "P2 (high)", rank: 1 }, 2: { name: "P3 (medium)", rank: 3 } };
const priorityOf = (n: number) => (PRIORITIES[n] ? { id: String(n), name: PRIORITIES[n].name, rank: PRIORITIES[n].rank } : null);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a due date falls on for the user. A day is itself; a floating time
 * ("2026-10-30T09:00:00", no zone) is the user's own clock, so its day too;
 * only a fixed instant ("…Z", the zone beside it) is converted, to the user's
 * zone, not the task's.
 */
export function dueDay(zone: TimeZone, due: TodoistDue | null | undefined): LocalDate | null {
  if (!due) return null;
  if (DAY.test(due.date)) return localDate(due.date);
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(due.date)) {
    const at = instantFrom(due.date);
    return at === null ? null : localDateOf(at, zone);
  }
  const day = due.date.slice(0, 10);
  return DAY.test(day) ? localDate(day) : null;
}

export function toRemoteIssue(s: Shape, t: TodoistTask, project: TodoistProject, section: TodoistSection | null, who: (uid: string) => RemotePerson): RemoteIssue {
  const fields: Record<string, JsonValue> = {
    ...(t.due?.is_recurring ? { recurring: t.due.string ?? true } : {}),
    ...(t.due && !DAY.test(t.due.date) ? { dueAt: t.due.date, ...(t.due.timezone ? { dueTimezone: t.due.timezone } : {}) } : {}),
    ...(t.deadline?.date ? { deadline: t.deadline.date } : {}),
  };
  return {
    remoteId: t.id,
    key: t.id,
    url: `${WEB}/app/task/${t.id}`,
    title: t.content,
    type: { id: "task", name: "Task", level: t.parent_id ? "sub" : "standard" },
    status: t.checked ? COMPLETED : section ? sectionStatus(s, section) : OPEN,
    container: { remoteId: project.id, key: project.id, name: project.name, kind: "project" },
    priority: priorityOf(t.priority),
    labels: t.labels,
    assignees: t.responsible_uid ? [who(t.responsible_uid)] : [],
    reporter: t.added_by_uid ? who(t.added_by_uid) : null,
    due: dueDay(s.zone, t.due),
    estimateSeconds: null,
    createdAt: instantFrom(t.added_at),
    updatedAt: instantFrom(t.updated_at),
    statusChangedAt: t.checked ? instantFrom(t.completed_at) : null,
    parent: t.parent_id ? { remoteId: t.parent_id, key: t.parent_id } : null,
    fields,
  };
}

// ---------- What a task needs around it: its project, section and people ----------

type World = {
  c: TodoistCreds;
  meId: string;
  projects: Map<string, TodoistProject | null>;
  sections: Map<string, TodoistSection | null>;
  people: Map<string, RemotePerson>;
  /** Projects whose collaborators are read */
  collaborators: Set<string>;
  allProjects: boolean;
  allSections: boolean;
};
const worldOf = (x: X, c: TodoistCreds): World => ({ c, meId: x.conn.remoteAccountId, projects: new Map(), sections: new Map(), people: new Map(), collaborators: new Set(), allProjects: false, allSections: false });

async function loadProjects(w: World): Promise<void> {
  if (w.allProjects) return;
  for (const p of (await tdAll<TodoistProject>(w.c, "/projects")).rows) w.projects.set(p.id, p);
  w.allProjects = true;
}

/** A project by id: from what is known, else asked for (an archived project is not in the list). */
async function projectOf(w: World, id: string): Promise<TodoistProject | null> {
  if (w.projects.has(id)) return w.projects.get(id) ?? null;
  const p = (await td<TodoistProject>(w.c, `/projects/${id}`, { missingIsNull: true }))?.data ?? null;
  w.projects.set(id, p && !p.is_deleted ? p : null);
  return w.projects.get(id) ?? null;
}

async function loadSections(w: World): Promise<void> {
  if (w.allSections) return;
  for (const s of (await tdAll<TodoistSection>(w.c, "/sections")).rows) w.sections.set(s.id, s);
  w.allSections = true;
}

async function sectionOf(w: World, id: string, wholeList: boolean): Promise<TodoistSection | null> {
  if (w.sections.has(id)) return w.sections.get(id) ?? null;
  // A pass reads the list once; a single task asks for its own section.
  if (wholeList) await loadSections(w);
  if (!w.sections.has(id)) w.sections.set(id, (await td<TodoistSection>(w.c, `/sections/${id}`, { missingIsNull: true }))?.data ?? null);
  const s = w.sections.get(id) ?? null;
  return s && !s.is_deleted ? s : null;
}

/** Someone by id: from the project's collaborators, else the user themselves, else only the id. */
async function personOf(w: World, uid: string, projectId: string | null): Promise<RemotePerson> {
  const known = w.people.get(uid);
  if (known) return known;
  const project = projectId ? await projectOf(w, projectId) : null;
  if (project?.is_shared && !w.collaborators.has(project.id)) {
    w.collaborators.add(project.id);
    for (const u of (await tdAll<TodoistCollaborator>(w.c, `/projects/${project.id}/collaborators`)).rows) {
      if (!w.people.has(u.id)) w.people.set(u.id, { remoteId: u.id, name: u.name || u.email || u.id, avatarUrl: null });
    }
  }
  if (!w.people.has(uid) && uid === w.meId) w.people.set(uid, person(await tdOk<TodoistUser>(w.c, "/user")));
  return w.people.get(uid) ?? { remoteId: uid, name: uid, avatarUrl: null };
}

/** Whether a task is the user's: assigned to them, or in a project of their own (nobody to assign it to). */
const isMine = (w: World, t: TodoistTask, p: TodoistProject) => t.responsible_uid === w.meId || (t.responsible_uid === null && !p.is_shared);

/** Tasks as issues; one whose project the token can't read is left out. */
async function issuesOf(x: X, w: World, tasks: TodoistTask[], wholeList: boolean): Promise<RemoteIssue[]> {
  const s = shapeOf(x);
  const out: RemoteIssue[] = [];
  for (const t of tasks) {
    const p = await projectOf(w, t.project_id);
    if (!p) continue;
    const section = t.section_id ? await sectionOf(w, t.section_id, wholeList) : null;
    for (const uid of [t.responsible_uid, t.added_by_uid]) if (uid) await personOf(w, uid, p.id);
    out.push(toRemoteIssue(s, t, p, section, (uid) => w.people.get(uid) ?? { remoteId: uid, name: uid, avatarUrl: null }));
  }
  return out;
}

// ---------- Reading one task ----------

/** A task by id, null when it isn't there for this token. */
/**
 * The task's status through its activity, as the issue shows it: completed, else
 * its section, else open. It starts open, in the section its first move left
 * (else the one it is in). An activity log cut short (no "added": a week on the
 * free plan) leaves the start unknown: the first step comes from null. A
 * recurring task logs completions that leave it open, a move between projects
 * may change sections unseen, and a section deleted since has no name: none can
 * be read.
 */
export function replayStatus(s: Shape, task: Pick<TodoistTask, "section_id" | "due">, sections: readonly TodoistSection[], activity: readonly TodoistActivity[]): RemoteStatusStep[] {
  if (task.due?.is_recurring) throw new ProviderError("incompatible", "Todoist: a recurring task's completions leave it open");
  const rows = [...activity].sort((a, b) => a.event_date.localeCompare(b.event_date));
  const moves = rows.filter((a) => a.event_type === "moved");
  if (moves.some((a) => a.extra_data?.destination_project_id)) throw new ProviderError("incompatible", "Todoist: a move between projects");
  const known = rows.some((a) => a.event_type === "added");
  let section: string | null = moves.length ? (moves[0].extra_data?.last_section_id ?? null) : task.section_id;
  let completed = false;
  const brief = (r: RemoteStatus) => ({ id: r.id, name: r.name });
  const derive = () => {
    if (completed) return COMPLETED;
    if (section === null) return OPEN;
    const sec = sections.find((x) => x.id === section);
    if (!sec) throw new ProviderError("incompatible", "Todoist: a section deleted since");
    return sectionStatus(s, sec);
  };
  let current: RemoteStatus | null = known ? derive() : null;
  const steps: RemoteStatusStep[] = [];
  const relevant = rows.filter((a) => a.event_type === "moved" || a.event_type === "completed" || a.event_type === "uncompleted");
  relevant.forEach((a, n) => {
    if (a.event_type === "moved") {
      if ((a.extra_data?.last_section_id ?? null) !== section) throw new ProviderError("incompatible", "Todoist: a move from a section the task wasn't in");
      section = a.extra_data?.section_id ?? null;
    } else {
      const on = a.event_type === "completed";
      if (completed === on && current !== null) throw new ProviderError("incompatible", `Todoist: ${a.event_type} on a task already so`);
      completed = on;
    }
    // Events of one instant make one step.
    if (relevant[n + 1]?.event_date === a.event_date) return;
    const next = derive();
    if (next.id !== current?.id) steps.push({ at: instantFrom(a.event_date) ?? instant(0), from: current ? brief(current) : null, to: brief(next) });
    current = next;
  });
  if (!known && steps.length === 0) throw new ProviderError("incompatible", "Todoist: the activity log doesn't reach the task's creation");
  return steps;
}

async function taskBy(c: TodoistCreds, key: string): Promise<TodoistTask | null> {
  let id = key;
  if (isLegacyId(key)) {
    // The old numeric id, from an old link: the new one comes from the mapping.
    const maps = await tdOk<{ old_id: string; new_id: string | null }[]>(c, `/id_mappings/tasks/${key}`);
    const hit = maps.find((m) => m.old_id === key)?.new_id;
    if (!hit) return null;
    id = hit;
  }
  const open = await td<TodoistTask>(c, `/tasks/${encodeURIComponent(id)}`, { missingIsNull: true });
  if (open) return open.data;
  // /tasks/{id} answers open tasks only: a completed one comes from the Sync API.
  const any = await td<{ item: TodoistTask }>(c, "/sync/items/get", { query: { item_id: id }, missingIsNull: true });
  return any && !any.data.item.is_deleted ? any.data.item : null;
}

async function issueBy(x: X, c: TodoistCreds, key: string): Promise<RemoteIssue | null> {
  const t = await taskBy(c, key);
  return t ? ((await issuesOf(x, worldOf(x, c), [t], false))[0] ?? null) : null;
}

const idOf = (ref: { remoteId: string; key: string }) => ref.remoteId || ref.key;

// ---------- Comments and history ----------

const toRemoteComment = (cm: TodoistComment, author: RemotePerson): RemoteComment => ({
  id: cm.id,
  author,
  body: { kind: "text", format: "commonmark", text: cm.content },
  createdAt: instantFrom(cm.posted_at),
  // Todoist doesn't say when a comment was edited.
  updatedAt: instantFrom(cm.posted_at),
});

const text = (v: string | null | undefined, id?: string): ChangeValue[] => (v === null || v === undefined || v === "" ? [] : [{ text: v, ...(id ? { id } : {}), raw: v }]);

/** One activity may change several fields at once (an update): one change per field. */
async function toChanges(w: World, a: TodoistActivity): Promise<RemoteChange[]> {
  const at = instantFrom(a.event_date);
  if (at === null) return [];
  const project = a.parent_project_id ?? null;
  const actor = a.initiator_id ? await personOf(w, a.initiator_id, project) : null;
  const out: RemoteChange[] = [];
  const push = (field: RemoteChange["field"], from: ChangeValue[], to: ChangeValue[]) => out.push({ at, actor, field, from, to });
  const e = a.extra_data ?? {};
  const name = async (uid: string | null | undefined) => (uid ? text((await personOf(w, uid, project)).name, uid) : []);
  if (a.event_type === "completed") push({ id: "checked", name: "Status" }, text(OPEN.name, OPEN.id), text(COMPLETED.name, COMPLETED.id));
  else if (a.event_type === "uncompleted") push({ id: "checked", name: "Status" }, text(COMPLETED.name, COMPLETED.id), text(OPEN.name, OPEN.id));
  else if (a.event_type === "updated") {
    if (e.last_content !== undefined) push({ id: "content", name: "Title" }, text(e.last_content), text(e.content));
    if (e.last_description !== undefined) push({ id: "description", name: "Description" }, text(e.last_description), text(e.description));
    if ("last_due_date" in e) push({ id: "due", name: "Due date" }, text(e.last_due_date), text(e.due_date));
    if ("last_responsible_uid" in e) push({ id: "responsible_uid", name: "Assignee" }, await name(e.last_responsible_uid), await name(e.responsible_uid));
  }
  return out;
}

/** Filter syntax reads these as operators: in a search they are text, backslash-escaped. */
export const escapeFilter = (s: string) => s.replace(/[\\&|!(),]/g, "\\$&");

// ---------- Provider ----------

export const todoistProvider: TrackerProvider<"todoist", TodoistOptions> = {
  webhook: {
    verify: (req, secret) => todoistWebhook.verify({ secret, rawBody: req.body, headers: req.headers }),
    deliveryId: (req) => req.headers["x-todoist-delivery-id"] || null,
    sentAt: (req) => todoistWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "todoist",
  capabilities: todoistCapabilities,
  traits: todoistTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Todoist options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, input): IssueHandle | null {
    const key = normalizeKey(input);
    if (key) return { key };
    const fromUrl = keyOfUrl(input);
    return fromUrl ? { key: fromUrl } : null;
  },

  async verify(x) {
    try {
      const me = await tdOk<TodoistUser>(await credsOf(x), "/user");
      return { ...person(me), ...(me.email ? { email: me.email } : {}) };
    } catch (e) {
      // The old API answered a bad token with 403: nothing but the token can be refused here.
      if (e instanceof ProviderError && e.kind === "forbidden") throw new ProviderError("auth", e.message, { status: e.status, cause: e });
      throw e;
    }
  },

  async probe(x) {
    const w = worldOf(x, await credsOf(x));
    await Promise.all([loadProjects(w), loadSections(w)]);
    const withSections = new Set([...w.sections.values()].filter((s): s is TodoistSection => !!s && !s.is_archived).map((s) => s.project_id));
    // Completed or not, and one column source per project that has sections.
    const activeSources: ActiveWorkflowSource[] = [
      { kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / completed" },
      ...[...w.projects.values()]
        .filter((p): p is TodoistProject => !!p && withSections.has(p.id))
        .map<ActiveWorkflowSource>((p) => ({ kind: "column", transitions: "move", ref: { kind: "column", boardRemoteId: p.id }, name: p.name })),
    ];
    return { capabilities: todoistCapabilities, activeSources, rateLimit: RATE, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.token ?? "*";
    // A pass is one page: the Sync API answers whole (a page token can only be a stale one).
    decodePageToken<unknown>(x.conn, "issues", V, q.since, q.page);
    const answer = await tdSync(c, since);
    const rows = answer.items ?? [];
    const w = worldOf(x, c);
    await loadProjects(w);
    // Everything the sync says changed, in the projects the user is in; what is the user's is kept.
    const mine: TodoistTask[] = [];
    for (const t of rows.filter((r) => !r.is_deleted)) {
      const p = await projectOf(w, t.project_id);
      if (p && isMine(w, t, p)) mine.push(t);
    }
    mine.sort((a, b) => (a.updated_at ?? "").localeCompare(b.updated_at ?? "") || a.id.localeCompare(b.id));
    const items = await issuesOf(x, w, mine, true);
    // A deleted task is reported whoever it was assigned to: the engine ignores what it never had.
    const gone: ReportedIssueGone[] = rows.filter((r) => r.is_deleted).map((r) => ({ remoteId: r.id, reason: "deleted" }));
    return { last: true as const, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { token: answer.sync_token } satisfies Since) };
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
    const words = input.trim();
    if (!words) return { items: [], complete: true };
    const r = await tdAll<TodoistTask>(c, "/tasks/filter", { query: `search: ${escapeFilter(words)}` }, Math.max(1, limit));
    return { items: await issuesOf(x, worldOf(x, c), r.rows, true), complete: r.complete };
  },

  async statuses(x, source) {
    const s = shapeOf(x);
    if (source.ref.kind === "boolean") return [OPEN, COMPLETED];
    if (source.ref.kind !== "column") return [];
    const rows = await tdAll<TodoistSection>(await credsOf(x), "/sections", { project_id: source.ref.boardRemoteId });
    return [...rows.rows].sort((a, b) => a.section_order - b.section_order).map((sec) => sectionStatus(s, sec));
  },

  async description(x, ref) {
    const t = await taskBy(await credsOf(x), idOf(ref));
    // Todoist keeps Markdown in the description; an empty one is "".
    return t?.description ? { kind: "text", format: "commonmark", text: t.description } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const t = await taskBy(c, idOf(ref));
      if (!t) throw new ProviderError("notFound", `Todoist: no task ${ref.key}`);
      const url = `${WEB}/app/task/${t.id}`;
      if (t.checked) return [{ id: "reopen", name: "Reopen", to: OPEN, requirements: [], remoteUrl: url }];
      const s = shapeOf(x);
      const sections = (await tdAll<TodoistSection>(c, "/sections", { project_id: t.project_id })).rows;
      return [
        { id: "complete", name: "Complete", to: COMPLETED, requirements: [], remoteUrl: url },
        // Any other section of the task's project, from any section: Todoist has no transition table.
        ...[...sections]
          .sort((a, b) => a.section_order - b.section_order)
          .filter((sec) => sec.id !== t.section_id)
          .map<Transition>((sec) => ({ id: `section:${sec.id}`, name: sec.name, to: sectionStatus(s, sec), requirements: [], remoteUrl: url })),
        ...(t.section_id ? [{ id: "section:none", name: "No section", to: OPEN, requirements: [], remoteUrl: url } satisfies Transition] : []),
      ];
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const id = encodeURIComponent(idOf(ref));
      if (transitionId === "complete") await tdDo(c, `/tasks/${id}/close`);
      else if (transitionId === "reopen") await tdDo(c, `/tasks/${id}/reopen`);
      else if (transitionId.startsWith("section:")) {
        const to = transitionId.slice("section:".length);
        const t = await taskBy(c, idOf(ref));
        if (!t) throw new ProviderError("notFound", `Todoist: no task ${ref.key}`);
        // Out of every section: moved to its own project's root.
        await tdDo(c, `/tasks/${id}/move`, { body: to === "none" ? { project_id: t.project_id } : { section_id: to } });
      } else throw new ProviderError("invalid", `Todoist: no transition ${transitionId}`);
      // Closing a recurring task leaves it open with its next due date: the task as it is now is the answer.
      return issueBy(x, c, idOf(ref));
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const w = worldOf(x, c);
      const projectId = ref.container?.remoteId ?? (await taskBy(c, idOf(ref)))?.project_id ?? null;
      const rows = (await tdAll<TodoistComment>(c, "/comments", { task_id: idOf(ref) })).rows.filter((r) => !r.is_deleted);
      const out: RemoteComment[] = [];
      for (const r of [...rows].sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.id.localeCompare(b.id))) {
        out.push(toRemoteComment(r, r.posted_uid ? await personOf(w, r.posted_uid, projectId) : { remoteId: "", name: "", avatarUrl: null }));
      }
      return out;
    },
    async add(x, ref, body) {
      const c = await credsOf(x);
      const cm = await tdOk<TodoistComment>(c, "/comments", { method: "POST", body: { task_id: idOf(ref), content: body } });
      const w = worldOf(x, c);
      return { comment: toRemoteComment(cm, cm.posted_uid ? await personOf(w, cm.posted_uid, ref.container?.remoteId ?? null) : { remoteId: "", name: "", avatarUrl: null }), warnings: [] };
    },
  },

  async statusHistory(x, ref) {
    const c = await credsOf(x);
    const t = await taskBy(c, idOf(ref));
    if (!t) throw new ProviderError("notFound", `Todoist: no task ${ref.key}`);
    const [sections, activity] = await Promise.all([
      tdAll<TodoistSection>(c, "/sections", { project_id: t.project_id }),
      tdAll<TodoistActivity>(c, "/activities", { object_type: "item", object_id: t.id, limit: 100 }),
    ]);
    return replayStatus(shapeOf(x), t, sections.rows, activity.rows);
  },

  async history(x, ref) {
    const c = await credsOf(x);
    const w = worldOf(x, c);
    // Activities page by 100, not 200; kept for as long as the plan keeps them (a week on the free one).
    const rows = (await tdAll<TodoistActivity>(c, "/activities", { object_type: "item", object_id: idOf(ref), limit: 100 })).rows;
    const out: RemoteChange[] = [];
    for (const a of rows) out.push(...(await toChanges(w, a)));
    return out.sort((a, b) => a.at - b.at);
  },
};

// ---------- Webhooks ----------

/**
 * Todoist's webhooks: `X-Todoist-Hmac-SHA256` is the base64 HMAC-SHA256 of
 * the raw body under the app's client secret (not a secret chosen per
 * webhook). `X-Todoist-Delivery-ID` is the same on a retry; the body says
 * when the event happened (`triggered_at`). The raw body, never a
 * re-serialized one.
 */
export const todoistWebhook = {
  sign(secret: string, rawBody: string): string {
    return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  },
  verify(a: { secret: string; rawBody: string; headers: Record<string, string> | Headers }): boolean {
    const given = a.headers instanceof Headers ? a.headers.get("x-todoist-hmac-sha256") : Object.entries(a.headers).find(([k]) => k.toLowerCase() === "x-todoist-hmac-sha256")?.[1];
    return !!a.secret && !!given && sameSecret(given, todoistWebhook.sign(a.secret, a.rawBody));
  },
  body(rawBody: string): { event_name?: unknown; triggered_at?: unknown } | null {
    try {
      const b: unknown = JSON.parse(rawBody);
      return b && typeof b === "object" && !Array.isArray(b) ? b : null;
    } catch {
      return null;
    }
  },
  sentAt(rawBody: string): Instant | null {
    const d = todoistWebhook.body(rawBody)?.triggered_at;
    return typeof d === "string" ? instantFrom(d) : null;
  },
  /** Which of the declared events it is; null for events inkledger doesn't read. */
  event(rawBody: string): "issueChanged" | "issueRemoved" | "commentAdded" | null {
    const name = todoistWebhook.body(rawBody)?.event_name;
    if (name === "note:added") return "commentAdded";
    if (name === "item:deleted") return "issueRemoved";
    return name === "item:added" || name === "item:updated" || name === "item:completed" || name === "item:uncompleted" ? "issueChanged" : null;
  },
};
