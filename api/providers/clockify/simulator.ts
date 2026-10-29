// A Clockify in memory, for tests: the v1 endpoints the sink calls, written
// from Clockify's public API documentation (not recorded from a real
// server), with its shapes and traps:
// - X-Api-Key or 401; 50 requests a second per key, then 429 (no Retry-After assumed);
// - times are ISO instants in UTC to the second ("2026-10-14T08:30:00Z"), never dates: a
//   date-only filter is a 400; fractions of a second are cut off;
// - the length comes back as an ISO 8601 duration ("PT1H30M"), only a running timer has none
//   (end and duration null), and starting one stops the one running;
// - the list is newest first, page / page-size (default 50, at most 1000), no total: a short page ends it;
// - PUT replaces the whole entry: project, task, tags and billable not sent are cleared;
// - billable defaults to the project's own setting; a workspace may force a project, or a task;
//   a task needs its project; an archived project takes no entries; a description is at most 3000 characters;
// - approved, submitted and period-locked entries answer 400 on any change; approval requests are listed for managers only;
// - nothing honours an idempotency key: a retried create makes a second entry.
import type { ClockifyApproval, ClockifyEntry, ClockifyProject, ClockifyTask, ClockifyUser } from "./client";
import { isoDuration } from "../core/time";

type SimEntry = {
  id: string;
  userId: string;
  start: number;
  end: number | null;
  description: string;
  billable: boolean;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  locked: boolean;
};
type SimProject = ClockifyProject & { archived: boolean; billable: boolean };
type SimTask = ClockifyTask & { status: "ACTIVE" | "DONE" };
type SimApproval = { id: string; userId: string; state: "PENDING" | "APPROVED" | "REJECTED"; from: number; to: number };

const MAX_PAGE_SIZE = 1000;
const MAX_DESCRIPTION = 3000;
const hex = (n: number) => n.toString(16).padStart(24, "0");
const SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function clockifySimulator(o: { apiBase?: string; forceProjects?: boolean; forceTasks?: boolean; perSecond?: number; manager?: boolean } = {}) {
  const apiBase = o.apiBase ?? "https://api.clockify.me/api/v1";
  const token = "clockify-simulated-key";
  const workspaceId = hex(0x1001);
  const me: ClockifyUser & { id: string } = {
    id: hex(0x2001),
    name: "Mario Rossi",
    email: "mario@example.org",
    profilePicture: "https://img.clockify.me/mario.png",
    activeWorkspace: workspaceId,
    defaultWorkspace: workspaceId,
    settings: { timeZone: "Europe/Rome" },
  };
  const colleague = hex(0x2002);
  const settings = { forceProjects: o.forceProjects ?? false, forceTasks: o.forceTasks ?? false, manager: o.manager ?? false };
  const projects = new Map<string, SimProject>();
  const tasks = new Map<string, SimTask>();
  const entries: SimEntry[] = [];
  const approvals: SimApproval[] = [];
  const state = { calls: 0, revoked: false, exhausted: false, perSecond: o.perSecond ?? 50, lockedBefore: 0 };
  const log: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const hits: number[] = [];
  let seq = 0x3000;
  // The clock: real time, so a running timer has a length.
  const now = () => Date.now();

  const project = (name: string, p: { billable?: boolean; archived?: boolean; clientName?: string } = {}) => {
    const made: SimProject = { id: hex(++seq), name, workspaceId, billable: p.billable ?? false, archived: p.archived ?? false, clientName: p.clientName ?? "" };
    projects.set(made.id, made);
    return made;
  };
  const task = (projectId: string, name: string, t: { done?: boolean } = {}) => {
    const made: SimTask = { id: hex(++seq), name, projectId, status: t.done ? "DONE" : "ACTIVE" };
    tasks.set(made.id, made);
    return made;
  };
  /** An entry that was there before the test began. */
  const entry = (e: Partial<Omit<SimEntry, "id">> & { start: number }) => {
    const made: SimEntry = { id: hex(++seq), userId: me.id, end: e.start + 3600_000, description: "", billable: false, projectId: null, taskId: null, tagIds: [], locked: false, ...e };
    entries.push(made);
    return made;
  };

  const shown = (e: SimEntry): ClockifyEntry => ({
    id: e.id,
    description: e.description,
    userId: e.userId,
    billable: e.billable,
    projectId: e.projectId,
    taskId: e.taskId,
    workspaceId,
    tagIds: e.tagIds,
    timeInterval: { start: new Date(e.start).toISOString().replace(/\.\d{3}Z$/, "Z"), end: e.end === null ? null : new Date(e.end).toISOString().replace(/\.\d{3}Z$/, "Z"), duration: e.end === null ? null : isoDuration(Math.round((e.end - e.start) / 1000)) },
    isLocked: e.locked || e.start < state.lockedBefore,
  });
  const approvalShown = (a: SimApproval): ClockifyApproval => ({
    id: a.id,
    owner: { userId: a.userId },
    status: { state: a.state },
    dateRange: { start: new Date(a.from).toISOString().replace(/\.\d{3}Z$/, "Z"), end: new Date(a.to).toISOString().replace(/\.\d{3}Z$/, "Z") },
  });

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const refuse = (message: string, code: number, status = 400) => json({ message, code }, status);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const root = new URL(apiBase).pathname.replace(/\/$/, "");
    const path = url.pathname.slice(root.length);
    state.calls++;
    log.push({ method, path: path + url.search, body });

    if (headers.get("x-api-key") !== token || state.revoked) return refuse("Full authentication is required to access this resource", 4001, 401);
    const t = Date.now();
    hits.push(t);
    while (hits.length && hits[0] <= t - 1000) hits.shift();
    if (state.exhausted || hits.length > state.perSecond) return refuse("Too many requests", 429, 429);

    const paged = <T>(list: T[]) => {
      const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("page-size") ?? 50)));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      return json(list.slice((page - 1) * size, page * size));
    };

    if (path === "/user") return json(me);
    if (path === "/workspaces") return json([{ id: workspaceId, name: "Acme" }]);

    const ws = /^\/workspaces\/([^/]+)(\/.*)$/.exec(path);
    if (!ws) return refuse(`unmocked ${method} ${path}`, 404, 404);
    if (ws[1] !== workspaceId) return refuse("Workspace doesn't exist or you don't have access", 403, 403);
    const sub = ws[2];

    if (sub === "/projects") {
      const name = (url.searchParams.get("name") ?? "").toLowerCase();
      const archived = url.searchParams.get("archived");
      return paged([...projects.values()].filter((p) => p.name.toLowerCase().includes(name) && (archived === null ? true : p.archived === (archived === "true"))));
    }
    const tasksOf = /^\/projects\/([^/]+)\/tasks$/.exec(sub);
    if (tasksOf) {
      if (!projects.has(tasksOf[1])) return refuse("Project doesn't exist", 501, 404);
      const name = (url.searchParams.get("name") ?? "").toLowerCase();
      const active = url.searchParams.get("is-active");
      return paged([...tasks.values()].filter((x) => x.projectId === tasksOf[1] && x.name.toLowerCase().includes(name) && (active === null || (active === "true") === (x.status === "ACTIVE"))));
    }
    if (sub === "/approval-requests") {
      if (!settings.manager) return refuse("Forbidden", 403, 403);
      return paged(approvals.map(approvalShown));
    }

    // ----- time entries -----
    const listing = /^\/user\/([^/]+)\/time-entries$/.exec(sub);
    if (listing && method === "GET") {
      const from = url.searchParams.get("start");
      const to = url.searchParams.get("end");
      for (const v of [from, to]) if (v !== null && !SECOND.test(v)) return refuse(`Cannot parse "${v}" as an ISO-8601 date-time (yyyy-MM-ddThh:mm:ssZ)`, 501);
      const running = url.searchParams.get("in-progress") === "true";
      const rows = entries
        .filter((e) => e.userId === listing[1])
        .filter((e) => (from === null || e.start >= Date.parse(from)) && (to === null || e.start <= Date.parse(to)))
        .filter((e) => !running || e.end === null)
        .sort((a, b) => b.start - a.start || (a.id < b.id ? 1 : -1));
      return paged(rows.map(shown));
    }

    const make = /^(?:\/user\/([^/]+))?\/time-entries$/.exec(sub);
    if (make && method === "POST") {
      const userId = make[1] ?? me.id;
      if (userId !== me.id && !settings.manager) return refuse("Forbidden: only admins add time for others", 403, 403);
      const bad = validate(body, null);
      if (bad) return bad;
      const start = cut(String(body.start));
      const end = typeof body.end === "string" ? cut(body.end) : null;
      // A new timer stops the one running.
      if (end === null) for (const r of entries) if (r.userId === userId && r.end === null) r.end = Math.max(r.start, now());
      const made = entry({
        userId,
        start,
        end,
        description: typeof body.description === "string" ? body.description : "",
        projectId: typeof body.projectId === "string" ? body.projectId : null,
        taskId: typeof body.taskId === "string" ? body.taskId : null,
        tagIds: Array.isArray(body.tagIds) ? (body.tagIds as string[]) : [],
        billable: typeof body.billable === "boolean" ? body.billable : typeof body.projectId === "string" ? (projects.get(body.projectId)?.billable ?? false) : false,
      });
      return json(shown(made), 201);
    }

    const one = /^\/time-entries\/([^/]+)$/.exec(sub);
    if (one) {
      const e = entries.find((x) => x.id === one[1] && x.userId === me.id) ?? (settings.manager ? entries.find((x) => x.id === one[1]) : undefined);
      if (!e) return refuse("Time entry doesn't exist", 501, 404);
      if (method === "GET") return json(shown(e));
      if (shown(e).isLocked) return refuse("Time entry is locked: it is in an approved or submitted timesheet, or a locked period", 501);
      if (method === "DELETE") {
        entries.splice(entries.indexOf(e), 1);
        return json(undefined, 204);
      }
      if (method === "PUT") {
        const bad = validate(body, e);
        if (bad) return bad;
        // Replaced whole: what isn't sent is gone.
        e.start = cut(String(body.start));
        e.end = typeof body.end === "string" ? cut(body.end) : null;
        e.description = typeof body.description === "string" ? body.description : "";
        e.projectId = typeof body.projectId === "string" ? body.projectId : null;
        e.taskId = typeof body.taskId === "string" ? body.taskId : null;
        e.tagIds = Array.isArray(body.tagIds) ? (body.tagIds as string[]) : [];
        e.billable = typeof body.billable === "boolean" ? body.billable : e.projectId ? (projects.get(e.projectId)?.billable ?? false) : false;
        return json(shown(e));
      }
    }
    return refuse(`unmocked ${method} ${path}`, 404, 404);
  }

  /** Fractions of a second are cut off. */
  const cut = (text: string) => Math.floor(Date.parse(text) / 1000) * 1000;

  function validate(body: Record<string, unknown>, existing: SimEntry | null): Response | null {
    if (typeof body.start !== "string" || !SECOND.test(body.start)) return refuse("Start is required, as an ISO-8601 date-time (yyyy-MM-ddThh:mm:ssZ)", 501);
    if (body.end !== undefined && body.end !== null && (typeof body.end !== "string" || !SECOND.test(body.end))) return refuse("End must be an ISO-8601 date-time", 501);
    const start = cut(body.start);
    if (typeof body.end === "string" && cut(body.end) < start) return refuse("End cannot be before start", 501);
    if (start < state.lockedBefore) return refuse("You can't add or change time in a locked period", 501);
    if (typeof body.description === "string" && body.description.length > MAX_DESCRIPTION) return refuse(`Description can't be longer than ${MAX_DESCRIPTION} characters`, 501);
    const p = typeof body.projectId === "string" ? projects.get(body.projectId) : undefined;
    if (typeof body.projectId === "string" && !p) return refuse("Project doesn't exist", 501, 404);
    if (p?.archived && body.projectId !== existing?.projectId) return refuse("Project is archived: it takes no new time entries", 501);
    if (typeof body.taskId === "string") {
      const k = tasks.get(body.taskId);
      if (!p) return refuse("A task needs its project (projectId)", 501);
      if (!k || k.projectId !== p.id) return refuse("Task doesn't exist in that project", 501, 404);
    }
    if (settings.forceProjects && !p) return refuse("Project is required in this workspace", 501);
    if (settings.forceTasks && typeof body.taskId !== "string") return refuse("Task is required in this workspace", 501);
    return null;
  }

  const outside = {
    /** The entry goes into a submitted, approved or rejected timesheet: approved and submitted ones are locked. */
    timesheet(e: SimEntry, st: SimApproval["state"]) {
      approvals.push({ id: hex(++seq), userId: e.userId, state: st, from: e.start - 86_400_000, to: e.start + 86_400_000 });
      if (st !== "REJECTED") e.locked = true;
    },
    /** Everything before this instant is closed. */
    lockPeriod(before: number) {
      state.lockedBefore = before;
    },
    /** Someone changes the entry in Clockify. */
    edit(e: SimEntry, change: Partial<Pick<SimEntry, "description" | "billable" | "projectId" | "taskId" | "tagIds" | "end">>) {
      Object.assign(e, change);
    },
    /** Someone deletes it. */
    remove(e: SimEntry) {
      entries.splice(entries.indexOf(e), 1);
    },
    /** A timer is started in Clockify's own app. */
    startTimer(start = now()) {
      return entry({ start, end: null });
    },
  };

  return {
    apiBase,
    token,
    me,
    workspaceId,
    colleague,
    settings,
    projects,
    tasks,
    entries,
    approvals,
    state,
    log,
    project,
    task,
    entry,
    outside,
    /** Every call from now on is over the limit (429). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The key stops working (401). */
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
