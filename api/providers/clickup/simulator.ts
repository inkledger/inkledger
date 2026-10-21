// A ClickUp in memory, for tests: the API v2 endpoints the adapter calls,
// written from ClickUp's documentation (not recorded from a real server), with
// its shapes and traps:
// - the personal token is the whole Authorization header: "Bearer …" is refused (401 OAUTH_025);
//   every answer carries X-RateLimit-Limit/Remaining/Reset (Reset in Unix seconds), a 429 has
//   no Retry-After; errors are { err, ECODE };
// - a 401 can also mean "that team is not yours" (OAUTH_027), for what the token cannot reach;
// - ids are strings (alphanumeric for tasks), user ids are numbers, every date is Unix
//   milliseconds written as a string;
// - /team/{id}/task (the filtered team tasks) leaves out closed tasks unless include_closed and
//   subtasks unless subtasks=true, takes 100 per zero-based page, says last_page, and its
//   date_updated_gt is exclusive; there is no text search;
// - custom task ids: with custom_task_ids=true the id is the custom one and team_id is required;
//   without it only the plain id works; two workspaces can have the same custom id;
// - statuses belong to a list (inherited from the space unless the list has its own), each with a
//   type (open, custom, done, closed); setting a status the list doesn't have is refused;
// - the markdown description comes only with include_markdown_description=true;
// - a date-only due date is the instant 04:00 in the zone of whoever set it, a timed one an
//   instant (due_date_time); the home list moves, the id stays;
// - comments: 25 per call, newest first, paged with start + start_id (several can share a
//   millisecond); creating one answers only { id, hist_id, date }; the text is a list of blocks;
// - time entries are workspace-wide (/team/{id}/time_entries), start/end/duration in
//   milliseconds, the default window is the last 30 days and the user's own entries, a running
//   timer has a negative duration, the update answers a list, `at` is the last change, and the
//   window filters on start, not on change; a workspace can have the ClickApp off (403);
// - webhooks: X-Signature = hex HMAC-SHA256 of the raw body with the webhook's secret, no
//   delivery id of their own (the history items have ids).
import { createHmac } from "node:crypto";

type Rec = Record<string, unknown>;
export type SimUser = { id: number; username: string; email: string; color: string; profilePicture: string | null };
export type SimStatus = { status: string; type: "open" | "custom" | "done" | "closed"; orderindex: number; color: string };
export type SimTeam = { id: string; name: string; customIds: boolean; prefix: string; nextCustom: number; timeTracking: boolean; spaceStatuses: SimStatus[] };
export type SimList = { id: string; name: string; team: string; folder: { id: string; name: string } | null; statuses: SimStatus[] | null; access: boolean };
export type SimComment = { id: string; date: number; by: number; blocks: Rec[]; text: string };
export type SimTask = {
  id: string;
  customId: string | null;
  team: string;
  list: string;
  name: string;
  description: string;
  status: string;
  created: number;
  updated: number;
  closedAt: number | null;
  doneAt: number | null;
  creator: number;
  assignees: number[];
  watchers: Set<number>;
  tags: string[];
  parent: string | null;
  priority: number | null;
  due: { ms: number; time: boolean } | null;
  estimate: number | null;
  itemType: number;
  deleted: boolean;
  comments: SimComment[];
};
export type SimEntry = { id: string; task: string | null; team: string; user: number; start: number; duration: number; description: string; billable: boolean; at: number };

const PRIORITIES = ["urgent", "high", "normal", "low"];
export const defaultStatuses = (): SimStatus[] => [
  { status: "to do", type: "open", orderindex: 0, color: "#d3d3d3" },
  { status: "in progress", type: "custom", orderindex: 1, color: "#4194f6" },
  { status: "complete", type: "closed", orderindex: 2, color: "#6bc950" },
];

/** The instant a wall-clock time in a zone is (04:00 local is where ClickUp puts a date without a time). */
export function localInstant(day: string, hour: number, zone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  const guess = Date.UTC(y, m - 1, d, hour);
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

export function clickupSimulator(apiBase = "https://api.clickup.com/api/v2") {
  const token = "pk_1234567_SIMULATEDPERSONALTOKEN";
  const web = apiBase.replace(/^(https?:\/\/)api\./, "$1app.").replace(/\/api\/v2$/, "");
  const me: SimUser = { id: 1234567, username: "Mario Rossi", email: "mario@acme.example", color: "#7b68ee", profilePicture: "https://attachments.clickup.com/profilePictures/1234567.jpg" };
  const anna: SimUser = { id: 7654321, username: "Anna Bianchi", email: "anna@acme.example", color: "#ff7800", profilePicture: null };
  const users = new Map<number, SimUser>([
    [me.id, me],
    [anna.id, anna],
  ]);
  const teams = new Map<string, SimTeam>();
  const lists = new Map<string, SimList>();
  const tasks: SimTask[] = [];
  const entries: SimEntry[] = [];
  let seq = 0;
  const num = () => String(++seq).padStart(5, "0");
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  const state = { exhausted: false, calls: 0, revoked: false, limit: 100, commentsPage: 25, auth: [] as string[] };

  // ---------- Data ----------

  const workspace = (name: string, o: { customIds?: boolean; prefix?: string; timeTracking?: boolean; statuses?: SimStatus[] } = {}): SimTeam => {
    const known = [...teams.values()].find((t) => t.name === name);
    if (known) return known;
    const t: SimTeam = { id: `9${String(10_000_000 + teams.size * 7919)}`, name, customIds: o.customIds ?? false, prefix: o.prefix ?? "ENG", nextCustom: 1, timeTracking: o.timeTracking ?? true, spaceStatuses: o.statuses ?? defaultStatuses() };
    teams.set(t.id, t);
    return t;
  };
  const main = workspace("Acme");
  const list = (name: string, o: { team?: SimTeam; folder?: string; statuses?: SimStatus[]; access?: boolean } = {}): SimList => {
    const team = o.team ?? main;
    const known = [...lists.values()].find((l) => l.name === name && l.team === team.id);
    if (known) {
      if (o.access !== undefined) known.access = o.access;
      return known;
    }
    const l: SimList = { id: `90${String(1_000_000 + lists.size * 13)}`, name, team: team.id, folder: o.folder ? { id: `80${String(100_000 + lists.size)}`, name: o.folder } : null, statuses: o.statuses ?? null, access: o.access ?? true };
    lists.set(l.id, l);
    return l;
  };
  const statusesOf = (l: SimList): SimStatus[] => l.statuses ?? teams.get(l.team)!.spaceStatuses;
  const addUser = (name: string) => {
    const u: SimUser = { id: 9_000_000 + users.size, username: name, email: `${name.split(" ")[0].toLowerCase()}@acme.example`, color: "#000000", profilePicture: null };
    users.set(u.id, u);
    return u;
  };

  const add = (name: string, o: { list?: SimList; assignees?: number[]; description?: string; status?: string; due?: { ms: number; time: boolean }; tags?: string[]; parent?: SimTask; priority?: number; estimate?: number; itemType?: number; author?: number; customId?: string | null } = {}): SimTask => {
    const l = o.list ?? list("Backlog");
    const team = teams.get(l.team)!;
    const at = earlier();
    const t: SimTask = {
      id: `86c${num()}`,
      customId: o.customId !== undefined ? o.customId : team.customIds ? `${team.prefix}-${team.nextCustom++}` : null,
      team: team.id,
      list: o.parent ? (tasks.find((x) => x.id === o.parent!.id)?.list ?? l.id) : l.id,
      name,
      description: o.description ?? "",
      status: o.status ?? statusesOf(l)[0].status,
      created: at,
      updated: at,
      closedAt: null,
      doneAt: null,
      creator: o.author ?? me.id,
      assignees: o.assignees ?? [me.id],
      watchers: new Set(),
      tags: o.tags ?? [],
      parent: o.parent?.id ?? null,
      priority: o.priority ?? null,
      due: o.due ?? null,
      estimate: o.estimate ?? null,
      itemType: o.itemType ?? 0,
      deleted: false,
      comments: [],
    };
    tasks.push(t);
    return t;
  };
  const keyOf = (t: SimTask) => t.customId ?? `CU-${t.id}`;
  const taskById = (id: string) => tasks.find((t) => t.id === id && !t.deleted);
  const listOf = (t: SimTask) => lists.get(t.list)!;
  const visible = (t: SimTask) => listOf(t).access;
  const statusOf = (t: SimTask): SimStatus => statusesOf(listOf(t)).find((s) => s.status === t.status) ?? { status: t.status, type: "custom", orderindex: 0, color: "#000000" };
  const isClosed = (t: SimTask) => ["closed", "done"].includes(statusOf(t).type);

  const setStatus = (t: SimTask, name: string) => {
    t.status = name;
    const type = statusOf(t).type;
    t.closedAt = type === "closed" ? now() : null;
    t.doneAt = type === "done" ? now() : null;
    t.updated = now();
  };

  const comment = (t: SimTask, o: { text?: string; blocks?: Rec[]; by?: number }): SimComment => {
    const text = o.text ?? "";
    const c: SimComment = { id: `45${num()}`, date: now(), by: o.by ?? me.id, blocks: o.blocks ?? [{ text }, { text: "\n", attributes: {} }], text };
    t.comments.push(c);
    t.updated = now();
    return c;
  };

  const entry = (t: SimTask | null, o: { start: number; duration: number; user?: number; description?: string; billable?: boolean; team?: SimTeam }): SimEntry => {
    const e: SimEntry = { id: `2800763136${num()}`, task: t?.id ?? null, team: t?.team ?? (o.team ?? main).id, user: o.user ?? me.id, start: o.start, duration: o.duration, description: o.description ?? "", billable: o.billable ?? false, at: now() };
    entries.push(e);
    return e;
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign(t: SimTask, ids: number[]) {
      t.assignees = ids;
      t.updated = now();
    },
    status(t: SimTask, name: string) {
      setStatus(t, name);
    },
    retitle(t: SimTask, name: string) {
      t.name = name;
      t.updated = now();
    },
    comment: (t: SimTask, text: string, by = anna.id) => comment(t, { text, by }),
    /** The home list changes, the id (and the key) do not. */
    moveToList(t: SimTask, l: SimList) {
      t.list = l.id;
      t.team = l.team;
      t.updated = now();
    },
    /** Gone: a 404 from now on. */
    delete(t: SimTask) {
      t.deleted = true;
      t.updated = now();
    },
    /** The user loses (or regains) a list: a 401 "team not authorized" for it and its tasks. */
    access(l: SimList, on: boolean) {
      l.access = on;
    },
    renameList(l: SimList, name: string) {
      l.name = name;
      for (const t of tasks.filter((x) => x.list === l.id)) t.updated = now();
    },
    /** Someone changes an entry: `at` moves, its start does not. */
    editEntry(e: SimEntry, change: Partial<Pick<SimEntry, "duration" | "description" | "billable">>) {
      Object.assign(e, change, { at: now() });
    },
    deleteEntry(e: SimEntry) {
      entries.splice(entries.indexOf(e), 1);
    },
  };

  // ---------- Shapes ----------

  const userRec = (id: number): Rec => {
    const u = users.get(id) ?? { id, username: `User ${id}`, email: "", color: "#000000", profilePicture: null };
    return { id: u.id, username: u.username, email: u.email, color: u.color, initials: u.username.split(" ").map((w) => w[0]).join(""), profilePicture: u.profilePicture };
  };
  const statusRec = (s: SimStatus): Rec => ({ id: `sc${s.orderindex}_${s.status.replace(/\W/g, "")}`, status: s.status, color: s.color, orderindex: s.orderindex, type: s.type });
  const ms = (n: number | null) => (n === null ? null : String(n));
  const taskRec = (t: SimTask, markdown = false): Rec => {
    const l = listOf(t);
    return {
      id: t.id,
      custom_id: t.customId,
      custom_item_id: t.itemType,
      name: t.name,
      text_content: t.description,
      description: t.description,
      ...(markdown ? { markdown_description: t.description } : {}),
      status: statusRec(statusOf(t)),
      orderindex: "1",
      date_created: ms(t.created),
      date_updated: ms(t.updated),
      date_closed: ms(t.closedAt),
      date_done: ms(t.doneAt),
      archived: false,
      creator: userRec(t.creator),
      assignees: t.assignees.map(userRec),
      watchers: [...t.watchers].map(userRec),
      tags: t.tags.map((name) => ({ name, tag_fg: "#fff", tag_bg: "#000" })),
      parent: t.parent,
      priority: t.priority === null ? null : { id: String(t.priority + 1), priority: PRIORITIES[t.priority], color: "#f50000", orderindex: String(t.priority + 1) },
      due_date: ms(t.due?.ms ?? null),
      due_date_time: t.due ? t.due.time : null,
      start_date: null,
      points: null,
      time_estimate: t.estimate,
      time_spent: entries.filter((e) => e.task === t.id && e.duration > 0).reduce((a, e) => a + e.duration, 0) || undefined,
      team_id: t.team,
      url: `${web}/t/${t.customId ? `${t.team}/${t.customId}` : t.id}`,
      list: { id: l.id, name: l.name, access: l.access },
      folder: l.folder ? { id: l.folder.id, name: l.folder.name, hidden: false, access: true } : { id: `${l.id}0`, name: "hidden", hidden: true, access: true },
      space: { id: `55${t.team.slice(2)}` },
    };
  };
  const commentRec = (c: SimComment): Rec => ({ id: c.id, comment: c.blocks, comment_text: c.text, user: userRec(c.by), resolved: false, assignee: null, assigned_by: null, reactions: [], date: String(c.date) });
  const entryRec = (e: SimEntry): Rec => {
    const t = e.task ? tasks.find((x) => x.id === e.task) : undefined;
    return {
      id: e.id,
      task: t && !t.deleted ? { id: t.id, name: t.name, status: statusRec(statusOf(t)), custom_type: null, ...(t.customId ? { custom_id: t.customId } : {}) } : "0",
      wid: e.team,
      user: userRec(e.user),
      billable: e.billable,
      start: String(e.start),
      end: e.duration > 0 ? String(e.start + e.duration) : null,
      duration: String(e.duration),
      description: e.description,
      tags: [],
      source: "clickup",
      at: String(e.at),
    };
  };

  // ---------- HTTP ----------

  const reset = () => Math.ceil((Date.now() + 30_000) / 1000);
  const limitHeaders = (): Record<string, string> => ({ "X-RateLimit-Limit": String(state.limit), "X-RateLimit-Remaining": String(state.exhausted ? 0 : Math.max(0, state.limit - (state.calls % state.limit))), "X-RateLimit-Reset": String(reset()) });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...limitHeaders() } });
  const fail = (status: number, err: string, ECODE: string) => json({ err, ECODE }, status);
  const missingTask = () => fail(404, "Task not found", "ITEM_015");
  const outOfReach = () => fail(401, "Team not authorized", "OAUTH_027");

  /** The task a path names, by plain id or (custom_task_ids=true + team_id) by custom id. */
  function resolveTask(id: string, q: URLSearchParams): SimTask | Response {
    if (q.get("custom_task_ids") === "true") {
      const team = q.get("team_id");
      if (!team) return fail(400, "team_id is required when custom_task_ids is true", "ITEM_037");
      if (!teams.has(team)) return outOfReach();
      const t = tasks.find((x) => !x.deleted && x.team === team && x.customId?.toUpperCase() === id.toUpperCase());
      return t ?? missingTask();
    }
    const t = taskById(id);
    return t ?? missingTask();
  }
  const reachable = (t: SimTask): Response | null => (visible(t) ? null : outOfReach());

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body: Rec = typeof init?.body === "string" ? (JSON.parse(init.body) as Rec) : {};
    const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
    state.calls++;
    const auth = headers.get("authorization");
    state.auth.push(auth ?? "");
    if (!auth) return fail(401, "Authorization required", "OAUTH_017");
    if (auth !== token || state.revoked) return fail(401, "Token invalid", "OAUTH_025");
    if (state.exhausted) return fail(429, "Rate limit reached", "APP_002");
    const path = url.pathname.slice(apiPath.length);
    const q = url.searchParams;

    if (path === "/user") return json({ user: userRec(me.id) });
    if (path === "/team") return json({ teams: [...teams.values()].map((t) => ({ id: t.id, name: t.name, color: "#4194f6", avatar: null, members: [{ user: userRec(me.id) }] })) });

    let m = /^\/team\/([^/]+)\/space$/.exec(path);
    if (m) {
      const team = teams.get(m[1]);
      if (!team) return outOfReach();
      return json({ spaces: [{ id: `55${team.id.slice(2)}`, name: "Space", private: false, statuses: team.spaceStatuses.map(statusRec) }] });
    }

    m = /^\/team\/([^/]+)\/task$/.exec(path);
    if (m && method === "GET") {
      const team = teams.get(m[1]);
      if (!team) return outOfReach();
      const page = Number(q.get("page") ?? 0);
      if (!Number.isInteger(page) || page < 0) return fail(400, "page must be zero or more", "ITEM_040");
      const assignees = q.getAll("assignees[]").map(Number);
      const gt = q.get("date_updated_gt");
      const lt = q.get("date_updated_lt");
      const closed = q.get("include_closed") === "true";
      const subtasks = q.get("subtasks") === "true";
      let found = tasks
        .filter((t) => !t.deleted && t.team === team.id && visible(t))
        .filter((t) => closed || !isClosed(t))
        .filter((t) => subtasks || !t.parent)
        .filter((t) => !assignees.length || assignees.some((a) => t.assignees.includes(a)))
        .filter((t) => gt === null || t.updated > Number(gt))
        .filter((t) => lt === null || t.updated < Number(lt));
      const by = q.get("order_by") ?? "created";
      const key = (t: SimTask) => (by === "updated" ? t.updated : by === "due_date" ? (t.due?.ms ?? 0) : t.created);
      found = found.sort((a, b) => (by === "id" ? a.id.localeCompare(b.id) : key(a) - key(b) || a.id.localeCompare(b.id)));
      if (q.get("reverse") === "true") found.reverse();
      const slice = found.slice(page * 100, page * 100 + 100);
      return json({ tasks: slice.map((t) => taskRec(t, q.get("include_markdown_description") === "true")), last_page: (page + 1) * 100 >= found.length });
    }

    m = /^\/task\/([^/]+)$/.exec(path);
    if (m) {
      const t = resolveTask(decodeURIComponent(m[1]), q);
      if (t instanceof Response) return t;
      const no = reachable(t);
      if (no) return no;
      if (method === "PUT") {
        if (typeof body.name === "string") t.name = body.name;
        if (typeof body.description === "string") t.description = body.description;
        if (typeof body.status === "string") {
          if (!statusesOf(listOf(t)).some((s) => s.status === body.status)) return fail(400, "Status not found", "CRTSK_001");
          setStatus(t, body.status);
        }
        const w = body.watchers as { add?: number[]; rem?: number[] } | undefined;
        if (w) {
          for (const id of w.add ?? []) t.watchers.add(id);
          for (const id of w.rem ?? []) t.watchers.delete(id);
        }
        t.updated = now();
      }
      return json(taskRec(t, q.get("include_markdown_description") === "true"));
    }

    m = /^\/task\/([^/]+)\/comment$/.exec(path);
    if (m) {
      const t = taskById(m[1]);
      if (!t) return missingTask();
      const no = reachable(t);
      if (no) return no;
      if (method === "POST") {
        if (typeof body.comment_text !== "string" || !body.comment_text.trim()) return fail(400, "Comment text cannot be empty", "COMMENT_001");
        const c = comment(t, { text: body.comment_text });
        return json({ id: Number(c.id), hist_id: `hist-${c.id}`, date: c.date });
      }
      // Newest first; 25 a call; start + start_id continue after that comment.
      const sorted = [...t.comments].sort((a, b) => b.date - a.date || b.id.localeCompare(a.id));
      const start = q.get("start");
      const startId = q.get("start_id");
      const after = start === null ? sorted : sorted.filter((c) => c.date < Number(start) || (c.date === Number(start) && startId !== null && c.id.localeCompare(startId) < 0));
      return json({ comments: after.slice(0, state.commentsPage).map(commentRec) });
    }

    m = /^\/list\/([^/]+)$/.exec(path);
    if (m) {
      const l = lists.get(m[1]);
      if (!l) return fail(404, "List not found", "LIST_001");
      if (!l.access) return outOfReach();
      return json({ id: l.id, name: l.name, statuses: statusesOf(l).map(statusRec), folder: l.folder ?? { id: "0", name: "hidden", hidden: true } });
    }

    m = /^\/team\/([^/]+)\/time_entries(?:\/([^/]+))?$/.exec(path);
    if (m) {
      const team = teams.get(m[1]);
      if (!team) return outOfReach();
      if (!team.timeTracking) return fail(403, "Time tracking is not enabled in this Workspace", "TIMEENTRY_001");
      const id = m[2];
      if (!id && method === "GET") {
        const startQ = q.get("start_date");
        const endQ = q.get("end_date");
        const t0 = Date.now();
        // No dates: the last 30 days. The window is on the entry's start.
        const from = startQ !== null ? Number(startQ) : t0 - 30 * 86_400_000;
        const to = endQ !== null ? Number(endQ) : t0;
        if (Number.isNaN(from) || Number.isNaN(to)) return fail(400, "start_date and end_date are Unix milliseconds", "TIMEENTRY_002");
        const only = q.get("task_id");
        const list2 = entries.filter((e) => e.team === team.id && e.user === me.id && e.start >= from && e.start <= to && (!only || e.task === only)).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        return json({ data: list2.map(entryRec) });
      }
      if (!id && method === "POST") {
        if (typeof body.start !== "number" || body.start <= 0) return fail(400, "start is required (Unix milliseconds)", "TIMEENTRY_003");
        if (typeof body.duration !== "number" || body.duration <= 0) return fail(400, "duration must be positive", "TIMEENTRY_004");
        let task: SimTask | null = null;
        if (typeof body.tid === "string" && body.tid !== "0") {
          const found = taskById(body.tid);
          if (!found || found.team !== team.id) return missingTask();
          if (!visible(found)) return outOfReach();
          task = found;
        }
        const e = entry(task, { start: body.start, duration: body.duration, description: typeof body.description === "string" ? body.description : "", billable: body.billable === true, team });
        return json({ data: entryRec(e) }, 200);
      }
      const e = entries.find((x) => x.id === id && x.team === team.id);
      if (!e) return fail(404, "Time entry not found", "TIMEENTRY_005");
      if (method === "GET") return json({ data: entryRec(e) });
      if (e.user !== me.id) return fail(403, "You can only change your own time entries", "TIMEENTRY_006");
      if (method === "DELETE") {
        entries.splice(entries.indexOf(e), 1);
        return json({ data: [entryRec(e)] });
      }
      if (method === "PUT") {
        if (body.duration !== undefined) {
          if (typeof body.duration !== "number" || body.duration <= 0) return fail(400, "duration must be positive", "TIMEENTRY_004");
          e.duration = body.duration;
        }
        if (typeof body.start === "number") e.start = body.start;
        if (typeof body.description === "string") e.description = body.description;
        if (typeof body.billable === "boolean") e.billable = body.billable;
        e.at = now();
        // The update answers a list.
        return json({ data: [entryRec(e)] });
      }
    }

    return fail(404, `unmocked ${method} ${path}`, "ROUTE_001");
  }

  // ---------- Webhooks ----------

  type HookEvent = "taskCreated" | "taskUpdated" | "taskDeleted" | "taskStatusUpdated" | "taskMoved" | "taskCommentPosted" | "taskTimeTrackedUpdated";
  /** A delivery as ClickUp sends it, signed with the webhook's secret (X-Signature), the raw body kept. */
  const webhook = (event: HookEvent, taskId: string, o: { secret: string; signedWith?: string; ageMs?: number; items?: number }) => {
    const at = Date.now() - (o.ageMs ?? 0);
    const rawBody = JSON.stringify({
      webhook_id: "4b6bac1a-bc5a-4a32-9e2f-000000000001",
      event,
      task_id: taskId,
      history_items: Array.from({ length: o.items ?? 1 }, () => ({ id: `${at}${num()}`, type: 1, date: String(at), field: "status", user: userRec(me.id), before: null, after: null })),
    });
    return { rawBody, headers: { "x-signature": createHmac("sha256", o.signedWith ?? o.secret).update(rawBody, "utf8").digest("hex"), "content-type": "application/json" } };
  };

  return {
    apiBase,
    web,
    token,
    me,
    anna,
    users,
    teams,
    main,
    lists,
    tasks,
    entries,
    state,
    workspace,
    list,
    addUser,
    add,
    entry,
    comment,
    outside,
    keyOf,
    webhook,
    /** A due date as ClickUp keeps it: a day is 04:00 in the zone of whoever set it, a timed one an instant. */
    dueOn: (day: string, zone: string): { ms: number; time: boolean } => ({ ms: localInstant(day, 4, zone), time: false }),
    dueAt: (iso: string): { ms: number; time: boolean } => ({ ms: Date.parse(iso), time: true }),
    /** Every call from now on is refused as over the limit (429, no Retry-After). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
