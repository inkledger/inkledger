// A Harvest in memory, for tests: the v2 endpoints the adapter calls, written
// from Harvest's documentation (not recorded from a real account), with its
// shapes and traps:
// - Authorization: Bearer plus Harvest-Account-Id, and a User-Agent or 400;
// - 100 requests per 15 seconds, then 429 with Retry-After;
// - a time entry needs a project and a task the user is assigned to, and the
//   task must be assigned to that project; archived projects take no time;
// - hours are decimal (two decimals kept); on a duration account a start and
//   end are ignored, on a timestamp account they are kept and an entry cannot
//   cross midnight;
// - an entry created with neither hours nor an end starts a running timer;
// - spent_date is a date with no zone; created_at/updated_at are UTC; the
//   updated_since filter is UTC and inclusive;
// - locked, approved (is_closed) and invoiced (is_billed) entries refuse
//   changes and deletion with a 422;
// - no idempotency key: the same POST twice makes two entries;
// - an admin's /time_entries lists everyone's unless filtered by user_id;
// - lists are paged with page/per_page (at most 2000) and next_page;
// - DELETE answers 200 with an empty body.
import type { HarvestCompany, HarvestExternalReference, HarvestProjectAssignment, HarvestTimeEntry, HarvestUser } from "./client";

type SimTask = { id: number; name: string };
type SimProject = { id: number; name: string; code: string; clientId: number; active: boolean };
type SimAssignment = { id: number; projectId: number; active: boolean; tasks: { id: number; taskId: number; active: boolean }[] };
export type SimEntry = {
  id: number;
  userId: number;
  projectId: number;
  taskId: number;
  date: string;
  /** Kept to two decimals */
  hours: number;
  notes: string;
  startedMinute: number | null;
  running: boolean;
  timerStartedAt: number | null;
  locked: string | null;
  closed: boolean;
  billed: boolean;
  billable: boolean;
  external: HarvestExternalReference | null;
  created: number;
  updated: number;
};

export function harvestSimulator(apiBase = "https://api.harvestapp.com/v2", o: { timestamps?: boolean } = {}) {
  const token = "hv-simulated";
  const accountId = "1234567";
  const me: HarvestUser = { id: 3230547, first_name: "Mario", last_name: "Rossi", email: "mario.rossi@example.com", avatar_url: "https://cdn.harvestapp.com/avatars/3230547.png", timezone: "Rome", is_active: true };
  const colleague: HarvestUser = { id: 3230548, first_name: "Anna", last_name: "Bianchi", email: "anna@example.com", is_active: true };
  const users = new Map<number, HarvestUser>([
    [me.id, me],
    [colleague.id, colleague],
  ]);
  const clients = new Map<number, string>([[100, "Acme"]]);
  const tasks = new Map<number, SimTask>([
    [1, { id: 1, name: "Development" }],
    [2, { id: 2, name: "Meetings" }],
    [3, { id: 3, name: "Design" }],
  ]);
  const projects = new Map<number, SimProject>();
  const assignments: SimAssignment[] = [];
  const entries: SimEntry[] = [];
  const company: HarvestCompany = { name: "Acme Studio", wants_timestamp_timers: o.timestamps ?? false, time_format: "decimal", plan_type: "pro" };
  let seq = 7000;
  // Strictly increasing and never behind the real clock, so "updated since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  const state = { calls: 0, exhausted: false, revoked: false, limit: 100, admin: true, userAgents: [] as string[], window: [] as number[] };

  const project = (name: string, o2: { code?: string; tasks?: number[]; active?: boolean; client?: number } = {}) => {
    const p: SimProject = { id: ++seq, name, code: o2.code ?? name.slice(0, 3).toUpperCase(), clientId: o2.client ?? 100, active: o2.active ?? true };
    projects.set(p.id, p);
    assignments.push({ id: ++seq, projectId: p.id, active: true, tasks: (o2.tasks ?? [1, 2]).map((taskId) => ({ id: ++seq, taskId, active: true })) });
    return p;
  };
  const website = project("Website", { code: "WEB", tasks: [1, 2, 3] });
  const platform = project("Platform", { code: "PLT", tasks: [1] });

  const roundHours = (h: number) => Math.round(h * 100) / 100;
  const dateOk = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  const minutesOf = (text: unknown): number | null => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*([ap]m)?\s*$/i.exec(String(text));
    if (!m) return null;
    return ((Number(m[1]) % 12) + (m[3]?.toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(m[2]);
  };
  const clockText = (minutes: number) => `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, "0")}${minutes < 720 ? "am" : "pm"}`;
  const iso = (ms: number) => new Date(ms).toISOString();

  const add = (o2: { project?: SimProject; task?: number; date: string; hours: number; notes?: string; user?: number; started?: number; external?: HarvestExternalReference }) => {
    const at = now();
    const e: SimEntry = {
      id: ++seq,
      userId: o2.user ?? me.id,
      projectId: (o2.project ?? website).id,
      taskId: o2.task ?? 1,
      date: o2.date,
      hours: roundHours(o2.hours),
      notes: o2.notes ?? "",
      startedMinute: company.wants_timestamp_timers ? (o2.started ?? 9 * 60) : null,
      running: false,
      timerStartedAt: null,
      locked: null,
      closed: false,
      billed: false,
      billable: true,
      external: o2.external ?? null,
      created: at,
      updated: at,
    };
    entries.push(e);
    return e;
  };

  /** What happens elsewhere (the web app, a manager), for tests of a pass that finds it later. */
  const outside = {
    /** A timer started in the Harvest app, still counting. */
    startTimer(p: SimProject = website, task = 1, date = new Date().toISOString().slice(0, 10)) {
      const e = add({ project: p, task, date, hours: 0 });
      e.running = true;
      e.timerStartedAt = now() - 90 * 60_000;
      return e;
    },
    stopTimer(e: SimEntry, hours: number) {
      e.running = false;
      e.hours = roundHours(hours);
      e.updated = now();
    },
    edit(e: SimEntry, change: { hours?: number; notes?: string }) {
      if (change.hours !== undefined) e.hours = roundHours(change.hours);
      if (change.notes !== undefined) e.notes = change.notes;
      e.updated = now();
    },
    /** The timesheet period is locked for the entry. */
    lock(e: SimEntry, reason = "Locked: the timesheet period is closed") {
      e.locked = reason;
      e.updated = now();
    },
    /** The manager approves the timesheet. */
    approve(e: SimEntry) {
      e.closed = true;
      e.locked = "Item Approved and Locked for this Time Period";
      e.updated = now();
    },
    invoice(e: SimEntry) {
      e.billed = true;
      e.locked = "Item Invoiced and Locked";
      e.updated = now();
    },
    archive(p: SimProject) {
      p.active = false;
    },
    unassign(p: SimProject, task: number) {
      const a = assignments.find((x) => x.projectId === p.id);
      for (const t of a?.tasks ?? []) if (t.taskId === task) t.active = false;
    },
    remove(e: SimEntry) {
      entries.splice(entries.indexOf(e), 1);
    },
    deactivateMe() {
      me.is_active = false;
    },
  };

  // ---------- Shapes ----------

  const hoursOf = (e: SimEntry) => (e.running && e.timerStartedAt ? roundHours((Date.now() - e.timerStartedAt) / 3_600_000) : e.hours);
  const shown = (e: SimEntry): HarvestTimeEntry => {
    const p = projects.get(e.projectId)!;
    const u = users.get(e.userId)!;
    const t = tasks.get(e.taskId)!;
    const endMinute = e.startedMinute !== null ? e.startedMinute + Math.round(e.hours * 60) : null;
    return {
      id: e.id,
      spent_date: e.date,
      hours: hoursOf(e),
      rounded_hours: Math.ceil(hoursOf(e) * 4) / 4,
      notes: e.notes === "" ? null : e.notes,
      is_locked: e.locked !== null,
      locked_reason: e.locked,
      is_closed: e.closed,
      is_billed: e.billed,
      is_running: e.running,
      timer_started_at: e.timerStartedAt ? iso(e.timerStartedAt) : null,
      started_time: e.startedMinute !== null ? clockText(e.startedMinute) : null,
      ended_time: endMinute !== null && !e.running ? clockText(endMinute) : null,
      billable: e.billable,
      created_at: iso(e.created),
      updated_at: iso(e.updated),
      user: { id: u.id, name: `${u.first_name} ${u.last_name}` },
      client: { id: p.clientId, name: clients.get(p.clientId) ?? "" },
      project: { id: p.id, name: p.name, code: p.code },
      task: { id: t.id, name: t.name },
      external_reference: e.external ? { service: "inkledger", service_icon_url: "", ...e.external } as HarvestExternalReference : null,
    };
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
  const problem = (status: number, message: string) => json({ message }, status);

  const paged = (url: URL, key: string, list: unknown[]) => {
    const per = Math.min(2000, Math.max(1, Number(url.searchParams.get("per_page") ?? 2000)));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const total = Math.max(1, Math.ceil(list.length / per));
    return json({
      [key]: list.slice((page - 1) * per, page * per),
      per_page: per,
      total_pages: total,
      total_entries: list.length,
      next_page: page < total ? page + 1 : null,
      previous_page: page > 1 ? page - 1 : null,
      page,
      links: { first: `${apiBase}/${key}?page=1&per_page=${per}`, next: null, previous: null, last: `${apiBase}/${key}?page=${total}&per_page=${per}` },
    });
  };

  // ---------- Writes ----------

  /** The fields a create or a change shares; a message when Harvest would refuse. */
  function apply(e: SimEntry, body: Record<string, unknown>, creating: boolean): string | null {
    if (body.spent_date !== undefined) {
      if (!dateOk(body.spent_date)) return "Spent date is not a valid date";
      e.date = body.spent_date;
    } else if (creating) return "Spent date can't be blank";
    if (typeof body.notes === "string") e.notes = body.notes;
    if (body.external_reference !== undefined && body.external_reference !== null) {
      const ext = body.external_reference as Partial<HarvestExternalReference>;
      if (typeof ext.id !== "string" || !ext.id) return "External reference id can't be blank";
      e.external = { id: ext.id, group_id: ext.group_id ?? null, account_id: ext.account_id ?? null, permalink: ext.permalink ?? null };
    }
    const timestamps = company.wants_timestamp_timers;
    if (timestamps && (body.started_time !== undefined || body.ended_time !== undefined)) {
      const from = body.started_time === undefined ? e.startedMinute : minutesOf(body.started_time);
      if (from === null) return "Started time is not a valid time";
      e.startedMinute = from;
      if (body.ended_time !== undefined) {
        const to = minutesOf(body.ended_time);
        if (to === null) return "Ended time is not a valid time";
        // An entry lives within one day.
        if (to <= from) return "Ended time must be after the started time (an entry cannot cross midnight)";
        e.hours = (to - from) / 60;
        e.running = false;
      } else if (creating) {
        e.running = true;
        e.timerStartedAt = Date.now();
      }
    } else if (body.hours !== undefined) {
      if (typeof body.hours !== "number" || body.hours < 0) return "Hours is not a number";
      if (body.hours > 24) return "Hours is too large: a day has 24";
      e.hours = roundHours(body.hours);
      e.running = false;
    } else if (creating) {
      // Neither hours nor an end: a timer starts and keeps counting.
      e.running = true;
      e.timerStartedAt = Date.now();
    }
    e.updated = now();
    return null;
  }

  function create(body: Record<string, unknown>): Response {
    if (body.project_id === undefined) return problem(422, "Project can't be blank");
    if (body.task_id === undefined) return problem(422, "Task can't be blank");
    const p = projects.get(Number(body.project_id));
    const a = p && assignments.find((x) => x.projectId === p.id && x.active);
    if (!p || !a) return problem(422, "Project is not assigned to this user");
    if (!p.active) return problem(422, "Project is not active, time can't be tracked on it");
    const t = a.tasks.find((x) => x.taskId === Number(body.task_id));
    if (!t) return problem(422, "Task is not assigned to this project");
    if (!t.active) return problem(422, "Task assignment is not active");
    const e: SimEntry = {
      id: ++seq,
      userId: me.id,
      projectId: p.id,
      taskId: t.taskId,
      date: "",
      hours: 0,
      notes: "",
      startedMinute: null,
      running: false,
      timerStartedAt: null,
      locked: null,
      closed: false,
      billed: false,
      billable: true,
      external: null,
      created: now(),
      updated: now(),
    };
    const refused = apply(e, body, true);
    if (refused) return problem(422, refused);
    // No idempotency key: every POST is a new entry.
    entries.push(e);
    return json(shown(e), 201);
  }

  function change(e: SimEntry, body: Record<string, unknown>): Response {
    if (e.userId !== me.id) return json({ error: "forbidden", error_description: "You cannot change another person's entry" }, 403);
    if (e.billed) return problem(422, "Time entry is invoiced and cannot be changed");
    if (e.closed) return problem(422, "Time entry is approved and cannot be changed");
    if (e.locked) return problem(422, `Time entry is locked: ${e.locked}`);
    const refused = apply(e, body, false);
    return refused ? problem(422, refused) : json(shown(e));
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    state.calls++;

    // 100 requests in any 15 seconds.
    const t = Date.now();
    state.window = state.window.filter((x) => x > t - 15_000);
    if (state.exhausted || state.window.length >= state.limit) {
      const wait = state.exhausted ? 12 : Math.max(1, Math.ceil((state.window[0] + 15_000 - t) / 1000));
      return json({ message: "Rate limit exceeded. Please wait before retrying." }, 429, { "Retry-After": String(wait) });
    }
    state.window.push(t);

    const ua = headers.get("user-agent");
    if (!ua) return json({ error: "User-Agent required" }, 400);
    state.userAgents.push(ua);
    if (headers.get("authorization") !== `Bearer ${token}` || state.revoked) return json({ error: "invalid_token", error_description: "The access token provided is invalid" }, 401);
    if (headers.get("harvest-account-id") !== accountId) return json({ error: "forbidden", error_description: "This token cannot access this account" }, 403);

    const route = url.pathname.slice(new URL(apiBase).pathname.replace(/\/$/, "").length);
    if (method === "GET" && route === "/users/me") return json(me);
    if (method === "GET" && route === "/company") return json(company);
    if (method === "GET" && route === "/users/me/project_assignments") {
      const rows = assignments.map((a): HarvestProjectAssignment => {
        const p = projects.get(a.projectId)!;
        return {
          id: a.id,
          is_active: a.active && p.active,
          project: { id: p.id, name: p.name, code: p.code },
          client: { id: p.clientId, name: clients.get(p.clientId) ?? "" },
          task_assignments: a.tasks.map((x) => ({ id: x.id, is_active: x.active, billable: true, task: { id: x.taskId, name: tasks.get(x.taskId)?.name ?? "" } })),
        };
      });
      return paged(url, "project_assignments", rows);
    }
    if (method === "GET" && route === "/time_entries") {
      const q = url.searchParams;
      const since = q.get("updated_since");
      if (since !== null && Number.isNaN(Date.parse(since))) return problem(400, "updated_since is not a date and time");
      const from = q.get("from");
      const to = q.get("to");
      const user = q.get("user_id");
      const running = q.get("is_running");
      let rows = entries.filter((e) => state.admin || e.userId === me.id);
      if (user !== null) rows = rows.filter((e) => e.userId === Number(user));
      if (from !== null) rows = rows.filter((e) => e.date >= from);
      if (to !== null) rows = rows.filter((e) => e.date <= to);
      if (since !== null) rows = rows.filter((e) => e.updated >= Date.parse(since));
      if (running !== null) rows = rows.filter((e) => e.running === (running === "true"));
      // Newest first, by spent date then creation.
      rows = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
      return paged(url, "time_entries", rows.map(shown));
    }
    if (method === "POST" && route === "/time_entries") return create(body);
    const one = /^\/time_entries\/(\d+)$/.exec(route);
    if (one) {
      const e = entries.find((x) => x.id === Number(one[1]));
      if (!e) return problem(404, "Not found");
      if (method === "GET") return json(shown(e));
      if (method === "PATCH") return change(e, body);
      if (method === "DELETE") {
        if (e.userId !== me.id) return json({ error: "forbidden" }, 403);
        if (e.billed) return problem(422, "Time entry is invoiced and cannot be deleted");
        if (e.closed) return problem(422, "Time entry is approved and cannot be deleted");
        if (e.locked) return problem(422, `Time entry is locked: ${e.locked}`);
        entries.splice(entries.indexOf(e), 1);
        return new Response("", { status: 200 });
      }
    }
    return problem(404, `No route ${method} ${route}`);
  }

  return {
    apiBase,
    token,
    accountId,
    me,
    colleague,
    company,
    projects,
    entries,
    state,
    website,
    platform,
    project,
    add,
    outside,
    shown,
    /** Every call from now on is refused as over the limit (429, Retry-After 12). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
