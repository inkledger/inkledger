// A Toggl Track in memory, for tests: the API v9 endpoints the adapter calls,
// written from Toggl's documentation (not recorded from a real account), with
// its shapes and traps:
// - Basic auth `<token>:api_token`; a wrong token answers 403, not 401;
// - an hourly quota per plan (free: 30 requests), over it 402 with a plain-text
//   reason and X-Toggl-Quota-* headers; but 402 also answers a feature the
//   plan lacks (tasks); a burst answers 429 with Retry-After;
// - an entry is a start and a `duration` in seconds; a running timer has a
//   negative duration (minus its start as a Unix timestamp) and no stop;
// - /me/time_entries spans every workspace of the user, is not paged, answers
//   at most a cap of entries with no sign of more, takes `since` as Unix
//   SECONDS (and then also lists deleted entries, marked), and reads a bare
//   date in start_date/end_date as UTC; the end is exclusive, the range at
//   most three months;
// - created_with is required on creation, workspace_id in the body must match
//   the URL, billable and tasks are for paid plans, descriptions are capped;
//   a workspace may require a project, a task or a description, and may lock
//   time entries before a date (403 / a refusal inside the bulk PATCH);
// - bulk PATCH takes JSON-patch operations on ids, answers success/failure
//   lists with 200, and a duration replaced alone leaves the stop where it was;
// - no idempotency: the same POST twice makes two entries;
// - the project list is paged (151 by default, 200 at most), filters `name`
//   exactly, and is `null` when empty.
import type { TogglEntry, TogglMe, TogglProject, TogglWorkspace } from "./client";

type SimWorkspace = { id: number; name: string; premium: boolean };
type SimProject = { id: number; workspace: number; name: string; active: boolean };
type SimTask = { id: number; project: number; name: string };
type SimEntry = {
  id: number;
  workspace: number;
  user: number;
  project: number | null;
  task: number | null;
  billable: boolean;
  /** ms */
  start: number;
  /** ms; null while a timer runs */
  stop: number | null;
  /** seconds; negative while a timer runs */
  duration: number;
  description: string;
  at: number;
  deletedAt: number | null;
};

const DAY = 86_400_000;
const PLANS = { free: 30, starter: 240, premium: 600 } as const;

export function togglSimulator(apiBase = "https://api.track.toggl.com/api/v9", o: { cap?: number } = {}) {
  const token = "toggl-simulated-token";
  const me: TogglMe = { id: 4001, email: "mario.rossi@example.com", fullname: "Mario Rossi", default_workspace_id: 9001, timezone: "Europe/Rome", image_url: "https://assets.toggl.com/avatars/4001.png" };
  const workspaces = new Map<number, SimWorkspace>([
    [9001, { id: 9001, name: "Acme", premium: false }],
    [9002, { id: 9002, name: "Side gig", premium: false }],
  ]);
  const projects = new Map<number, SimProject>();
  const tasks = new Map<number, SimTask>();
  const entries: SimEntry[] = [];
  const constraints = new Map<number, { project: boolean; task: boolean; description: boolean }>();
  /** Time entries before this instant are locked, by workspace */
  const locks = new Map<number, number>();
  const cap = o.cap ?? 1000;
  let seq = 10_000;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  const quota = { limit: PLANS.free as number, used: 0, windowStart: Date.now() };
  const state = { calls: 0, revoked: false, throttled: false };
  const log: { method: string; path: string; query: URLSearchParams; body: unknown }[] = [];

  /** A plan: its workspace turns premium (billable, tasks) and its quota changes. */
  const plan = (name: keyof typeof PLANS, workspace = 9001) => {
    const ws = workspaces.get(workspace);
    if (ws) ws.premium = name !== "free";
    quota.limit = PLANS[name];
  };

  const project = (name: string, p: { workspace?: number; active?: boolean } = {}): SimProject => {
    const made: SimProject = { id: ++seq, workspace: p.workspace ?? 9001, name, active: p.active ?? true };
    projects.set(made.id, made);
    return made;
  };
  const task = (name: string, forProject: SimProject): SimTask => {
    const made: SimTask = { id: ++seq, project: forProject.id, name };
    tasks.set(made.id, made);
    return made;
  };

  /** An entry that exists already (made on the service, or before the test began). */
  const entry = (e: { start: string; seconds: number; description?: string; project?: SimProject | null; workspace?: number; billable?: boolean; user?: number }): SimEntry => {
    const start = Date.parse(e.start);
    const made: SimEntry = {
      id: ++seq,
      workspace: e.workspace ?? 9001,
      user: e.user ?? me.id,
      project: e.project?.id ?? null,
      task: null,
      billable: e.billable ?? false,
      start,
      stop: start + e.seconds * 1000,
      duration: e.seconds,
      description: e.description ?? "",
      at: now(),
      deletedAt: null,
    };
    entries.push(made);
    return made;
  };

  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const shown = (e: SimEntry): TogglEntry => ({
    id: e.id,
    workspace_id: e.workspace,
    project_id: e.project,
    task_id: e.task,
    billable: e.billable,
    start: iso(e.start),
    stop: e.stop === null ? null : iso(e.stop),
    duration: e.duration,
    description: e.description,
    tags: [],
    user_id: e.user,
    uid: e.user,
    at: iso(e.at),
    server_deleted_at: e.deletedAt === null ? null : iso(e.deletedAt),
  });

  /** What happens on the service outside inkledger. */
  const outside = {
    /** A timer started in the web app and still running: no stop, a duration of minus its start. */
    timer(start: string, description = "Timer", p: SimProject | null = null): SimEntry {
      const at = Date.parse(start);
      const made = entry({ start, seconds: 1, description, project: p });
      Object.assign(made, { stop: null, duration: -Math.floor(at / 1000) });
      return made;
    },
    /** Someone edits an entry: it changes now. */
    edit(e: SimEntry, change: { seconds?: number; description?: string }) {
      if (change.seconds !== undefined) Object.assign(e, { duration: change.seconds, stop: e.start + change.seconds * 1000 });
      if (change.description !== undefined) e.description = change.description;
      e.at = now();
    },
    /** Someone deletes an entry: it stays for a feed, marked. */
    remove(e: SimEntry) {
      e.deletedAt = e.at = now();
    },
    /** The workspace locks time entries before a day (UTC midnight). */
    lock(before: string, workspace = 9001) {
      locks.set(workspace, Date.parse(`${before}T00:00:00Z`));
    },
    /** The workspace asks for a project, a task or a description on every entry. */
    require(what: Partial<{ project: boolean; task: boolean; description: boolean }>, workspace = 9001) {
      constraints.set(workspace, { project: false, task: false, description: false, ...constraints.get(workspace), ...what });
    },
  };

  // ---------- HTTP ----------

  const quotaHeaders = (): Record<string, string> => ({
    "X-Toggl-Quota-Remaining": String(Math.max(0, quota.limit - quota.used)),
    "X-Toggl-Quota-Resets-In": String(Math.max(1, Math.ceil((quota.windowStart + 3_600_000 - Date.now()) / 1000))),
  });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...quotaHeaders(), ...headers } });
  const text = (message: string, status: number, headers: Record<string, string> = {}) =>
    new Response(message, { status, headers: { "Content-Type": "text/plain", ...quotaHeaders(), ...headers } });

  /** A bare date is UTC midnight; anything else is an RFC 3339 instant. */
  const bound = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v ?? ""));

  const lockedAt = (e: { workspace: number; start: number }) => e.start < (locks.get(e.workspace) ?? -Infinity);
  const lockMessage = (workspace: number) => `Time entries before ${new Date(locks.get(workspace) ?? 0).toISOString().slice(0, 10)} are locked in this workspace`;

  /** What a new or changed entry must satisfy; a message when it doesn't. */
  function invalid(ws: SimWorkspace, f: { description: string; project: number | null; task: number | null; billable: boolean }): { status: number; message: string } | null {
    if (f.description.length > 3000) return { status: 400, message: "Description is too long: at most 3000 characters" };
    if (f.billable && !ws.premium) return { status: 400, message: "Billable time is available on paid plans only" };
    const p = f.project === null ? undefined : projects.get(f.project);
    if (f.project !== null && (!p || p.workspace !== ws.id)) return { status: 400, message: `Project ${f.project} does not exist in this workspace` };
    if (p && !p.active) return { status: 400, message: "Project is archived" };
    if (f.task !== null) {
      if (!ws.premium) return { status: 402, message: "Tasks are available on paid plans only" };
      const t = tasks.get(f.task);
      if (!t || t.project !== f.project) return { status: 400, message: "Task does not belong to the project" };
    }
    const need = constraints.get(ws.id);
    if (need?.project && f.project === null) return { status: 400, message: "Project is required for time entries in this workspace" };
    if (need?.task && f.task === null) return { status: 400, message: "Task is required for time entries in this workspace" };
    if (need?.description && !f.description.trim()) return { status: 400, message: "Description is required for time entries in this workspace" };
    return null;
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
    const path = url.pathname.slice(apiPath.length);
    const q = url.searchParams;
    state.calls++;
    log.push({ method, path, query: q, body });

    const expected = `Basic ${Buffer.from(`${token}:api_token`).toString("base64")}`;
    if (headers.get("authorization") !== expected || state.revoked) return text("Incorrect username and/or password", 403);
    if (state.throttled) return text("Too many requests: one request per second", 429, { "Retry-After": "2" });
    if (Date.now() >= quota.windowStart + 3_600_000) Object.assign(quota, { used: 0, windowStart: Date.now() });
    quota.used++;
    if (quota.used > quota.limit) {
      return text(`You have hit your hourly limit for API calls. The limit will reset in ${quotaHeaders()["X-Toggl-Quota-Resets-In"]} seconds.`, 402);
    }

    if (method === "GET" && path === "/me") return json(me);

    // ----- Time entries of the user, every workspace -----
    if (method === "GET" && path === "/me/time_entries") {
      const mine = entries.filter((e) => e.user === me.id);
      const since = q.get("since");
      let rows: SimEntry[];
      if (since !== null) {
        const secs = Number(since);
        // Milliseconds are not a Unix timestamp.
        if (!Number.isInteger(secs) || secs <= 0 || secs > 1e11) return text("Invalid since: a Unix timestamp in seconds is expected", 400);
        if (secs * 1000 < Date.now() - 90 * DAY) return text("Since must not be older than 3 months", 400);
        rows = mine.filter((e) => e.at >= secs * 1000);
      } else if (q.has("start_date") || q.has("end_date")) {
        if (!q.has("start_date") || !q.has("end_date")) return text("Both start_date and end_date must be provided", 400);
        const from = bound(q.get("start_date"));
        const to = bound(q.get("end_date"));
        if (Number.isNaN(from) || Number.isNaN(to)) return text("Invalid start_date or end_date", 400);
        if (to <= from) return text("end_date must be after start_date", 400);
        if (to - from > 90 * DAY) return text("Start date and end date must be within 3 months of each other", 400);
        rows = mine.filter((e) => !e.deletedAt && e.start >= from && e.start < to);
      } else {
        rows = mine.filter((e) => !e.deletedAt && e.start >= Date.now() - 9 * DAY);
      }
      // Newest first, cut at the cap without a word.
      return json(
        rows
          .sort((a, b) => b.start - a.start || b.id - a.id)
          .slice(0, cap)
          .map(shown),
      );
    }
    const one = /^\/me\/time_entries\/(\d+)$/.exec(path);
    if (method === "GET" && one) {
      const e = entries.find((x) => x.id === Number(one[1]) && x.user === me.id && !x.deletedAt);
      return e ? json(shown(e)) : text("Time entry not found", 404);
    }

    // ----- Workspaces -----
    const w = /^\/workspaces\/(\d+)(\/.*)?$/.exec(path);
    if (!w) return text(`unmocked ${method} ${path}`, 404);
    const ws = workspaces.get(Number(w[1]));
    if (!ws) return text("You do not have access to the requested workspace", 403);
    const sub = w[2] ?? "";

    if (method === "GET" && sub === "") {
      const out: TogglWorkspace = { id: ws.id, name: ws.name, premium: ws.premium };
      return json(out);
    }

    if (method === "GET" && sub === "/projects") {
      const per = Math.min(200, Math.max(1, Number(q.get("per_page") ?? 151)));
      const page = Math.max(1, Number(q.get("page") ?? 1));
      const name = q.get("name");
      const active = q.get("active");
      const list = [...projects.values()]
        .filter((p) => p.workspace === ws.id)
        .filter((p) => active === null || p.active === (active === "true"))
        // Exactly, not by part of a name.
        .filter((p) => name === null || p.name.toLowerCase() === name.toLowerCase())
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
        .slice((page - 1) * per, page * per)
        .map((p): TogglProject => ({ id: p.id, workspace_id: p.workspace, name: p.name, active: p.active, client_id: null }));
      // An empty list is null.
      return json(list.length === 0 ? null : list);
    }

    if (method === "POST" && sub === "/time_entries") {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.created_with !== "string" || !b.created_with) return text('"created_with" is required', 400);
      if (b.workspace_id !== ws.id) return text("workspace_id in the body must match the one in the URL", 400);
      const start = typeof b.start === "string" ? Date.parse(b.start) : NaN;
      if (Number.isNaN(start)) return text("Invalid start: an RFC 3339 time is expected", 400);
      if (typeof b.duration !== "number" || !Number.isInteger(b.duration) || b.duration === 0) return text("Invalid duration: whole seconds, or -1 for a running timer", 400);
      const f = {
        description: typeof b.description === "string" ? b.description : "",
        project: typeof b.project_id === "number" ? b.project_id : null,
        task: typeof b.task_id === "number" ? b.task_id : null,
        billable: b.billable === true,
      };
      const bad = invalid(ws, f);
      if (bad) return text(bad.message, bad.status);
      if (lockedAt({ workspace: ws.id, start })) return text(lockMessage(ws.id), 403);
      const running = b.duration < 0;
      const made: SimEntry = {
        id: ++seq,
        workspace: ws.id,
        user: me.id,
        project: f.project,
        task: f.task,
        billable: f.billable,
        start,
        stop: running ? null : start + b.duration * 1000,
        duration: running ? -Math.floor(start / 1000) : b.duration,
        description: f.description,
        at: now(),
        deletedAt: null,
      };
      entries.push(made);
      return json(shown(made));
    }

    const target = /^\/time_entries\/([\d,]+)$/.exec(sub);
    if (target && method === "PATCH") {
      if (!Array.isArray(body)) return text("A list of patch operations is expected", 400);
      const result: { success: number[]; failure: { id: number; message: string }[] } = { success: [], failure: [] };
      for (const id of target[1].split(",").map(Number)) {
        const e = entries.find((x) => x.id === id && x.workspace === ws.id && x.user === me.id && !x.deletedAt);
        if (!e) {
          result.failure.push({ id, message: "Time entry not found" });
          continue;
        }
        if (lockedAt(e)) {
          result.failure.push({ id, message: lockMessage(ws.id) });
          continue;
        }
        const next = { ...e };
        for (const op of body as { op?: unknown; path?: unknown; value?: unknown }[]) {
          if (op.op !== "replace") return text("Only replace operations are supported", 400);
          const v = op.value;
          if (op.path === "/description" && typeof v === "string") next.description = v;
          else if (op.path === "/billable" && typeof v === "boolean") next.billable = v;
          else if (op.path === "/start" && typeof v === "string") next.start = Date.parse(v);
          else if (op.path === "/stop" && typeof v === "string") next.stop = Date.parse(v);
          else if (op.path === "/duration" && typeof v === "number" && Number.isInteger(v)) next.duration = v;
          else return text(`Unsupported patch operation on ${String(op.path)}`, 400);
        }
        const bad = invalid(ws, { description: next.description, project: next.project, task: next.task, billable: next.billable });
        if (bad) {
          result.failure.push({ id, message: bad.message });
          continue;
        }
        if (lockedAt(next)) {
          result.failure.push({ id, message: lockMessage(ws.id) });
          continue;
        }
        Object.assign(e, next, { at: now() });
        result.success.push(id);
      }
      return json(result);
    }
    if (target && method === "DELETE") {
      const e = entries.find((x) => x.id === Number(target[1]) && x.workspace === ws.id && x.user === me.id && !x.deletedAt);
      if (!e) return text("Time entry not found", 404);
      if (lockedAt(e)) return text(lockMessage(ws.id), 403);
      e.deletedAt = e.at = now();
      return new Response(null, { status: 200, headers: quotaHeaders() });
    }
    return text(`unmocked ${method} ${path}`, 404);
  }

  return {
    apiBase,
    token,
    me,
    workspaces,
    projects,
    tasks,
    entries,
    quota,
    state,
    log,
    plan,
    project,
    task,
    entry,
    outside,
    /** The live entries of a workspace (those not deleted). */
    live: (workspace = 9001) => entries.filter((e) => e.workspace === workspace && !e.deletedAt),
    /** A burst from now on answers 429 with Retry-After. */
    throttle: () => (state.throttled = true),
    /** The token stops working. */
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
