// A Wrike in memory, for tests: the API v4 endpoints the adapter calls, written
// from Wrike's documentation (not recorded from a real server), with its
// shapes and traps:
// - `bearer <token>` or 401 not_authorized; 429 with Retry-After; errors as { error, errorDescription };
// - every answer is { kind, data: [...] }, a single record too; ids in the path may be a
//   comma-separated list (up to 100);
// - the values of `fields`, `responsibles`, `status` and `updatedDate` are JSON in the query string;
//   a date filter is UTC to the second ("2026-10-21T08:00:00Z"), milliseconds are refused;
// - a task has the default fields only (id, title, status, customStatusId, importance, dates, dates of
//   creation and update, scope, permalink); description, parentIds, responsibleIds… are asked for;
// - ids: the API id (16 letters and digits) is not the number in a task's permalink (open.htm?id=…),
//   which GET /ids converts (only the ones it knows);
// - pageSize up to 1000 and nextPageToken, only when pageSize is given; a token is good for its own
//   query and expires;
// - task dates are floating local times without a zone ("2026-11-05T17:00:00"), instants are UTC;
// - a deleted task goes to the recycle bin: out of lists, still answered by id with scope RbTask,
//   listed by deleted=true;
// - statuses: a task's status is a custom status of its folder's workflow, whose group (Active,
//   Completed, Deferred, Cancelled) is the task's `status`; a status of another workflow is refused,
//   and so is a hidden one; folders can have their own workflow;
// - a task is in several folders (parentIds) or none; moving it keeps its id;
// - comments are HTML: a newline is not a break, tags outside a short list are silently stripped;
// - timelogs: decimal hours (at most 24, kept to two decimals), a tracked day, billable or not, a
//   category; an approved or pending one is locked (403), other people's are read-only.
import { createHmac } from "node:crypto";

type Rec = Record<string, unknown>;
type Group = "Active" | "Completed" | "Deferred" | "Cancelled";
export type SimContact = { id: string; firstName: string; lastName: string; email: string; avatarUrl: string | null };
export type SimStatus = { id: string; name: string; group: Group; hidden: boolean };
export type SimWorkflow = { id: string; name: string; statuses: SimStatus[] };
export type SimFolder = { id: string; title: string; workflow: string; project: boolean; access: boolean };
type SimComment = { id: string; author: string; text: string; created: number };
export type SimTask = {
  id: string;
  /** The number in the permalink */
  num: number;
  title: string;
  description: string;
  status: SimStatus;
  importance: "High" | "Normal" | "Low";
  created: number;
  updated: number;
  completed: number | null;
  dates: { type: string; start?: string; due?: string; duration?: number } | null;
  parentIds: string[];
  superTaskIds: string[];
  responsibleIds: string[];
  authorIds: string[];
  followerIds: Set<string>;
  effort: number | null;
  deleted: boolean;
  comments: SimComment[];
};
export type SimTimelog = {
  id: string;
  taskId: string;
  userId: string;
  /** Hours as kept: two decimals */
  hours: number;
  trackedDate: string;
  comment: string;
  categoryId: string | null;
  billingType: "Billable" | "NonBillable";
  approval: "Draft" | "Pending" | "Approved" | "Rejected";
  created: number;
  updated: number;
};

const ALLOWED_TAGS = new Set(["a", "b", "i", "u", "strike", "ul", "ol", "li", "br", "code"]);
const BASE_FIELDS = ["id", "accountId", "title", "status", "customStatusId", "importance", "createdDate", "updatedDate", "dates", "scope", "permalink"];

class Refuse extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function wrikeSimulator(apiBase = "https://www.wrike.com/api/v4") {
  const token = "wrike-permanent-token-simulated";
  const web = apiBase.replace(/\/api\/v4$/, "");
  const accountId = "IEAAJKV3";
  let seq = 0;
  /** 16 letters and digits: the prefix, then a counter */
  const apiId = (prefix: string) => `${prefix}${(++seq).toString(36).toUpperCase().padStart(Math.max(1, 12 - prefix.length), "0")}`.padEnd(16, "A").slice(0, 16);
  let nextNum = 4_000_100_000;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  /** UTC to the second, as Wrike prints it */
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
  const state = { exhausted: false, calls: 0, revoked: false, epoch: 0 };

  // ---------- Data ----------

  const contacts = new Map<string, SimContact>();
  const addUser = (first: string, last: string, email = `${first.toLowerCase()}@acme.example`): SimContact => {
    const u: SimContact = { id: apiId("KUAJ"), firstName: first, lastName: last, email, avatarUrl: null };
    contacts.set(u.id, u);
    return u;
  };
  const me = addUser("Mario", "Rossi", "mario@acme.example");
  me.avatarUrl = "https://www.wrike.com/avatars/mario.png";
  const anna = addUser("Anna", "Bianchi");

  const workflows: SimWorkflow[] = [];
  const addWorkflow = (name: string, statuses: [string, Group, boolean?][]): SimWorkflow => {
    const w: SimWorkflow = { id: apiId("IEAAJKV3JM"), name, statuses: statuses.map(([n, group, hidden]) => ({ id: apiId("IEAAJKV3JM"), name: n, group, hidden: hidden ?? false })) };
    workflows.push(w);
    return w;
  };
  const standard = addWorkflow("Default Workflow", [
    ["New", "Active"],
    ["In Progress", "Active"],
    ["Old stage", "Active", true],
    ["On Hold", "Deferred"],
    ["Completed", "Completed"],
    ["Cancelled", "Cancelled"],
  ]);
  const statusNamed = (w: SimWorkflow, name: string) => {
    const s = w.statuses.find((x) => x.name === name);
    if (!s) throw new Error(`no status ${name} in ${w.name}`);
    return s;
  };
  const workflowOfStatus = (id: string) => workflows.find((w) => w.statuses.some((s) => s.id === id));

  const folders = new Map<string, SimFolder>();
  const folder = (title: string, o: { workflow?: SimWorkflow; project?: boolean; access?: boolean } = {}): SimFolder => {
    const known = [...folders.values()].find((f) => f.title === title);
    if (known) return known;
    const f: SimFolder = { id: apiId("IEAAJKV3I"), title, workflow: (o.workflow ?? standard).id, project: o.project ?? false, access: o.access ?? true };
    folders.set(f.id, f);
    return f;
  };

  const tasks: SimTask[] = [];
  const timelogs: SimTimelog[] = [];
  const categories = new Map<string, { id: string; name: string; hidden: boolean }>();
  const category = (name: string, hidden = false) => {
    const c = { id: apiId("IEAAJKV3C"), name, hidden };
    categories.set(c.id, c);
    return c;
  };

  const workflowOfTask = (t: Pick<SimTask, "parentIds">) => workflows.find((w) => w.id === folders.get(t.parentIds[0] ?? "")?.workflow) ?? standard;

  const add = (
    title: string,
    o: { folder?: SimFolder | SimFolder[]; responsible?: string[]; description?: string; status?: string; importance?: SimTask["importance"]; dueAt?: string; startAt?: string; author?: string; parent?: SimTask; effort?: number; milestone?: boolean } = {},
  ): SimTask => {
    const at = earlier();
    const parents = o.folder ? (Array.isArray(o.folder) ? o.folder : [o.folder]) : [];
    const wf = workflows.find((w) => w.id === (parents[0]?.workflow ?? standard.id)) ?? standard;
    const status = o.status ? statusNamed(wf, o.status) : wf.statuses.find((s) => s.group === "Active" && !s.hidden)!;
    const t: SimTask = {
      id: apiId("IEAAJKV3KQ"),
      num: (nextNum += 7),
      title,
      description: o.description ?? "",
      status,
      importance: o.importance ?? "Normal",
      created: at,
      updated: at,
      completed: status.group === "Completed" ? at : null,
      dates: o.milestone ? { type: "Milestone", due: o.dueAt } : o.dueAt || o.startAt ? { type: "Planned", ...(o.startAt ? { start: o.startAt } : {}), ...(o.dueAt ? { due: o.dueAt } : {}) } : { type: "Backlog" },
      parentIds: parents.map((f) => f.id),
      superTaskIds: o.parent ? [o.parent.id] : [],
      responsibleIds: o.responsible ?? [me.id],
      authorIds: [o.author ?? me.id],
      followerIds: new Set(),
      effort: o.effort ?? null,
      deleted: false,
      comments: [],
    };
    tasks.push(t);
    return t;
  };
  const keyOf = (t: SimTask) => `WRIKE-${t.num}`;
  const permalinkOf = (t: SimTask) => `${web}/open.htm?id=${t.num}`;
  const taskById = (id: string) => tasks.find((t) => t.id === id);
  const visible = (t: SimTask): boolean => t.responsibleIds.includes(me.id) || t.parentIds.length === 0 || t.parentIds.some((p) => folders.get(p)?.access);

  const touch = (t: SimTask) => {
    t.updated = now();
  };
  const setStatus = (t: SimTask, s: SimStatus) => {
    t.status = s;
    t.completed = s.group === "Completed" ? now() : null;
    touch(t);
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign(t: SimTask, users: string[]) {
      t.responsibleIds = users;
      touch(t);
    },
    setStatus(t: SimTask, name: string) {
      setStatus(t, statusNamed(workflowOfTask(t), name));
    },
    retitle(t: SimTask, title: string) {
      t.title = title;
      touch(t);
    },
    comment(t: SimTask, html: string, by = anna.id) {
      t.comments.push({ id: apiId("IEAAJKV3M"), author: by, text: html, created: now() });
      touch(t);
    },
    moveToFolders(t: SimTask, to: SimFolder[]) {
      t.parentIds = to.map((f) => f.id);
      touch(t);
    },
    renameFolder(f: SimFolder, title: string) {
      f.title = title;
      for (const t of tasks.filter((x) => x.parentIds.includes(f.id))) touch(t);
    },
    /** The workflow of a folder changes: its tasks keep their status id until Wrike maps them (here: left as they are). */
    workflow(f: SimFolder, w: SimWorkflow) {
      f.workflow = w.id;
    },
    due(t: SimTask, due: string | null) {
      t.dates = due ? { type: "Planned", ...(t.dates?.start ? { start: t.dates.start } : {}), due } : { type: "Backlog" };
      touch(t);
    },
    /** To the recycle bin. */
    delete(t: SimTask) {
      t.deleted = true;
      touch(t);
    },
    restore(t: SimTask) {
      t.deleted = false;
      touch(t);
    },
    access(f: SimFolder, on: boolean) {
      f.access = on;
    },
    approve(l: SimTimelog) {
      l.approval = "Approved";
    },
    submit(l: SimTimelog) {
      l.approval = "Pending";
    },
    reject(l: SimTimelog) {
      l.approval = "Rejected";
    },
    /** Someone deletes a contact: Wrike keeps it, flagged. */
    deleteUser(id: string) {
      contacts.delete(id);
    },
  };

  const log = (t: SimTask, o: { hours: number; trackedDate: string; user?: string; comment?: string; category?: string; billingType?: SimTimelog["billingType"] }) => {
    const at = now();
    const l: SimTimelog = {
      id: apiId("IEAAJKV3T"),
      taskId: t.id,
      userId: o.user ?? me.id,
      hours: Math.round(o.hours * 100) / 100,
      trackedDate: o.trackedDate,
      comment: o.comment ?? "",
      categoryId: o.category ?? null,
      billingType: o.billingType ?? "NonBillable",
      approval: "Draft",
      created: at,
      updated: at,
    };
    timelogs.push(l);
    touch(t);
    return l;
  };

  // ---------- Shapes ----------

  const contactRec = (c: SimContact): Rec => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, type: "Person", avatarUrl: c.avatarUrl ?? "https://www.wrike.com/avatars/default.png", profiles: [{ accountId, email: c.email, role: "User" }], deleted: false });
  const taskRec = (t: SimTask, fields: Set<string>): Rec => {
    const all: Rec = {
      id: t.id,
      accountId,
      title: t.title,
      status: t.status.group,
      customStatusId: t.status.id,
      importance: t.importance,
      createdDate: iso(t.created),
      updatedDate: iso(t.updated),
      ...(t.completed === null ? {} : { completedDate: iso(t.completed) }),
      dates: t.dates ?? {},
      scope: t.deleted ? "RbTask" : "WsTask",
      permalink: permalinkOf(t),
      description: t.description,
      parentIds: t.parentIds,
      superParentIds: t.parentIds,
      superTaskIds: t.superTaskIds,
      responsibleIds: t.responsibleIds,
      authorIds: t.authorIds,
      followerIds: [...t.followerIds],
      effortAllocation: t.effort === null ? null : { mode: "Basic", totalEffort: t.effort },
    };
    const wanted = new Set([...BASE_FIELDS, ...fields, ...(t.completed === null ? [] : ["completedDate"])]);
    return Object.fromEntries(Object.entries(all).filter(([k]) => wanted.has(k)));
  };
  const timelogRec = (l: SimTimelog): Rec => ({
    id: l.id,
    taskId: l.taskId,
    userId: l.userId,
    categoryId: l.categoryId,
    billingType: l.billingType,
    hours: l.hours,
    trackedDate: l.trackedDate,
    createdDate: iso(l.created),
    updatedDate: iso(l.updated),
    comment: l.comment,
    approvalStatus: l.approval,
  });

  /** Wrike keeps a short list of tags in a comment and drops the others, keeping their text. */
  const sanitized = (html: string) =>
    html.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (_all, close: string, name: string, rest: string) => {
      const n = name.toLowerCase();
      if (!ALLOWED_TAGS.has(n)) return "";
      return n === "br" ? "<br />" : n === "a" && !close ? `<a${rest}>` : `<${close}${n}>`;
    });

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json({ errorDescription: message, error: code }, status, headers);
  const list = (kind: string, data: Rec[], extra: Rec = {}) => json({ kind, data, ...extra });

  const parseJson = <T>(name: string, text: string | null): T | undefined => {
    if (text === null) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Refuse(400, "invalid_parameter", `Invalid parameter ${name}: not JSON`);
    }
  };

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
    state.calls++;

    if (!/^bearer /i.test(headers.get("authorization") ?? "") || headers.get("authorization")?.slice(7) !== token || state.revoked) return fail(401, "not_authorized", "Access token is invalid or expired");
    if (state.exhausted) return fail(429, "too_many_requests", "Rate limit exceeded", { "Retry-After": "30" });
    const path = url.pathname.slice(apiPath.length);
    // Parameters come from the query and, for a write, the form body.
    const p = new URLSearchParams(url.search);
    if (typeof init?.body === "string") for (const [k, v] of new URLSearchParams(init.body)) p.set(k, v);
    try {
      return route(method, path, p);
    } catch (e) {
      if (e instanceof Refuse) return fail(e.status, e.code, e.message);
      throw e;
    }
  }

  function route(method: string, path: string, p: URLSearchParams): Response {
    const fieldsParam = parseJson<string[]>("fields", p.get("fields")) ?? [];
    const fields = new Set(fieldsParam);

    /** pageSize 1-1000 and a token good for this query (same epoch). Without pageSize: the first 1000, no token. */
    const paged = (kind: string, rows: Rec[]): Response => {
      const sizeText = p.get("pageSize");
      const size = sizeText === null ? 1000 : Number(sizeText);
      if (!Number.isInteger(size) || size < 1 || size > 1000) throw new Refuse(400, "invalid_parameter", "Invalid parameter pageSize: must be between 1 and 1000");
      const sig = [path, ...[...p.entries()].filter(([k]) => k !== "nextPageToken" && k !== "pageSize").map(([k, v]) => `${k}=${v}`).sort()].join("&");
      let from = 0;
      const given = p.get("nextPageToken");
      if (given) {
        try {
          const o = JSON.parse(Buffer.from(given, "base64url").toString()) as { from: number; sig: string; epoch: number };
          if (o.epoch !== state.epoch) throw new Refuse(400, "invalid_parameter", "Invalid parameter nextPageToken: expired");
          if (o.sig !== sig) throw new Refuse(400, "invalid_parameter", "Invalid parameter nextPageToken: not for this request");
          from = o.from;
        } catch (e) {
          if (e instanceof Refuse) throw e;
          throw new Refuse(400, "invalid_parameter", "Invalid parameter nextPageToken");
        }
      }
      const end = Math.min(rows.length, from + size);
      const nextPageToken = sizeText !== null && end < rows.length ? Buffer.from(JSON.stringify({ from: end, sig, epoch: state.epoch })).toString("base64url") : undefined;
      return list(kind, rows.slice(from, end), { responseSize: end - from, ...(nextPageToken ? { nextPageToken } : {}) });
    };

    const idsOf = (text: string) => decodeURIComponent(text).split(",").filter(Boolean);
    const day = (name: string, v: string | null): string | null => {
      if (v === null) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Refuse(400, "invalid_parameter", `Invalid parameter ${name}: a date (yyyy-MM-dd)`);
      return v;
    };
    /** { start, end } of a date filter: UTC, to the second. */
    const range = (name: string): { start: number; end: number } | null => {
      const r = parseJson<{ start?: string; end?: string }>(name, p.get(name));
      if (!r) return null;
      const one = (v: string | undefined, fallback: number) => {
        if (v === undefined) return fallback;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) throw new Refuse(400, "invalid_parameter", `Invalid parameter ${name}: dates are yyyy-MM-dd'T'HH:mm:ss'Z'`);
        return Date.parse(v);
      };
      return { start: one(r.start, 0), end: one(r.end, Number.MAX_SAFE_INTEGER) };
    };
    const inRange = (at: number, r: { start: number; end: number } | null) => !r || (sec(at) >= r.start && sec(at) <= r.end);

    if (path === "/contacts" && method === "GET") {
      if (p.get("me") === "true") return list("contacts", [contactRec(me)]);
      return paged("contacts", [...contacts.values()].map(contactRec));
    }
    let m = /^\/contacts\/([^/]+)$/.exec(path);
    if (m && method === "GET") return list("contacts", idsOf(m[1]).flatMap((id) => (contacts.get(id) ? [contactRec(contacts.get(id)!)] : [])));

    if (path === "/workflows") {
      return list(
        "workflows",
        workflows.map((w) => ({ id: w.id, name: w.name, standard: w === standard, hidden: false, customStatuses: w.statuses.map((s) => ({ id: s.id, name: s.name, standardName: false, color: "Blue", standard: false, group: s.group, hidden: s.hidden })) })),
      );
    }

    m = /^\/folders\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const ids = idsOf(m[1]);
      if (ids.length > 100) throw new Refuse(400, "invalid_parameter", "Too many ids (100 at most)");
      return list(
        "folderTree",
        ids.flatMap((id) => {
          const f = folders.get(id);
          return f && f.access ? [{ id: f.id, accountId, title: f.title, scope: "WsFolder", ...(f.project ? { project: { authorId: me.id, status: "Green" } } : {}) }] : [];
        }),
      );
    }

    if (path === "/ids" && method === "GET") {
      if (p.get("type") !== "ApiV2Task") throw new Refuse(400, "invalid_parameter", "Invalid parameter type");
      const ids = parseJson<number[]>("ids", p.get("ids"));
      if (!Array.isArray(ids) || ids.some((n) => typeof n !== "number")) throw new Refuse(400, "invalid_parameter", "Invalid parameter ids: a JSON list of numbers");
      if (ids.length > 100) throw new Refuse(400, "invalid_parameter", "Too many ids (100 at most)");
      return list("ids", ids.flatMap((n) => (tasks.find((t) => t.num === n) ? [{ id: tasks.find((t) => t.num === n)!.id, uid: n }] : [])));
    }

    if (path === "/tasks" && method === "GET") {
      const responsibles = parseJson<string[]>("responsibles", p.get("responsibles"));
      const status = parseJson<Group[]>("status", p.get("status"));
      const updated = range("updatedDate");
      const title = p.get("title")?.toLowerCase();
      const bin = p.get("deleted") === "true";
      let rows = tasks
        .filter((t) => t.deleted === bin && visible(t))
        .filter((t) => !responsibles || responsibles.some((r) => t.responsibleIds.includes(r)))
        .filter((t) => !status || status.includes(t.status.group))
        .filter((t) => inRange(t.updated, updated))
        .filter((t) => title === undefined || t.title.toLowerCase().includes(title));
      const sortField = p.get("sortField");
      if (sortField === "UpdatedDate") rows = rows.sort((a, b) => sec(a.updated) - sec(b.updated) || a.id.localeCompare(b.id));
      else rows = rows.sort((a, b) => a.id.localeCompare(b.id));
      if (p.get("sortOrder") === "Desc") rows = rows.reverse();
      return paged(
        "tasks",
        rows.map((t) => taskRec(t, fields)),
      );
    }

    m = /^\/tasks\/([^/]+)$/.exec(path);
    if (m) {
      const ids = idsOf(m[1]);
      if (ids.length > 100) throw new Refuse(400, "invalid_parameter", "Too many ids (100 at most)");
      if (ids.some((id) => !/^[A-Z0-9]{16}$/.test(id))) throw new Refuse(400, "invalid_parameter", "Invalid task id");
      const found = ids.map((id) => taskById(id));
      if (found.some((t) => !t)) throw new Refuse(404, "resource_not_found", "Resource Not Found");
      const ts = found as SimTask[];
      if (ts.some((t) => !visible(t))) throw new Refuse(403, "access_forbidden", "Access Forbidden");
      if (method === "PUT") {
        const t = ts[0];
        const custom = p.get("customStatus");
        if (custom) {
          const w = workflowOfTask(t);
          const s = w.statuses.find((x) => x.id === custom);
          if (!s) throw new Refuse(400, "invalid_parameter", "Invalid parameter customStatus: not a status of the task's workflow");
          if (s.hidden) throw new Refuse(400, "invalid_parameter", "Invalid parameter customStatus: the status is hidden");
          setStatus(t, s);
        }
        for (const [param, add] of [["addFollowers", true], ["removeFollowers", false]] as const) {
          const who = parseJson<string[]>(param, p.get(param));
          for (const f of who ?? []) {
            if (add) t.followerIds.add(f);
            else t.followerIds.delete(f);
          }
        }
        if (p.get("title")) t.title = p.get("title")!;
        touch(t);
        return list("tasks", [taskRec(t, fields)]);
      }
      return list(
        "tasks",
        ts.map((t) => taskRec(t, fields)),
      );
    }

    m = /^\/tasks\/([^/]+)\/comments$/.exec(path);
    if (m) {
      const t = taskById(m[1]);
      if (!t) throw new Refuse(404, "resource_not_found", "Resource Not Found");
      if (!visible(t)) throw new Refuse(403, "access_forbidden", "Access Forbidden");
      const rec = (c: SimComment): Rec => ({ id: c.id, authorId: c.author, text: c.text, updatedDate: iso(c.created), createdDate: iso(c.created), taskId: t.id });
      if (method === "POST") {
        const text = p.get("text");
        if (!text) throw new Refuse(400, "invalid_parameter", "Invalid parameter text: required");
        const c: SimComment = { id: apiId("IEAAJKV3M"), author: me.id, text: p.get("plainText") === "true" ? text : sanitized(text), created: now() };
        t.comments.push(c);
        touch(t);
        return list("comments", [rec(c)]);
      }
      return list("comments", [...t.comments].sort((a, b) => a.created - b.created).map(rec));
    }

    m = /^\/tasks\/([^/]+)\/timelogs$/.exec(path);
    if (m) {
      const t = taskById(m[1]);
      if (!t) throw new Refuse(404, "resource_not_found", "Resource Not Found");
      if (!visible(t)) throw new Refuse(403, "access_forbidden", "Access Forbidden");
      if (method === "POST") {
        const l = writeLog(null, t, p, day);
        return list("timelogs", [timelogRec(l)]);
      }
      return list("timelogs", timelogs.filter((l) => l.taskId === t.id).map(timelogRec));
    }

    if (path === "/timelogs" && method === "GET") {
      const updated = range("updatedDate");
      const mine = p.get("me") === "true";
      return list(
        "timelogs",
        timelogs
          .filter((l) => (!mine || l.userId === me.id) && inRange(l.updated, updated) && visible(taskById(l.taskId)!))
          .sort((a, b) => a.updated - b.updated)
          .map(timelogRec),
      );
    }

    m = /^\/timelogs\/([^/]+)$/.exec(path);
    if (m) {
      const l = timelogs.find((x) => x.id === m[1]);
      const t = l && taskById(l.taskId);
      if (!l || !t) throw new Refuse(404, "resource_not_found", "Resource Not Found");
      if (!visible(t)) throw new Refuse(403, "access_forbidden", "Access Forbidden");
      if (method !== "GET") {
        if (l.userId !== me.id) throw new Refuse(403, "access_forbidden", "You can only change your own timelogs");
        if (l.approval === "Approved" || l.approval === "Pending") throw new Refuse(403, "access_forbidden", `The timelog is ${l.approval === "Approved" ? "approved" : "waiting for approval"} and cannot be changed`);
      }
      if (method === "DELETE") {
        timelogs.splice(timelogs.indexOf(l), 1);
        touch(t);
        return list("timelogs", []);
      }
      if (method === "PUT") writeLog(l, t, p, day);
      return list("timelogs", [timelogRec(l)]);
    }

    if (path === "/timelog_categories") return list("timelogCategories", [...categories.values()].map((c) => ({ id: c.id, name: c.name, order: 0, hidden: c.hidden })));

    throw new Refuse(404, "resource_not_found", `unmocked ${method} ${path}`);
  }

  /** Creates (no log) or changes a timelog from form parameters, as Wrike checks them. */
  function writeLog(l: SimTimelog | null, t: SimTask, p: URLSearchParams, day: (name: string, v: string | null) => string | null): SimTimelog {
    const hoursText = p.get("hours");
    const hours = hoursText === null ? null : Number(hoursText);
    if (l === null && hours === null) throw new Refuse(400, "invalid_parameter", "Invalid parameter hours: required");
    if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24)) throw new Refuse(400, "invalid_parameter", "Invalid parameter hours: more than 0, at most 24");
    const tracked = day("trackedDate", p.get("trackedDate"));
    const cat = p.get("categoryId");
    if (cat && !categories.has(cat)) throw new Refuse(400, "invalid_parameter", "Invalid parameter categoryId: unknown category");
    const bill = p.get("billingType");
    if (bill !== null && bill !== "Billable" && bill !== "NonBillable") throw new Refuse(400, "invalid_parameter", "Invalid parameter billingType");
    const target =
      l ?? log(t, { hours: hours ?? 1, trackedDate: tracked ?? new Date(now()).toISOString().slice(0, 10), comment: p.get("comment") ?? "", ...(cat ? { category: cat } : {}), ...(bill ? { billingType: bill } : {}) });
    if (l) {
      if (hours !== null) l.hours = Math.round(hours * 100) / 100;
      if (tracked) l.trackedDate = tracked;
      if (p.get("comment") !== null) l.comment = p.get("comment")!;
      if (cat !== null) l.categoryId = cat || null;
      if (bill) l.billingType = bill;
      l.updated = now();
      touch(t);
    }
    return target;
  }

  // ---------- Webhooks ----------

  type SimEvent = { eventType: string; taskId?: string; commentId?: string; timelogId?: string };
  /** A delivery as Wrike sends it: a list of events, the body signed in X-Hook-Secret (hex HMAC-SHA256 under the webhook's secret). */
  const webhook = (events: SimEvent[], o: { secret: string; signedWith?: string; ageMs?: number }) => {
    const at = iso(Date.now() - (o.ageMs ?? 0));
    const rawBody = JSON.stringify(events.map((e) => ({ webhookId: "IEAAJKV3WH000001", eventAuthorId: me.id, lastUpdatedDate: at, ...e })));
    return { rawBody, headers: { "x-hook-secret": createHmac("sha256", o.signedWith ?? o.secret).update(rawBody, "utf8").digest("hex"), "content-type": "application/json" } };
  };

  return {
    apiBase,
    web,
    token,
    accountId,
    me,
    anna,
    contacts,
    workflows,
    standard,
    folders,
    tasks,
    timelogs,
    categories,
    state,
    addUser,
    addWorkflow,
    statusNamed,
    workflowOfStatus,
    folder,
    category,
    add,
    log,
    outside,
    keyOf,
    permalinkOf,
    webhook,
    /** Every call from now on is refused as over the limit (429, Retry-After 30). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    /** Every page token handed out so far stops working (400). */
    expireTokens: () => state.epoch++,
    fetch: handle,
  };
}
