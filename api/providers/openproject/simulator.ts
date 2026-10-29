// An OpenProject in memory, for tests: the API v3 endpoints the adapter calls,
// written from OpenProject's documentation (not from a real server: see
// SPIKES.md, OpenProject). Models its traps on purpose:
// - HAL+JSON: collections are `{ total, count, pageSize, offset, _embedded:
//   { elements } }`, and `offset` is a PAGE NUMBER from 1, not a row offset;
//   `pageSize` is cut to the server's cap, and the answer says the size used;
// - a work package list asked with no `filters` silently keeps only the open
//   ones; `filters` and `sortBy` are JSON in the query string, and an unknown
//   filter is a 400;
// - links are relative paths (with the context path of a sub-URI install in
//   front); an unassigned work package has `assignee: { href: null }`;
// - ids are global to the instance (the key `#12` is the id) and survive a
//   move between projects; a work package the user can't see is a 404, never
//   a 403; a deleted one is a 404 too;
// - changing a work package needs its current `lockVersion` (missing: 422,
//   stale: 409); the status it may go to is what the workflow allows, shown
//   by the form (a list of resources or of links, per `allowedAs`);
// - dates in a filter written without a time are days in the requesting
//   user's zone; with a time they are instants; `spentOn`/`dueDate` are plain
//   dates; `createdAt`/`updatedAt` are UTC instants;
// - durations are ISO 8601 ("PT1H30M"); a time entry's comment is at most 255
//   characters; logging time needs the right to (403), logging for someone
//   else another (403); who logged an entry can't be changed (422);
// - activities (comments and changes) share one list, a revision among them;
//   a change is only text, in the user's language, with HTML in it;
// - an authentication that fails is a 401 with a `WWW-Authenticate` challenge,
//   and a server open to the public may answer as the anonymous account.
import { createHmac } from "node:crypto";
import { isoDuration } from "../core/time";

export type SimUser = { id: number; name: string; login: string; email?: string; avatar?: string };
type SimStatus = { id: number; name: string; isClosed: boolean; position: number; color: string };
type SimProject = { id: number; identifier: string; name: string; hidden: boolean; timeTracking: boolean; logTime: boolean; disabledActivities: Set<number> };
type SimDetail = { html: string };
type SimActivityItem = { id: number; kind: "comment" | "revision"; comment: string; details: SimDetail[]; createdAt: number; userId: number };
export type SimWorkPackage = {
  id: number;
  lockVersion: number;
  project: SimProject;
  subject: string;
  description: string;
  type: { id: number; name: string };
  statusId: number;
  priority: { id: number; name: string; position: number } | null;
  authorId: number;
  assigneeId: number | null;
  parentId: number | null;
  startDate: string | null;
  dueDate: string | null;
  estimatedSeconds: number | null;
  createdAt: number;
  updatedAt: number;
  watchers: Set<number>;
  activities: SimActivityItem[];
};
export type SimTimeEntry = { id: number; wpId: number | null; projectId: number; userId: number; spentOn: string; seconds: number; comment: string; activityId: number; createdAt: number; updatedAt: number; lockVersion: number };

const DAY = 86_400_000;
const ISSUE_TYPES: Record<string, number> = { Task: 1, Milestone: 2, Phase: 3, Feature: 4, Epic: 5, "User story": 6, Bug: 7 };
const PRIORITIES = [
  { id: 7, name: "Low", position: 1 },
  { id: 8, name: "Normal", position: 2 },
  { id: 9, name: "High", position: 3 },
  { id: 10, name: "Immediate", position: 4 },
];
const DEFAULT_STATUSES: SimStatus[] = [
  { id: 1, name: "New", isClosed: false, position: 1, color: "#1098AD" },
  { id: 7, name: "In progress", isClosed: false, position: 2, color: "#40C057" },
  { id: 12, name: "On hold", isClosed: false, position: 3, color: "#FAB005" },
  { id: 13, name: "Closed", isClosed: true, position: 4, color: "#868E96" },
  { id: 14, name: "Rejected", isClosed: true, position: 5, color: "#E03131" },
];
const ACTIVITIES = [
  { id: 1, name: "Management", default: false },
  { id: 2, name: "Specification", default: false },
  { id: 3, name: "Development", default: true },
  { id: 4, name: "Testing", default: false },
];

const iso = (ms: number) => new Date(ms).toISOString();
const parseDuration = (text: unknown): number | null => {
  const m = typeof text === "string" ? /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(text) : null;
  return m && text !== "PT" ? Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : null;
};
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const idOfHref = (href: unknown) => (typeof href === "string" ? Number(/\/(\d+)$/.exec(href)?.[1]) || null : null);

type ParsedFilter = { name: string; operator: string; values: string[] };

export function openprojectSimulator(site = "https://op.example.com", me: SimUser = { id: 5, name: "Mario Rossi", login: "mrossi", email: "mario@example.com", avatar: "/users/5/avatar" }) {
  const web = site.replace(/\/+$/, "");
  const webPath = new URL(web).pathname.replace(/\/+$/, "");
  const apiBase = `${web}/api/v3`;
  const token = "op-sim-token";
  const tokens = new Set([token]);
  const users = new Map<number, SimUser>([[me.id, me]]);
  const statuses: SimStatus[] = DEFAULT_STATUSES.map((s) => ({ ...s }));
  const projects = new Map<string, SimProject>();
  const workPackages: SimWorkPackage[] = [];
  const timeEntries: SimTimeEntry[] = [];
  const state = {
    clock: Date.now(),
    seq: 0,
    /** Page size when none is asked, and the cap the server never exceeds */
    defaultPageSize: 20,
    maxPageSize: 1000,
    /** The requesting user's zone, minutes east of UTC: how dates written without a time are read */
    userOffsetMinutes: 0,
    /** Elements carry `_embedded` (project, status, type, priority, people) */
    embed: true,
    /** "markdown" since 8.0; "textile" before */
    textFormat: "markdown",
    /** The form's allowed values as resources or as links (titles only) */
    allowedAs: "embedded" as "embedded" | "links",
    /** The right to log time for other users, and to see theirs */
    canLogForOthers: true,
    viewOthersTime: true,
    /** Whether time entries carry a lockVersion (the catalogue says they do; to verify) */
    timeEntryLockVersion: true,
    /** Workflow: from status id to the ids it may go to; null: any other status */
    workflow: null as Record<number, number[]> | null,
    /** A request that fails to authenticate is answered as the anonymous account on /users/me */
    anonymous: false,
    /** Requests seen, "METHOD path?query" */
    calls: [] as string[],
    onWorkPackageList: null as (() => void) | null,
  };
  const injected: { status: number; headers?: Record<string, string>; body?: unknown }[] = [];
  const tick = () => (state.clock += 1000);
  const next = () => ++state.seq;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/hal+json; charset=utf-8", ...headers } });
  const ERR = "urn:openproject-org:api:v3:errors:";
  const error = (status: number, identifier: string, message: string, headers: Record<string, string> = {}) => json({ _type: "Error", errorIdentifier: `${ERR}${identifier}`, message }, status, headers);
  const notFound = (what: string) => error(404, "NotFound", `The requested resource could not be found.${what ? ` (${what})` : ""}`);
  const invalid = (...errors: { attribute: string; message: string }[]) =>
    json(
      {
        _type: "Error",
        errorIdentifier: `${ERR}${errors.length > 1 ? "MultipleErrors" : "PropertyConstraintViolation"}`,
        message: errors.map((e) => e.message).join(" "),
        _embedded: {
          details: { attribute: errors[0].attribute },
          ...(errors.length > 1 ? { errors: errors.map((e) => ({ _type: "Error", errorIdentifier: `${ERR}PropertyConstraintViolation`, message: e.message, _embedded: { details: { attribute: e.attribute } } })) } : {}),
        },
      },
      422,
    );
  const denied = (message: string) => error(403, "MissingPermission", message);

  const href = (path: string) => `${webPath}/api/v3${path}`;
  const link = (path: string | null, title?: string, method?: string) => ({ href: path === null ? null : href(path), ...(title !== undefined ? { title } : {}), ...(method ? { method } : {}) });

  // ---------- Representations ----------

  const userRaw = (id: number | null) => {
    const u = id === null ? undefined : users.get(id);
    return u ? { _type: "User", id: u.id, name: u.name, login: u.login, ...(u.email ? { email: u.email } : {}), avatar: u.avatar ?? null, status: "active", _links: { self: link(`/users/${u.id}`, u.name) } } : null;
  };
  const statusRaw = (s: SimStatus) => ({ _type: "Status", id: s.id, name: s.name, isClosed: s.isClosed, isDefault: s.id === 1, isReadonly: false, position: s.position, color: s.color, _links: { self: link(`/statuses/${s.id}`, s.name) } });
  const statusOf = (id: number) => statuses.find((s) => s.id === id)!;
  const projectRaw = (p: SimProject) => ({ _type: "Project", id: p.id, identifier: p.identifier, name: p.name, active: true, _links: { self: link(`/projects/${p.id}`, p.name) } });
  const formatted = (raw: string) => ({ format: state.textFormat, raw, html: `<p>${escapeHtml(raw)}</p>` });
  const key = (w: SimWorkPackage) => `#${w.id}`;
  const spentOn = (w: SimWorkPackage) => timeEntries.filter((e) => e.wpId === w.id).reduce((n, e) => n + e.seconds, 0);

  const wpRaw = (w: SimWorkPackage) => {
    const type = { _type: "Type", id: w.type.id, name: w.type.name, isMilestone: w.type.name === "Milestone" };
    const priority = w.priority ? { _type: "Priority", id: w.priority.id, name: w.priority.name, position: w.priority.position } : null;
    return {
      _type: "WorkPackage",
      id: w.id,
      lockVersion: w.lockVersion,
      subject: w.subject,
      description: formatted(w.description),
      scheduleManually: false,
      startDate: w.startDate,
      dueDate: w.dueDate,
      estimatedTime: w.estimatedSeconds === null ? null : isoDuration(w.estimatedSeconds),
      // Only where the user may see time entries (the module is on in the project).
      ...(w.project.timeTracking ? { spentTime: isoDuration(spentOn(w)) } : {}),
      percentageDone: 0,
      createdAt: iso(w.createdAt),
      updatedAt: iso(w.updatedAt),
      ...(state.embed
        ? {
            _embedded: {
              project: projectRaw(w.project),
              status: statusRaw(statusOf(w.statusId)),
              type,
              ...(priority ? { priority } : {}),
              author: userRaw(w.authorId),
              ...(w.assigneeId !== null ? { assignee: userRaw(w.assigneeId) } : {}),
            },
          }
        : {}),
      _links: {
        self: link(`/work_packages/${w.id}`, w.subject),
        project: link(`/projects/${w.project.id}`, w.project.name),
        status: link(`/statuses/${w.statusId}`, statusOf(w.statusId).name),
        type: link(`/types/${w.type.id}`, w.type.name),
        ...(priority ? { priority: link(`/priorities/${priority.id}`, priority.name) } : {}),
        author: link(`/users/${w.authorId}`, users.get(w.authorId)?.name),
        assignee: w.assigneeId === null ? { href: null } : link(`/users/${w.assigneeId}`, users.get(w.assigneeId)?.name),
        ...(w.parentId !== null ? { parent: link(`/work_packages/${w.parentId}`) } : {}),
        addComment: link(`/work_packages/${w.id}/activities`, "Add comment", "post"),
        addWatcher: link(`/work_packages/${w.id}/watchers`, "Add watcher", "post"),
        update: link(`/work_packages/${w.id}/form`, "Update", "post"),
        updateImmediately: link(`/work_packages/${w.id}`, "Update immediately", "patch"),
      },
    };
  };

  const activityRaw = (w: SimWorkPackage, a: SimActivityItem) => ({
    _type: a.kind === "revision" ? "Activity::Revision" : a.comment ? "Activity::Comment" : "Activity",
    id: a.id,
    version: w.activities.indexOf(a) + 1,
    comment: formatted(a.comment),
    details: a.details.map((d) => ({ format: "markdown", raw: plain(d.html), html: d.html })),
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.createdAt),
    _links: { self: link(`/activities/${a.id}`), user: link(`/users/${a.userId}`, users.get(a.userId)?.name), workPackage: link(`/work_packages/${w.id}`, w.subject) },
  });
  const plain = (html: string) => html.replace(/<[^>]*>/g, "");

  const canEdit = (e: SimTimeEntry) => e.userId === me.id;
  const entryRaw = (e: SimTimeEntry) => {
    const p = [...projects.values()].find((x) => x.id === e.projectId)!;
    const wp = e.wpId === null ? undefined : workPackages.find((w) => w.id === e.wpId);
    const a = ACTIVITIES.find((x) => x.id === e.activityId)!;
    return {
      _type: "TimeEntry",
      id: e.id,
      comment: { format: "plain", raw: e.comment, html: `<p>${escapeHtml(e.comment)}</p>` },
      spentOn: e.spentOn,
      hours: isoDuration(e.seconds),
      ongoing: false,
      createdAt: iso(e.createdAt),
      updatedAt: iso(e.updatedAt),
      ...(state.timeEntryLockVersion ? { lockVersion: e.lockVersion } : {}),
      _links: {
        self: link(`/time_entries/${e.id}`),
        project: link(`/projects/${p.id}`, p.name),
        ...(wp ? { workPackage: link(`/work_packages/${wp.id}`, wp.subject) } : {}),
        user: link(`/users/${e.userId}`, users.get(e.userId)?.name),
        activity: link(`/time_entries/activities/${a.id}`, a.name),
        ...(canEdit(e) ? { update: link(`/time_entries/${e.id}/form`, "Update", "post"), updateImmediately: link(`/time_entries/${e.id}`, "Update immediately", "patch"), delete: link(`/time_entries/${e.id}`, "Delete", "delete") } : {}),
      },
    };
  };

  // ---------- Setup helpers ----------

  const addProject = (identifier: string, o: Partial<Pick<SimProject, "name" | "hidden" | "timeTracking" | "logTime">> & { disabledActivities?: number[] } = {}) => {
    const p: SimProject = {
      id: projects.size + 3,
      identifier,
      name: o.name ?? `Project ${identifier}`,
      hidden: o.hidden ?? false,
      timeTracking: o.timeTracking ?? true,
      logTime: o.logTime ?? true,
      disabledActivities: new Set(o.disabledActivities ?? []),
    };
    projects.set(identifier, p);
    return p;
  };
  const addUser = (u: SimUser) => void users.set(u.id, u);

  const add = (
    projectIdentifier: string,
    subject: string,
    o: { assignee?: number | null; status?: string; description?: string; type?: string; priority?: string; due?: string; start?: string; estimateSeconds?: number; parent?: number; updated?: number; author?: number } = {},
  ) => {
    const p = projects.get(projectIdentifier) ?? addProject(projectIdentifier);
    const at = tick();
    const status = statuses.find((s) => s.name === (o.status ?? "New"));
    if (!status) throw new Error(`no status ${o.status}`);
    const typeName = o.type ?? "Task";
    const w: SimWorkPackage = {
      id: next(),
      lockVersion: 0,
      project: p,
      subject,
      description: o.description ?? "",
      type: { id: ISSUE_TYPES[typeName] ?? 1, name: typeName },
      statusId: status.id,
      priority: o.priority ? (PRIORITIES.find((x) => x.name === o.priority) ?? null) : null,
      authorId: o.author ?? me.id,
      assigneeId: o.assignee === undefined ? me.id : o.assignee,
      parentId: o.parent ?? null,
      startDate: o.start ?? null,
      dueDate: o.due ?? null,
      estimatedSeconds: o.estimateSeconds ?? null,
      createdAt: at,
      updatedAt: o.updated ?? at,
      watchers: new Set(),
      activities: [],
    };
    workPackages.push(w);
    return Object.assign(w, { key: key(w) });
  };
  const byId = (id: number | string) => workPackages.find((w) => w.id === Number(id));
  const need = (id: number | string) => {
    const w = byId(id);
    if (!w) throw new Error(`no work package ${id}`);
    return w;
  };

  const journal = (w: SimWorkPackage, userId: number, o: { comment?: string; details?: string[]; kind?: "comment" | "revision" }) => {
    const at = tick();
    const a: SimActivityItem = { id: next(), kind: o.kind ?? "comment", comment: o.comment ?? "", details: (o.details ?? []).map((html) => ({ html })), createdAt: at, userId };
    w.activities.push(a);
    w.updatedAt = at;
    return a;
  };
  const changed = (what: string, from: string, to: string) => `<strong>${what}</strong> changed from <i>${escapeHtml(from)}</i> <strong>to</strong> <i>${escapeHtml(to)}</i>`;

  function setStatus(w: SimWorkPackage, statusId: number, by: number) {
    journal(w, by, { details: [changed("Status", statusOf(w.statusId).name, statusOf(statusId).name)] });
    w.statusId = statusId;
    w.lockVersion += 1;
  }
  /** The statuses the workflow lets this user move to: always the current one, then what the workflow allows. */
  const allowedStatuses = (w: SimWorkPackage) =>
    statuses.filter((s) => s.id === w.statusId || (state.workflow ? (state.workflow[w.statusId] ?? []).includes(s.id) : true));

  /** Changes made "outside" (in OpenProject's own UI or by someone else). */
  const outside = {
    touch: (id: number | string) => {
      const w = need(id);
      w.updatedAt = tick();
      w.lockVersion += 1;
    },
    setStatus: (id: number | string, name: string) => setStatus(need(id), statuses.find((s) => s.name === name)!.id, 6),
    unassign: (id: number | string) => {
      const w = need(id);
      w.assigneeId = null;
      w.updatedAt = tick();
      w.lockVersion += 1;
    },
    assign: (id: number | string, userId: number) => {
      const w = need(id);
      w.assigneeId = userId;
      w.updatedAt = tick();
      w.lockVersion += 1;
    },
    /** The work package moves to another project: same id, same key */
    move: (id: number | string, identifier: string) => {
      const w = need(id);
      w.project = projects.get(identifier) ?? addProject(identifier);
      w.updatedAt = tick();
      w.lockVersion += 1;
    },
    remove: (id: number | string) => {
      workPackages.splice(workPackages.indexOf(need(id)), 1);
      for (let i = timeEntries.length - 1; i >= 0; i--) if (timeEntries[i].wpId === Number(id)) timeEntries.splice(i, 1);
    },
    comment: (id: number | string, text: string, o: { by?: number } = {}) => void journal(need(id), o.by ?? me.id, { comment: text }),
    revision: (id: number | string, message: string) => void journal(need(id), me.id, { comment: message, kind: "revision" }),
    describe: (id: number | string, text: string) => {
      const w = need(id);
      w.description = text;
      w.updatedAt = tick();
      w.lockVersion += 1;
    },
    timeEntry: (id: number | string, o: { date: string; seconds: number; comment?: string; userId?: number; activity?: number }) => {
      const w = need(id);
      const at = tick();
      const e: SimTimeEntry = { id: next(), wpId: w.id, projectId: w.project.id, userId: o.userId ?? me.id, spentOn: o.date, seconds: o.seconds, comment: o.comment ?? "", activityId: o.activity ?? 3, createdAt: at, updatedAt: at, lockVersion: 0 };
      timeEntries.push(e);
      return e;
    },
    /** Time on a project, no work package */
    projectTime: (identifier: string, o: { date: string; seconds: number }) => {
      const p = projects.get(identifier) ?? addProject(identifier);
      const at = tick();
      const e: SimTimeEntry = { id: next(), wpId: null, projectId: p.id, userId: me.id, spentOn: o.date, seconds: o.seconds, comment: "", activityId: 3, createdAt: at, updatedAt: at, lockVersion: 0 };
      timeEntries.push(e);
      return e;
    },
    editTimeEntry: (eid: number, seconds: number) => {
      const e = timeEntries.find((x) => x.id === eid)!;
      e.seconds = seconds;
      e.updatedAt = tick();
      e.lockVersion += 1;
    },
    removeTimeEntry: (eid: number) => void timeEntries.splice(timeEntries.findIndex((e) => e.id === eid), 1),
  };

  // ---------- Filters ----------

  const OPERATORS: Record<string, string[]> = {
    assignee: ["="],
    updatedAt: ["<>d"],
    subjectOrId: ["**"],
    status: ["o", "c", "="],
    id: ["="],
    workPackage: ["="],
    user: ["="],
    project: ["="],
  };
  const FOR: Record<"work_packages" | "time_entries", string[]> = {
    work_packages: ["assignee", "updatedAt", "subjectOrId", "status", "id"],
    time_entries: ["workPackage", "user", "updatedAt", "project"],
  };
  function parseFilters(raw: string | null, resource: keyof typeof FOR): ParsedFilter[] | string | undefined {
    if (raw === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "Filters Invalid filter: the filters are not valid JSON.";
    }
    if (!Array.isArray(parsed)) return "Filters Invalid filter: a list of filters is expected.";
    const out: ParsedFilter[] = [];
    for (const f of parsed as Record<string, { operator?: string; values?: unknown }>[]) {
      for (const [name, body] of Object.entries(f)) {
        if (!FOR[resource].includes(name)) return `Filters Invalid filter does not exist: ${name}.`;
        if (!body.operator || !OPERATORS[name].includes(body.operator)) return `Filters The operator ${body.operator} does not exist for the filter ${name}.`;
        out.push({ name, operator: body.operator, values: Array.isArray(body.values) ? body.values.map(String) : [] });
      }
    }
    return out;
  }
  /** A value of a date filter: a day (no time) is midnight in the requesting user's zone, anything longer an instant. */
  const when = (v: string): number | null => {
    if (v === "") return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) - state.userOffsetMinutes * 60_000 : Date.parse(v);
  };
  const userIds = (values: string[]) => values.map((v) => (v === "me" ? me.id : Number(v)));
  const inRange = (at: number, values: string[]) => {
    const from = when(values[0] ?? "");
    const to = when(values[1] ?? "");
    return (from === null || at >= from) && (to === null || at <= to);
  };

  const visible = (w: SimWorkPackage) => !w.project.hidden;
  const entryVisible = (e: SimTimeEntry) => {
    const p = [...projects.values()].find((x) => x.id === e.projectId)!;
    return !p.hidden && (state.viewOthersTime || e.userId === me.id);
  };

  function sortBy<T extends Record<string, unknown>>(list: T[], raw: string | null, fields: Record<string, (x: T) => number | string>): T[] | string {
    if (!raw) return list;
    let spec: unknown;
    try {
      spec = JSON.parse(raw);
    } catch {
      return "Sort by is not valid JSON.";
    }
    const keys = (spec as [string, string][]).map(([f, d]) => ({ get: fields[f], dir: d === "desc" ? -1 : 1 }));
    if (keys.some((k) => !k.get)) return "Sort by does not exist.";
    return [...list].sort((a, b) => {
      for (const k of keys) {
        const x = k.get(a);
        const y = k.get(b);
        if (x !== y) return (x < y ? -1 : 1) * k.dir;
      }
      return 0;
    });
  }

  /** A collection page: `offset` counts pages from 1, `pageSize` is cut to the cap. */
  function collection<T>(all: T[], url: URL, raw: (x: T) => unknown) {
    const pageSize = Math.min(Number(url.searchParams.get("pageSize") ?? state.defaultPageSize), state.maxPageSize);
    const offset = Math.max(1, Number(url.searchParams.get("offset") ?? 1));
    const elements = all.slice((offset - 1) * pageSize, offset * pageSize).map(raw);
    return json({ _type: "Collection", total: all.length, count: elements.length, pageSize, offset, _embedded: { elements }, _links: { self: { href: `${url.pathname}${url.search}` } } });
  }

  // ---------- The API ----------

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    state.calls.push(`${method} ${url.pathname.slice(webPath.length)}${url.search ? "?" + decodeURIComponent(url.search.slice(1)) : ""}`);
    if (url.origin !== new URL(web).origin) return error(404, "NotFound", "unknown site");
    const fault = injected.shift();
    if (fault) return json(fault.body ?? { _type: "Error", errorIdentifier: `${ERR}Injected`, message: `injected ${fault.status}` }, fault.status, fault.headers);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const basic = /^Basic (.+)$/.exec(auth)?.[1];
    const [user, ...pw] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":") : [""];
    const path = url.pathname.slice(`${webPath}/api/v3`.length) || "/";
    if (user !== "apikey" || !tokens.has(pw.join(":"))) {
      if (state.anonymous && path === "/users/me") return json({ _type: "AnonymousUser", id: 2, name: "Anonymous", login: null, status: "active" });
      return error(401, "Unauthenticated", "You need to be authenticated to access this resource.", { "WWW-Authenticate": 'Basic realm="OpenProject API"' });
    }
    const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;

    if (path === "/users/me") return json(userRaw(me.id));
    if (path === "/statuses") return collection(statuses, new URL(`${url.origin}${url.pathname}?pageSize=1000`), statusRaw);

    if (path === "/work_packages" && method === "GET") {
      state.onWorkPackageList?.();
      const filters = parseFilters(url.searchParams.get("filters"), "work_packages");
      if (typeof filters === "string") return error(400, "InvalidQuery", filters);
      let list = workPackages.filter(visible);
      // The trap: no filters at all means "status: open".
      if (filters === undefined) list = list.filter((w) => !statusOf(w.statusId).isClosed);
      for (const f of filters ?? []) {
        if (f.name === "assignee") list = list.filter((w) => w.assigneeId !== null && userIds(f.values).includes(w.assigneeId));
        else if (f.name === "updatedAt") list = list.filter((w) => inRange(w.updatedAt, f.values));
        else if (f.name === "subjectOrId") list = list.filter((w) => w.subject.toLowerCase().includes((f.values[0] ?? "").toLowerCase()) || String(w.id) === f.values[0]);
        else if (f.name === "id") list = list.filter((w) => f.values.includes(String(w.id)));
        else if (f.name === "status") list = list.filter((w) => (f.operator === "o" ? !statusOf(w.statusId).isClosed : f.operator === "c" ? statusOf(w.statusId).isClosed : f.values.includes(String(w.statusId))));
      }
      const sorted = sortBy(list, url.searchParams.get("sortBy"), { id: (w) => w.id, updatedAt: (w) => w.updatedAt, createdAt: (w) => w.createdAt, subject: (w) => w.subject });
      if (typeof sorted === "string") return error(400, "InvalidQuery", sorted);
      return collection(sorted, url, wpRaw);
    }
    if ((m = /^\/work_packages\/(\d+)$/.exec(path))) {
      const w = byId(m[1]);
      if (!w || !visible(w)) return notFound("work package");
      if (method === "PATCH") {
        // The current lockVersion is required: missing is a validation error, stale a conflict.
        if (typeof body.lockVersion !== "number") return invalid({ attribute: "lockVersion", message: "Lock version can't be blank." });
        if (body.lockVersion !== w.lockVersion) return error(409, "UpdateConflict", "Couldn't update the resource because the information has been updated by someone else in the meantime.");
        const to = idOfHref((body._links as { status?: { href?: unknown } } | undefined)?.status?.href);
        if (to !== null) {
          if (!statuses.some((s) => s.id === to)) return invalid({ attribute: "status", message: "Status does not exist." });
          if (!allowedStatuses(w).some((s) => s.id === to)) return invalid({ attribute: "status", message: "Status is invalid because no valid transition exists from old to new status for the current user's roles." });
          if (to !== w.statusId) setStatus(w, to, me.id);
        }
      }
      return json(wpRaw(w));
    }
    if ((m = /^\/work_packages\/(\d+)\/form$/.exec(path)) && method === "POST") {
      const w = byId(m[1]);
      if (!w || !visible(w)) return notFound("work package");
      const allowed = allowedStatuses(w);
      const status =
        state.allowedAs === "embedded"
          ? { type: "Status", name: "Status", required: true, writable: true, _embedded: { allowedValues: allowed.map(statusRaw) } }
          : { type: "Status", name: "Status", required: true, writable: true, _links: { allowedValues: allowed.map((s) => link(`/statuses/${s.id}`, s.name)) } };
      return json({ _type: "Form", _embedded: { payload: { lockVersion: w.lockVersion, subject: w.subject }, schema: { _type: "Schema", status }, validationErrors: {} }, _links: { self: link(`/work_packages/${w.id}/form`), commit: link(`/work_packages/${w.id}`, undefined, "patch") } });
    }
    if ((m = /^\/work_packages\/(\d+)\/activities$/.exec(path))) {
      const w = byId(m[1]);
      if (!w || !visible(w)) return notFound("work package");
      if (method === "POST") {
        const raw = (body.comment as { raw?: unknown } | undefined)?.raw;
        if (typeof raw !== "string" || !raw.trim()) return invalid({ attribute: "comment", message: "Comment can't be blank." });
        return json(activityRaw(w, journal(w, me.id, { comment: raw })), 201);
      }
      return collection(w.activities, new URL(`${url.origin}${url.pathname}?pageSize=1000`), (a) => activityRaw(w, a));
    }
    if ((m = /^\/work_packages\/(\d+)\/watchers$/.exec(path)) && method === "POST") {
      const w = byId(m[1]);
      if (!w || !visible(w)) return notFound("work package");
      const uid = idOfHref((body.user as { href?: unknown } | undefined)?.href);
      if (uid === null || !users.has(uid)) return invalid({ attribute: "user", message: "User is invalid." });
      const existed = w.watchers.has(uid);
      w.watchers.add(uid);
      return json(userRaw(uid), existed ? 200 : 201);
    }
    if ((m = /^\/work_packages\/(\d+)\/watchers\/(\d+)$/.exec(path)) && method === "DELETE") {
      const w = byId(m[1]);
      if (!w || !visible(w) || !w.watchers.has(Number(m[2]))) return notFound("watcher");
      w.watchers.delete(Number(m[2]));
      return json(undefined, 204);
    }

    if (path === "/time_entries" && method === "GET") {
      const filters = parseFilters(url.searchParams.get("filters"), "time_entries");
      if (typeof filters === "string") return error(400, "InvalidQuery", filters);
      let list = timeEntries.filter(entryVisible);
      for (const f of filters ?? []) {
        if (f.name === "workPackage") list = list.filter((e) => e.wpId !== null && f.values.includes(String(e.wpId)));
        else if (f.name === "user") list = list.filter((e) => userIds(f.values).includes(e.userId));
        else if (f.name === "updatedAt") list = list.filter((e) => inRange(e.updatedAt, f.values));
        else if (f.name === "project") list = list.filter((e) => f.values.includes(String(e.projectId)));
      }
      const sorted = sortBy(list, url.searchParams.get("sortBy"), { id: (e) => e.id, updatedAt: (e) => e.updatedAt, spentOn: (e) => e.spentOn });
      if (typeof sorted === "string") return error(400, "InvalidQuery", sorted);
      return collection(sorted, url, entryRaw);
    }
    if (path === "/time_entries" && method === "POST") {
      const made = writeEntry(undefined, body);
      return made instanceof Response ? made : json(entryRaw(made), 201);
    }
    if (path === "/time_entries/form" && method === "POST") {
      const wp = byId(idOfHref((body._links as { workPackage?: { href?: unknown } } | undefined)?.workPackage?.href) ?? 0);
      const active = ACTIVITIES.filter((a) => !wp || !wp.project.disabledActivities.has(a.id));
      const raw = (a: (typeof ACTIVITIES)[number]) => ({ _type: "TimeEntriesActivity", id: a.id, name: a.name, position: a.id, default: a.default, _links: { self: link(`/time_entries/activities/${a.id}`, a.name) } });
      const activity =
        state.allowedAs === "embedded"
          ? { type: "TimeEntriesActivity", name: "Activity", required: false, writable: true, _embedded: { allowedValues: active.map(raw) } }
          : { type: "TimeEntriesActivity", name: "Activity", required: false, writable: true, _links: { allowedValues: active.map((a) => link(`/time_entries/activities/${a.id}`, a.name)) } };
      return json({ _type: "Form", _embedded: { payload: body, schema: { _type: "Schema", activity }, validationErrors: {} } });
    }
    if ((m = /^\/time_entries\/(\d+)$/.exec(path))) {
      const e = timeEntries.find((x) => x.id === Number(m![1]));
      if (!e || !entryVisible(e)) return notFound("time entry");
      if (method === "DELETE") {
        if (!canEdit(e)) return denied("You are not authorized to access this resource.");
        timeEntries.splice(timeEntries.indexOf(e), 1);
        return json(undefined, 204);
      }
      if (method === "PATCH") {
        if (!canEdit(e)) return denied("You are not authorized to access this resource.");
        const made = writeEntry(e, body);
        return made instanceof Response ? made : json(entryRaw(made));
      }
      return json(entryRaw(e));
    }
    return error(404, "NotFound", `simulator: ${method} ${path} not handled`);
  }

  /** Creates or changes a time entry. */
  function writeEntry(existing: SimTimeEntry | undefined, body: Record<string, unknown>): SimTimeEntry | Response {
    const links = (body._links ?? {}) as Record<string, { href?: unknown } | undefined>;
    if (existing && state.timeEntryLockVersion) {
      if (typeof body.lockVersion !== "number") return invalid({ attribute: "lockVersion", message: "Lock version can't be blank." });
      if (body.lockVersion !== existing.lockVersion) return error(409, "UpdateConflict", "Couldn't update the resource because the information has been updated by someone else in the meantime.");
    }
    const wpId = existing ? existing.wpId : idOfHref(links.workPackage?.href);
    const wp = wpId === null ? undefined : byId(wpId);
    if (!existing && links.workPackage && (!wp || !visible(wp))) return invalid({ attribute: "workPackage", message: "Work package is invalid." });
    const project = existing ? [...projects.values()].find((p) => p.id === existing.projectId)! : wp?.project;
    if (!project) return invalid({ attribute: "project", message: "Project can't be blank." });
    if (!project.timeTracking || !project.logTime) return denied("You are not authorized to access this resource.");
    const problems: { attribute: string; message: string }[] = [];
    const spent = body.spentOn ?? existing?.spentOn;
    if (typeof spent !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(spent) || Number.isNaN(Date.parse(spent))) problems.push({ attribute: "spentOn", message: "Date can't be blank." });
    const seconds = body.hours === undefined && existing ? existing.seconds : parseDuration(body.hours);
    if (seconds === null || seconds <= 0) problems.push({ attribute: "hours", message: "Hours must be greater than 0." });
    else if (seconds > 24 * 3600) problems.push({ attribute: "hours", message: "Hours is too long." });
    const comment = (body.comment as { raw?: unknown } | undefined)?.raw ?? existing?.comment ?? "";
    if (typeof comment !== "string" || comment.length > 255) problems.push({ attribute: "comment", message: "Comment is too long (maximum is 255 characters)." });
    const asked = idOfHref(links.activity?.href);
    const activity = asked === null ? (existing ? ACTIVITIES.find((a) => a.id === existing.activityId)! : ACTIVITIES.find((a) => a.default)!) : ACTIVITIES.find((a) => a.id === asked);
    if (!activity || project.disabledActivities.has(activity.id)) problems.push({ attribute: "activity", message: "Activity is not set to one of the allowed values." });
    // Who logged it: fixed once made; for another user at creation, a right of its own.
    const asUser = idOfHref(links.user?.href);
    if (existing && asUser !== null && asUser !== existing.userId) problems.push({ attribute: "user", message: "User can't be changed." });
    if (!existing && asUser !== null && asUser !== me.id) {
      if (!state.canLogForOthers) return denied("You are not authorized to log time for other users.");
      if (!users.has(asUser)) problems.push({ attribute: "user", message: "User is invalid." });
    }
    if (problems.length > 0) return invalid(...problems);
    const at = tick();
    const e: SimTimeEntry = existing ?? { id: next(), wpId, projectId: project.id, userId: asUser ?? me.id, spentOn: "", seconds: 0, comment: "", activityId: 0, createdAt: at, updatedAt: at, lockVersion: 0 };
    Object.assign(e, { spentOn: spent as string, seconds: seconds as number, comment: comment as string, activityId: activity!.id, updatedAt: at });
    if (existing) e.lockVersion += 1;
    else timeEntries.push(e);
    return e;
  }

  const failNext = (status: number, headers?: Record<string, string>, errBody?: unknown) => void injected.push({ status, headers, body: errBody });

  return {
    apiBase,
    web,
    me,
    token,
    tokens,
    state,
    workPackages,
    timeEntries,
    projects,
    statuses,
    fetch: handle,
    project: addProject,
    user: addUser,
    add,
    outside,
    failNext,
    byId,
    /** A webhook delivery as OpenProject sends it: the body, and the signature when the hook has a secret */
    webhook: (action: string, payload: Record<string, unknown>, o: { secret?: string; signWith?: string } = {}) => {
      const rawBody = JSON.stringify({ action, ...payload });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.secret !== undefined) headers["x-op-signature"] = `sha1=${createHmac("sha1", o.signWith ?? o.secret).update(rawBody).digest("hex")}`;
      return { rawBody, headers };
    },
    DAY,
  };
}
