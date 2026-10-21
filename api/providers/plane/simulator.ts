// A Plane in memory, for tests: the REST v1 endpoints the adapter calls,
// written from Plane's documentation (not recorded from a real server), with
// its shapes and traps:
// - X-API-Key or 401 ({ error }); 60 calls a minute per key, X-RateLimit-* on every answer, 429 with Retry-After and a { detail } body;
// - lists by cursor ("per_page:page:offset"), per_page tops out at 100, next_cursor is there on the last page too (next_page_results says), default order is -created_at;
// - ids are uuids; the number people see is `sequence_id`, counted per project and never reused; the key PROJ-12 is the project's current identifier, so an
//   identifier renamed makes the old key a 404 (and frees it for another project);
// - objects (state, assignees, labels, created_by) only with `expand`, else uuids; a change answers with uuids; an old server ignores expand;
// - an item with no description has "<p></p>"; dates are plain, created_at/updated_at are UTC with microseconds;
// - soft-deleted items vanish (404), archived ones leave the lists but can be read, drafts are never listed;
// - a project the user left answers 403 on its own paths, 404 by key; an archived project is still listed;
// - worklogs are whole minutes, on a day (logged_at) or, on an older server, the day they were created in UTC;
// - self-hosted servers send avatars as paths on their own site.
import { hmacHex } from "../core/webhooks";
import type { PlaneActivity, PlaneComment, PlaneIssue, PlaneLabel, PlaneProject, PlaneState, PlaneStateGroup, PlaneUser, PlaneWorklog } from "./client";

type SimComment = { id: string; html: string; actor: string; created: number; updated: number };
type SimActivity = { id: string; created: number; verb: string; field: string | null; oldValue: string | null; newValue: string | null; oldId: string | null; newId: string | null; actor: string };
type SimWorklog = { id: string; minutes: number; description: string; user: string; loggedAt: string | null; created: number };
export type SimIssue = {
  id: string;
  project: string;
  seq: number;
  name: string;
  description: string | null;
  state: string;
  priority: PlaneIssue["priority"];
  assignees: string[];
  labels: string[];
  createdBy: string;
  start: string | null;
  target: string | null;
  created: number;
  updated: number;
  completed: number | null;
  archived: number | null;
  deleted: number | null;
  draft: boolean;
  parent: string | null;
  comments: SimComment[];
  activities: SimActivity[];
  worklogs: SimWorklog[];
};
export type SimProject = { id: string; identifier: string; name: string; seq: number; access: boolean; archived: boolean; deleted: boolean; states: PlaneState[] };

const STATES: [string, PlaneStateGroup, string][] = [
  ["Backlog", "backlog", "#60646c"],
  ["Todo", "unstarted", "#3a3a3a"],
  ["In Progress", "started", "#f59e0b"],
  ["Done", "completed", "#16a34a"],
  ["Cancelled", "cancelled", "#dc2626"],
];

export function planeSimulator(apiBase = "https://api.plane.so", workspace = "acme", me: PlaneUser = { id: "", first_name: "Mario", last_name: "Rossi", display_name: "mrossi", email: "mario@acme.example" }) {
  const token = "plane_api_simulated";
  const origin = new URL(apiBase).origin;
  const prefix = new URL(apiBase).pathname.replace(/\/+$/, "");
  const cloud = new URL(apiBase).hostname === "api.plane.so";
  const web = cloud ? "https://app.plane.so" : `${origin}${prefix}`;
  let n = 0;
  const uuid = () => `5a1f0000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const avatar = (key: string) => (cloud ? `https://cdn.plane.so/avatars/${key}.png` : `/api/users/avatar/${key}.png`);

  const users = new Map<string, PlaneUser>();
  const addUser = (u: Omit<PlaneUser, "id"> & { id?: string }): PlaneUser => {
    const id = u.id || uuid();
    const user = { ...u, id, avatar: u.avatar ?? avatar(id.slice(-4)) };
    users.set(id, user);
    return user;
  };
  const self = addUser({ ...me, id: me.id || undefined });
  const anna = addUser({ first_name: "Anna", last_name: "Bianchi", display_name: "anna.b", email: "anna@acme.example" });
  const projects = new Map<string, SimProject>();
  const issues: SimIssue[] = [];
  const labelIds = new Map<string, string>();
  const state = {
    limit: 60,
    calls: 0,
    windowStart: Date.now(),
    exhausted: false,
    revoked: false,
    /** An older self-hosted server answers uuids whatever expand says */
    ignoreExpand: false,
    /** An older server has no day on a worklog: it lands on the day (UTC) it was created */
    noLoggedAt: false,
  };
  // Strictly increasing and never behind the real clock, so "changed since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  // What existed before the test began is dated hours ago, one second apart.
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  /** UTC with microseconds, as Plane writes it. */
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  const label = (name: string) => {
    const known = labelIds.get(name);
    if (known) return known;
    const id = uuid();
    labelIds.set(name, id);
    return id;
  };

  const project = (identifier: string, o: { name?: string; access?: boolean; archived?: boolean } = {}): SimProject => {
    const known = [...projects.values()].find((p) => p.identifier === identifier && !p.deleted);
    if (known) {
      if (o.access !== undefined) known.access = o.access;
      if (o.archived !== undefined) known.archived = o.archived;
      return known;
    }
    const id = uuid();
    const p: SimProject = {
      id,
      identifier,
      name: o.name ?? `${identifier.charAt(0)}${identifier.slice(1).toLowerCase()} project`,
      seq: 0,
      access: o.access ?? true,
      archived: o.archived ?? false,
      deleted: false,
      states: STATES.map(([name, group, color], i) => ({ id: uuid(), name, group, color, sequence: 15000 + i * 10000, default: i === 1, project: id })),
    };
    projects.set(id, p);
    return p;
  };
  const projectByIdentifier = (identifier: string) => [...projects.values()].find((p) => p.identifier.toLowerCase() === identifier.toLowerCase() && !p.deleted);
  const stateNamed = (p: SimProject, name: string) => p.states.find((s) => s.name === name || s.group === name) ?? p.states[1];

  const activity = (i: SimIssue, a: Partial<SimActivity> & { verb: string }, by = self.id) =>
    i.activities.push({ id: uuid(), created: now(), field: null, oldValue: null, newValue: null, oldId: null, newId: null, actor: by, ...a });

  const add = (
    identifier: string,
    title: string,
    o: { assignee?: string | null; labels?: string[]; description?: string; priority?: PlaneIssue["priority"]; target?: string; start?: string; state?: string; parent?: string; draft?: boolean; author?: string } = {},
  ): SimIssue => {
    const p = project(identifier);
    const at = earlier();
    const st = stateNamed(p, o.state ?? "Todo");
    const i: SimIssue = {
      id: uuid(),
      project: p.id,
      seq: ++p.seq,
      name: title,
      description: o.description ?? null,
      state: st.id,
      priority: o.priority ?? "none",
      assignees: o.assignee === null ? [] : [o.assignee ?? self.id],
      labels: (o.labels ?? []).map(label),
      createdBy: o.author ?? self.id,
      start: o.start ?? null,
      target: o.target ?? null,
      created: at,
      updated: at,
      completed: st.group === "completed" ? at : null,
      archived: null,
      deleted: null,
      draft: o.draft ?? false,
      parent: o.parent ?? null,
      comments: [],
      activities: [],
      worklogs: [],
    };
    issues.push(i);
    activity(i, { verb: "created", created: at }, i.createdBy);
    return i;
  };
  const projectOf = (i: SimIssue) => projects.get(i.project) as SimProject;
  const keyOf = (i: SimIssue) => `${projectOf(i).identifier}-${i.seq}`;
  const listed = (i: SimIssue) => !i.deleted && !i.archived && !i.draft && !projectOf(i).deleted;

  // ---------- Changes, whoever makes them ----------

  const setState = (i: SimIssue, name: string, by = self.id) => {
    const p = projectOf(i);
    const to = p.states.find((s) => s.id === name) ?? stateNamed(p, name);
    if (to.id === i.state) return;
    const from = p.states.find((s) => s.id === i.state);
    i.state = to.id;
    i.completed = to.group === "completed" ? now() : null;
    activity(i, { verb: "updated", field: "state", oldValue: from?.name ?? null, newValue: to.name, oldId: from?.id ?? null, newId: to.id }, by);
    i.updated = now();
  };

  /** What happens elsewhere (the web app, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign(i: SimIssue, user: string | null) {
      for (const old of i.assignees) activity(i, { verb: "deleted", field: "assignees", oldValue: users.get(old)?.display_name ?? old, oldId: old }, anna.id);
      i.assignees = user === null ? [] : [user];
      if (user) activity(i, { verb: "created", field: "assignees", newValue: users.get(user)?.display_name ?? user, newId: user }, anna.id);
      i.updated = now();
    },
    setState: (i: SimIssue, name: string) => setState(i, name, anna.id),
    retitle(i: SimIssue, title: string) {
      activity(i, { verb: "updated", field: "name", oldValue: i.name, newValue: title }, anna.id);
      i.name = title;
      i.updated = now();
    },
    comment(i: SimIssue, html: string, by = anna.id) {
      const at = now();
      i.comments.push({ id: uuid(), html, actor: by, created: at, updated: at });
      i.updated = now();
    },
    /** Soft delete: the item is gone from every list and read (404); its sequence id is never given again. */
    remove(i: SimIssue) {
      i.deleted = now();
    },
    /** Archived: out of the lists, still readable. */
    archive(i: SimIssue) {
      i.archived = now();
    },
    /** The project's identifier changes: the keys change with it, the old ones are 404 and may be taken. */
    renameIdentifier(p: SimProject, to: string) {
      p.identifier = to;
      for (const i of issues.filter((x) => x.project === p.id)) i.updated = now();
    },
    /** The user leaves (or rejoins) a project: 403 for its paths, and it is not listed. */
    access(identifier: string, on: boolean) {
      project(identifier, { access: on });
    },
    archiveProject(identifier: string, on = true) {
      project(identifier, { archived: on });
    },
  };

  /** A worklog on an item: on a day (logged_at), or with none, as an older server keeps it. */
  const worklog = (i: SimIssue, o: { minutes: number; day?: string | null; at?: number; user?: string; description?: string }) => {
    const w: SimWorklog = { id: uuid(), minutes: o.minutes, description: o.description ?? "", user: o.user ?? self.id, loggedAt: o.day === undefined ? null : o.day, created: o.at ?? now() };
    i.worklogs.push(w);
    return w;
  };

  // ---------- Shapes ----------

  const userShown = (id: string): PlaneUser => users.get(id) ?? { id, display_name: `user-${id.slice(-4)}` };
  const stateOf = (i: SimIssue) => projectOf(i).states.find((s) => s.id === i.state) as PlaneState;
  const labelShown = (id: string): PlaneLabel => ({ id, name: [...labelIds].find(([, v]) => v === id)?.[0] ?? "label", color: "#3b82f6" });
  const shown = (i: SimIssue, expand: Set<string>): PlaneIssue => {
    const ex = (k: string) => expand.has(k) && !state.ignoreExpand;
    return {
      id: i.id,
      sequence_id: i.seq,
      name: i.name,
      description_html: i.description ?? "<p></p>",
      description_stripped: (i.description ?? "").replace(/<[^>]*>/g, ""),
      priority: i.priority,
      state: ex("state") ? stateOf(i) : i.state,
      assignees: ex("assignees") ? i.assignees.map(userShown) : [...i.assignees],
      labels: ex("labels") ? i.labels.map(labelShown) : [...i.labels],
      project: i.project,
      parent: i.parent,
      created_by: ex("created_by") ? userShown(i.createdBy) : i.createdBy,
      start_date: i.start,
      target_date: i.target,
      estimate_point: null,
      created_at: iso(i.created),
      updated_at: iso(i.updated),
      completed_at: i.completed === null ? null : iso(i.completed),
      archived_at: i.archived === null ? null : iso(i.archived),
      deleted_at: i.deleted === null ? null : iso(i.deleted),
      is_draft: i.draft,
    };
  };
  const projectShown = (p: SimProject): PlaneProject => ({ id: p.id, identifier: p.identifier, name: p.name, archived_at: p.archived ? iso(clock) : null, deleted_at: null, workspace: workspace });
  const commentShown = (c: SimComment): PlaneComment => ({ id: c.id, comment_html: c.html, comment_stripped: c.html.replace(/<[^>]*>/g, ""), actor: c.actor, created_at: iso(c.created), updated_at: iso(c.updated) });
  const activityShown = (a: SimActivity): PlaneActivity => ({ id: a.id, created_at: iso(a.created), verb: a.verb, field: a.field, old_value: a.oldValue, new_value: a.newValue, old_identifier: a.oldId, new_identifier: a.newId, actor: a.actor });
  const worklogShown = (w: SimWorklog): PlaneWorklog => ({
    id: w.id,
    duration: w.minutes,
    description: w.description,
    logged_by: w.user,
    ...(w.loggedAt !== null && !state.noLoggedAt ? { logged_at: w.loggedAt } : {}),
    created_at: iso(w.created),
    updated_at: iso(w.created),
  });

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    // 60 a minute per key, counted in a window that opens with the first call.
    const t = Date.now();
    if (t - state.windowStart >= 60_000) {
      state.windowStart = t;
      state.calls = 0;
    }
    state.calls++;
    const resetAt = Math.ceil((state.windowStart + 60_000) / 1000);
    const rate: Record<string, string> = { "X-RateLimit-Remaining": String(Math.max(0, state.limit - state.calls)), "X-RateLimit-Reset": String(resetAt) };
    const reply = (b: unknown, status = 200, extra: Record<string, string> = {}) => json(b, status, { ...rate, ...extra });

    if (url.origin !== origin || !url.pathname.startsWith(`${prefix}/api/v1/`)) return json({ error: "not found" }, 404);
    if (headers.get("x-api-key") !== token || state.revoked) return reply({ error: "Given API token is not valid" }, 401);
    if (state.exhausted || state.calls > state.limit) {
      const wait = state.exhausted ? 30 : Math.max(1, resetAt - Math.floor(t / 1000));
      return reply({ detail: `Request was throttled. Expected available in ${wait} seconds.` }, 429, { "Retry-After": String(wait), "X-RateLimit-Remaining": "0" });
    }

    const paged = <T>(list: T[], serialize: (t: T) => unknown = (x) => x) => {
      const per = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? 100)));
      const cursor = url.searchParams.get("cursor");
      const page = cursor ? Math.max(0, Number(cursor.split(":")[1])) : 0;
      const results = list.slice(page * per, (page + 1) * per).map(serialize);
      return reply({
        grouping: null,
        results,
        next_cursor: `${per}:${page + 1}:0`,
        prev_cursor: `${per}:${page - 1}:1`,
        next_page_results: (page + 1) * per < list.length,
        prev_page_results: page > 0,
        count: results.length,
        total_pages: Math.max(1, Math.ceil(list.length / per)),
        total_results: list.length,
        extra_stats: null,
      });
    };
    const expand = new Set((url.searchParams.get("expand") ?? "").split(",").filter(Boolean));

    const path = url.pathname.slice(`${prefix}/api/v1`.length);
    if (path === "/users/me/") return reply(self);

    const m = /^\/workspaces\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return reply({ error: "not found" }, 404);
    if (m[1] !== workspace) return reply({ error: "Workspace not found" }, 404);
    const rest = m[2];

    if (rest === "/members/") return reply([...users.values()]);
    if (rest === "/projects/") return paged([...projects.values()].filter((p) => p.access && !p.deleted).sort((a, b) => a.id.localeCompare(b.id)), projectShown);

    const byKey = /^\/work-items\/([A-Za-z0-9]+)-(\d+)\/$/.exec(rest);
    if (byKey) {
      const p = projectByIdentifier(byKey[1]);
      const i = p?.access ? issues.find((x) => x.project === p.id && x.seq === Number(byKey[2])) : undefined;
      // No access and no such thing look the same by key.
      return i && !i.deleted ? reply(shown(i, expand)) : reply({ error: "The requested resource does not exist." }, 404);
    }
    if (rest === "/work-items/search/") {
      const text = (url.searchParams.get("search") ?? "").toLowerCase();
      const hits = issues
        .filter((i) => listed(i) && projectOf(i).access)
        .filter((i) => !text || i.name.toLowerCase().includes(text) || (i.description ?? "").toLowerCase().includes(text))
        .sort((a, b) => b.updated - a.updated);
      return reply({ issues: hits.map((i) => ({ id: i.id, name: i.name, sequence_id: i.seq, project__identifier: projectOf(i).identifier, project_id: i.project, workspace__slug: workspace })) });
    }

    const pm = /^\/projects\/([^/]+)\/(.*)$/.exec(rest) ?? /^\/projects\/([^/]+)()$/.exec(rest);
    if (!pm) return reply({ error: `unmocked ${method} ${rest}` }, 404);
    const p = projects.get(pm[1]);
    if (!p || p.deleted) return reply({ error: "The requested resource does not exist." }, 404);
    if (!p.access) return reply({ error: "You do not have permission to access this resource." }, 403);
    const sub = pm[2];
    if (sub === "" ) return reply(projectShown(p));
    if (sub === "states/") return paged(p.states);

    if (sub === "work-items/") {
      const order = url.searchParams.get("order_by") ?? "-created_at";
      const desc = order.startsWith("-");
      const field = order.replace(/^-/, "") === "updated_at" ? "updated" : "created";
      const list = issues.filter((i) => i.project === p.id && listed(i)).sort((a, b) => (desc ? -1 : 1) * (a[field] - b[field] || a.seq - b.seq));
      return paged(list, (i) => shown(i, expand));
    }
    const im = /^work-items\/([^/]+)\/(.*)$/.exec(sub);
    if (!im) return reply({ error: `unmocked ${method} ${rest}` }, 404);
    const i = issues.find((x) => x.project === p.id && x.id === im[1]);
    if (!i || i.deleted) return reply({ error: "The requested resource does not exist." }, 404);
    const what = im[2];

    if (what === "") {
      if (method === "PATCH") {
        if (typeof body.state === "string") {
          if (!p.states.some((s) => s.id === body.state)) return reply({ error: "State is not in this project." }, 400);
          setState(i, body.state);
        }
        if (typeof body.name === "string") i.name = body.name;
        i.updated = now();
        // A change answers with uuids, whatever was asked.
        return reply(shown(i, new Set()));
      }
      return reply(shown(i, expand));
    }
    if (what === "comments/") {
      if (method === "POST") {
        const html = typeof body.comment_html === "string" ? body.comment_html : "";
        if (!html.trim()) return reply({ comment_html: ["This field is required."] }, 400);
        const at = now();
        const c: SimComment = { id: uuid(), html, actor: self.id, created: at, updated: at };
        i.comments.push(c);
        i.updated = now();
        return reply(commentShown(c), 201);
      }
      return paged([...i.comments].sort((a, b) => a.created - b.created), commentShown);
    }
    if (what === "activities/") return paged([...i.activities].sort((a, b) => b.created - a.created), activityShown);
    if (what === "worklogs/") {
      if (method === "POST") {
        const minutes = body.duration;
        if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) return reply({ duration: ["Ensure this value is greater than or equal to 1."] }, 400);
        const day = typeof body.logged_at === "string" ? body.logged_at : null;
        if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply({ logged_at: ["Date has wrong format. Use one of these formats instead: YYYY-MM-DD."] }, 400);
        const w = worklog(i, { minutes, day: state.noLoggedAt ? null : day, description: typeof body.description === "string" ? body.description : "" });
        return reply(worklogShown(w), 201);
      }
      return paged([...i.worklogs].sort((a, b) => a.created - b.created), worklogShown);
    }
    return reply({ error: `unmocked ${method} ${rest}` }, 404);
  }

  return {
    apiBase,
    workspace,
    web,
    token,
    me: self,
    anna,
    users,
    projects,
    issues,
    state,
    project,
    add,
    worklog,
    outside,
    keyOf,
    /** Every call from now on is refused as over the limit (429, Retry-After 30). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    /** A webhook delivery as Plane sends it: the body, signed with the secret key. */
    delivery: (secret: string, event: "issue" | "issue_comment", action: "create" | "update" | "delete", id = uuid()) => {
      const body = JSON.stringify({ event, action, webhook_id: "w1", workspace_id: "ws1", data: { id: "x" }, activity: { actor: { id: self.id } } });
      return { headers: { "x-plane-delivery": id, "x-plane-event": event, "x-plane-signature": hmacHex(secret, body), "content-type": "application/json" }, body };
    },
    fetch: handle,
  };
}
