// A Todoist in memory, for tests: the unified API (v1) endpoints the adapter
// calls, written from Todoist's public documentation (not recorded from a
// real account: see SPIKES.md), with its shapes and traps:
// - the token is a Bearer header; a bad one is a 401 (the old API answered
//   403 "Forbidden": `state.badTokenStatus` models it);
// - ids are opaque strings; the numeric ids of the old API are refused (400)
//   and only /id_mappings turns them into the new ones;
// - lists are paged by cursor, 50 by default, 200 at most (more is a 400);
//   activities 100 at most;
// - GET /tasks/{id} answers active tasks only (a completed one is 404 there);
//   the Sync API's items/get also reads completed ones; deleted ones are
//   gone from both;
// - the Sync API gives every open task on a full sync (completed and deleted
//   ones are not in it) and, from a sync token, what changed since, with
//   checked: true for completed tasks and is_deleted: true for deleted ones;
//   a token it doesn't know is a full sync, silently;
// - completing a recurring task moves its due date on and leaves it open;
//   completing a task completes its sub-tasks; deleting one deletes them;
// - priority 4 is "p1" (urgent) in the app, 1 the default ("p4");
// - a due date is a day, a floating time (no zone: the user's own clock) or
//   a fixed instant ("…Z" with the zone beside it);
// - tasks keep their id when moved to another project or section;
// - a project the user left answers 403; a deleted project or task 404;
// - filters (search: …) take backslash-escaped special characters and refuse
//   a bare one with a 400;
// - budget: 450 calls per 15 minutes, then 429 with the wait in the body
//   (error_extra.retry_after), no rate-limit headers;
// - webhooks: X-Todoist-Hmac-SHA256 is the base64 HMAC-SHA256 of the raw
//   body under the app's client secret; X-Todoist-Delivery-ID repeats on a
//   retry.
import { createHmac } from "node:crypto";
import type { TodoistActivity, TodoistComment, TodoistDue, TodoistProject, TodoistSection, TodoistTask, TodoistUser } from "./client";

export type SimUser = TodoistUser & { full_name: string; email: string };
type SimProject = TodoistProject & { members: Set<string>; order: number };
type SimSection = TodoistSection;
type SimTask = Omit<TodoistTask, "is_deleted"> & { legacyId: string; deleted: boolean; rev: number; order: number };
type SimComment = TodoistComment & { taskId: string };
type SimActivity = TodoistActivity & { seq: number };

export const BUDGET = 450;
export const WINDOW_MS = 15 * 60_000;

/** Characters a filter reads as operators: bare ones in a search are refused. */
export const FILTER_SPECIALS = "&|!(),";

type DueInput = string | ({ date: string } & Partial<Omit<TodoistDue, "date">>);

export function todoistSimulator(
  apiBase = "https://api.todoist.com",
  me: SimUser = { id: "29176323", full_name: "Mario Rossi", email: "mario@acme.example", avatar_big: "https://dcff1xvirvpfp.cloudfront.net/mrossi_big.jpg", timezone: "Europe/Rome" },
) {
  const token = "sim-token-0123456789abcdef";
  const users = new Map<string, SimUser>([[me.id, me]]);
  const projects: SimProject[] = [];
  const sections: SimSection[] = [];
  const tasks: SimTask[] = [];
  const comments: SimComment[] = [];
  const activities: SimActivity[] = [];
  const state = { exhausted: false, revoked: false, budget: BUDGET, badTokenStatus: 401 as 401 | 403, retryAfterSeconds: 17 };
  const calls: { method: string; path: string; search: string; authorization: string | null; body: string }[] = [];
  const budgetWindow: number[] = [];
  let seq = 100;
  /** What the sync token counts: every change to a task */
  let version = 0;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  let seeding = true;
  const stamp = () => (seeding ? earlier() : now());
  const iso = (ms: number) => new Date(ms).toISOString();
  const nextId = () => `6HqPw4${String(++seq).padStart(8, "0")}`;

  const addUser = (full_name: string) => {
    const u: SimUser = { id: String(30_000_000 + ++seq), full_name, email: `${full_name.split(" ")[0].toLowerCase()}@acme.example` };
    users.set(u.id, u);
    return u;
  };

  const addProject = (name: string, o: { shared?: boolean; members?: SimUser[]; inbox?: boolean; archived?: boolean; sections?: string[] } = {}) => {
    const members = new Set([me.id, ...(o.members ?? []).map((m) => m.id)]);
    const p: SimProject = { id: nextId(), name, is_shared: o.shared ?? (o.members?.length ?? 0) > 0, is_archived: o.archived ?? false, is_deleted: false, inbox_project: o.inbox ?? false, members, order: projects.length, parent_id: null, workspace_id: null };
    projects.push(p);
    (o.sections ?? []).forEach((s) => addSection(p.name, s));
    return p;
  };
  const project = (k: string) => {
    const p = projects.find((x) => x.id === k || x.name === k);
    if (!p) throw new Error(`no project ${k}`);
    return p;
  };
  const addSection = (projectName: string, name: string) => {
    const p = project(projectName);
    const s: SimSection = { id: nextId(), project_id: p.id, name, section_order: sections.filter((x) => x.project_id === p.id).length + 1, is_archived: false, is_deleted: false };
    sections.push(s);
    return s;
  };
  const sectionIn = (p: SimProject, name: string) => {
    const s = sections.find((x) => x.project_id === p.id && x.name === name);
    if (!s) throw new Error(`no section ${name} in ${p.name}`);
    return s;
  };

  const dueOf = (d: DueInput | null | undefined): TodoistDue | null => {
    if (!d) return null;
    const o = typeof d === "string" ? { date: d } : d;
    return { string: o.date, timezone: null, is_recurring: false, lang: "en", ...o };
  };

  const bump = (t: SimTask, at: number) => {
    t.rev = ++version;
    t.updated_at = iso(at);
  };

  const record = (t: SimTask, event_type: string, by: SimUser, extra: TodoistActivity["extra_data"], at = stamp()) => {
    activities.push({ seq: ++seq, id: String(5_000_000 + seq), object_type: "item", object_id: t.id, event_type, event_date: iso(at), parent_project_id: t.project_id, initiator_id: by.id, extra_data: { content: t.content, ...extra } });
  };

  const add = (
    projectName: string,
    content: string,
    o: { section?: string; parent?: SimTask; assignee?: SimUser | null; labels?: string[]; priority?: number; due?: DueInput; description?: string; deadline?: string; id?: string } = {},
  ) => {
    const p = project(projectName);
    const at = stamp();
    const t: SimTask = {
      id: o.id ?? nextId(),
      legacyId: String(2_990_000_000 + seq),
      project_id: p.id,
      section_id: o.section ? sectionIn(p, o.section).id : (o.parent?.section_id ?? null),
      parent_id: o.parent?.id ?? null,
      content,
      description: o.description ?? "",
      labels: o.labels ?? [],
      priority: o.priority ?? 1,
      due: dueOf(o.due),
      deadline: o.deadline ? { date: o.deadline } : null,
      responsible_uid: o.assignee === undefined || o.assignee === null ? null : o.assignee.id,
      added_by_uid: me.id,
      checked: false,
      deleted: false,
      added_at: iso(at),
      updated_at: iso(at),
      completed_at: null,
      child_order: tasks.length + 1,
      rev: ++version,
      order: tasks.length,
    };
    tasks.push(t);
    record(t, "added", me, {}, at);
    return t;
  };
  /** A move as the activity log tells it: between sections, or between projects too. */
  const moved = (t: SimTask, from: { project: string; section: string | null }, by: SimUser = me) =>
    record(t, "moved", by, {
      section_id: t.section_id,
      last_section_id: from.section,
      ...(from.project !== t.project_id ? { source_project_id: from.project, destination_project_id: t.project_id } : {}),
    });
  const task = (k: string) => {
    const t = tasks.find((x) => x.id === k || x.content === k);
    if (!t) throw new Error(`no task ${k}`);
    return t;
  };
  const descendants = (t: SimTask): SimTask[] => tasks.filter((x) => x.parent_id === t.id).flatMap((x) => [x, ...descendants(x)]);

  const addDay = (d: string) => {
    const base = Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + 86_400_000;
    return iso(base).slice(0, 10) + d.slice(10);
  };

  const complete = (t: SimTask, by: SimUser) => {
    const at = now();
    // A recurring task goes on to its next day and stays open.
    if (t.due?.is_recurring) {
      t.due = { ...t.due, date: addDay(t.due.date) };
      bump(t, at);
      record(t, "completed", by, { due_date: t.due.date }, at);
      return;
    }
    for (const x of [t, ...descendants(t)]) {
      if (x.deleted || x.checked) continue;
      x.checked = true;
      x.completed_at = iso(at);
      bump(x, at);
    }
    record(t, "completed", by, {}, at);
  };

  /** Changes made "outside" (in Todoist's own app, by someone else). */
  const outside = {
    rename(k: string, content: string, by: SimUser = me) {
      const t = task(k);
      const last_content = t.content;
      t.content = content;
      bump(t, now());
      record(t, "updated", by, { content, last_content });
    },
    describe(k: string, description: string, by: SimUser = me) {
      const t = task(k);
      const last_description = t.description;
      t.description = description;
      bump(t, now());
      record(t, "updated", by, { description, last_description });
    },
    setDue(k: string, due: DueInput | null, by: SimUser = me) {
      const t = task(k);
      const last_due_date = t.due?.date ?? null;
      t.due = dueOf(due);
      bump(t, now());
      record(t, "updated", by, { due_date: t.due?.date ?? null, last_due_date });
    },
    assign(k: string, who: SimUser | null, by: SimUser = me) {
      const t = task(k);
      const last_responsible_uid = t.responsible_uid;
      t.responsible_uid = who?.id ?? null;
      bump(t, now());
      record(t, "updated", by, { responsible_uid: t.responsible_uid, last_responsible_uid });
    },
    setPriority(k: string, priority: number) {
      const t = task(k);
      t.priority = priority;
      bump(t, now());
    },
    addLabel(k: string, label: string) {
      const t = task(k);
      t.labels = [...t.labels, label];
      bump(t, now());
    },
    complete(k: string, by: SimUser = me) {
      complete(task(k), by);
    },
    reopen(k: string, by: SimUser = me) {
      const t = task(k);
      t.checked = false;
      t.completed_at = null;
      bump(t, now());
      record(t, "uncompleted", by, {});
    },
    /** Deleting is final: only the sync (is_deleted) remembers. */
    delete(k: string, by: SimUser = me) {
      const t = task(k);
      for (const x of [t, ...descendants(t)]) {
        x.deleted = true;
        bump(x, now());
      }
      record(t, "deleted", by, {});
    },
    /** Same id, new project (and section): the id survives a move. */
    move(k: string, projectName: string, sectionName?: string) {
      const t = task(k);
      const p = project(projectName);
      const from = { project: t.project_id, section: t.section_id };
      for (const x of [t, ...descendants(t)]) {
        x.project_id = p.id;
        x.section_id = x === t && sectionName ? sectionIn(p, sectionName).id : null;
        bump(x, now());
      }
      moved(t, from);
    },
    setSection(k: string, sectionName: string | null) {
      const t = task(k);
      const from = { project: t.project_id, section: t.section_id };
      t.section_id = sectionName ? sectionIn(project(t.project_id), sectionName).id : null;
      bump(t, now());
      moved(t, from);
    },
    comment(k: string, content: string, by: SimUser = me) {
      const t = task(k);
      const c: SimComment = { id: nextId(), taskId: t.id, item_id: t.id, content, posted_uid: by.id, posted_at: iso(now()) };
      comments.push(c);
      return c;
    },
    /** The user leaves a shared project: its tasks answer 403 and leave the sync. */
    leaveProject(projectName: string) {
      project(projectName).members.delete(me.id);
    },
    archiveProject(projectName: string) {
      project(projectName).is_archived = true;
    },
    deleteProject(projectName: string) {
      const p = project(projectName);
      p.is_deleted = true;
      for (const t of tasks.filter((x) => x.project_id === p.id)) {
        t.deleted = true;
        bump(t, now());
      }
    },
  };

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, error_code: 0, error_extra: extra, http_code: status }, status);
  const noContent = () => new Response(null, { status: 204 });
  const invalid = (what = "Invalid argument value") => fail(400, what);
  const notFound = () => fail(404, "Not found");
  const denied = () => fail(403, "Forbidden");

  // v1 ids are alphanumeric; the numeric ids of the old API are not accepted.
  const isNewId = (k: string) => /^[A-Za-z0-9]{8,24}$/.test(k) && !/^\d+$/.test(k);
  const visible = (p: SimProject | undefined) => !!p && !p.is_deleted && p.members.has(me.id);
  const projectOf = (t: SimTask) => projects.find((p) => p.id === t.project_id);
  /** Tasks of the user's projects, not deleted */
  const readable = (t: SimTask) => !t.deleted && visible(projectOf(t));

  const taskJson = (t: SimTask): TodoistTask => ({
    id: t.id,
    project_id: t.project_id,
    section_id: t.section_id,
    parent_id: t.parent_id,
    content: t.content,
    description: t.description,
    labels: t.labels,
    priority: t.priority,
    due: t.due,
    deadline: t.deadline ?? null,
    responsible_uid: t.responsible_uid,
    added_by_uid: t.added_by_uid ?? null,
    checked: t.checked,
    is_deleted: t.deleted,
    added_at: t.added_at ?? null,
    updated_at: t.updated_at ?? null,
    completed_at: t.completed_at ?? null,
    child_order: t.child_order,
  });
  const projectJson = (p: SimProject): TodoistProject => ({ id: p.id, name: p.name, parent_id: p.parent_id ?? null, is_shared: p.is_shared, is_archived: p.is_archived ?? false, is_deleted: p.is_deleted ?? false, inbox_project: p.inbox_project ?? false, workspace_id: p.workspace_id ?? null });

  /** A list by cursor: 50 by default, `max` at most; the cursor is opaque ("c<offset>"). */
  function paged<T>(rows: T[], q: URLSearchParams, max = 200): Response {
    const limit = q.get("limit") === null ? 50 : Number(q.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > max) return invalid();
    const cursor = q.get("cursor");
    let offset = 0;
    if (cursor !== null) {
      const m = /^c(\d+)$/.exec(cursor);
      if (!m) return invalid("Invalid cursor");
      offset = Number(m[1]);
    }
    const slice = rows.slice(offset, offset + limit);
    return json({ results: slice, next_cursor: offset + limit < rows.length ? `c${offset + limit}` : null });
  }

  /** `search: text` with backslash-escaped specials; null when the filter is one this simulator doesn't read or is malformed. */
  function searchOf(query: string): string | null | undefined {
    const m = /^\s*search:\s*(.*)$/is.exec(query);
    if (!m) return undefined;
    let out = "";
    for (let i = 0; i < m[1].length; i++) {
      const ch = m[1][i];
      if (ch === "\\") {
        i++;
        if (i >= m[1].length) return null;
        out += m[1][i];
      } else if (FILTER_SPECIALS.includes(ch)) return null;
      else out += ch;
    }
    return out.trim();
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const base = new URL(apiBase);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, path: url.pathname, search: url.search, authorization: headers.get("authorization"), body: rawBody });
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/v1/")) return notFound();
    const path = url.pathname.slice("/api/v1".length);
    const q = url.searchParams;
    const body: Record<string, unknown> = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

    if (headers.get("authorization") !== `Bearer ${token}` || state.revoked) return state.badTokenStatus === 401 ? fail(401, "Unauthorized") : new Response("Forbidden", { status: 403 });

    // Budget: calls in the last window.
    const t0 = Date.now();
    while (budgetWindow.length && budgetWindow[0] <= t0 - WINDOW_MS) budgetWindow.shift();
    budgetWindow.push(t0);
    if (state.exhausted || budgetWindow.length > state.budget) return fail(429, "Too many requests", { retry_after: state.retryAfterSeconds, event_id: "ev-1" });

    if (method === "GET" && path === "/user") return json(me);

    if (method === "GET" && path === "/projects") {
      return paged(projects.filter((p) => visible(p) && !p.is_archived).map(projectJson), q);
    }
    let m = /^\/projects\/([^/]+)(\/collaborators)?$/.exec(path);
    if (method === "GET" && m) {
      if (!isNewId(m[1])) return invalid();
      const p = projects.find((x) => x.id === m![1]);
      if (!p || p.is_deleted) return notFound();
      if (!p.members.has(me.id)) return denied();
      if (!m[2]) return json(projectJson(p));
      return paged([...p.members].map((id) => users.get(id)!).map((u) => ({ id: u.id, name: u.full_name, email: u.email })), q);
    }

    if (method === "GET" && path === "/sections") {
      const only = q.get("project_id");
      return paged(
        sections.filter((s) => !s.is_archived && !s.is_deleted && visible(projects.find((p) => p.id === s.project_id)) && (only === null || s.project_id === only)).sort((a, b) => a.section_order - b.section_order),
        q,
      );
    }
    m = /^\/sections\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      if (!isNewId(m[1])) return invalid();
      const s = sections.find((x) => x.id === m![1]);
      if (!s || s.is_deleted) return notFound();
      return visible(projects.find((p) => p.id === s.project_id)) ? json(s) : denied();
    }

    if (method === "GET" && path === "/tasks") {
      const rows = tasks
        .filter((t) => readable(t) && !t.checked)
        .filter((t) => (q.get("project_id") === null || t.project_id === q.get("project_id")) && (q.get("section_id") === null || t.section_id === q.get("section_id")) && (q.get("parent_id") === null || t.parent_id === q.get("parent_id")))
        .sort((a, b) => a.order - b.order);
      return paged(rows.map(taskJson), q);
    }
    if (method === "GET" && path === "/tasks/filter") {
      const text = searchOf(q.get("query") ?? "");
      if (text === undefined) return invalid("Only search filters are simulated");
      if (text === null || text === "") return invalid("Invalid filter");
      const needle = text.toLowerCase();
      const rows = tasks.filter((t) => readable(t) && !t.checked && `${t.content}\n${t.description}`.toLowerCase().includes(needle)).sort((a, b) => b.rev - a.rev);
      return paged(rows.map(taskJson), q);
    }

    m = /^\/tasks\/([^/]+)(?:\/(close|reopen|move))?$/.exec(path);
    if (m) {
      if (!isNewId(m[1])) return invalid();
      const t = tasks.find((x) => x.id === m![1]);
      if (!t || t.deleted || projectOf(t)?.is_deleted) return notFound();
      if (!visible(projectOf(t))) return denied();
      const act = m[2];
      if (!act && method === "GET") return t.checked ? notFound() : json(taskJson(t));
      if (act === "close" && method === "POST") {
        if (t.checked) return noContent();
        complete(t, me);
        return noContent();
      }
      if (act === "reopen" && method === "POST") {
        if (t.checked) outside.reopen(t.id);
        return noContent();
      }
      if (act === "move" && method === "POST") {
        const from = { project: t.project_id, section: t.section_id };
        if (typeof body.section_id === "string") {
          const s = sections.find((x) => x.id === body.section_id);
          if (!s || s.is_deleted) return notFound();
          if (s.project_id !== t.project_id) {
            const p = projects.find((x) => x.id === s.project_id);
            if (!visible(p)) return denied();
            t.project_id = s.project_id;
          }
          t.section_id = s.id;
        } else if (typeof body.project_id === "string") {
          const p = projects.find((x) => x.id === body.project_id);
          if (!p || p.is_deleted) return notFound();
          if (!visible(p)) return denied();
          t.project_id = p.id;
          t.section_id = null;
        } else return invalid();
        bump(t, now());
        moved(t, from);
        return noContent();
      }
      return invalid("Method not allowed");
    }

    if (method === "GET" && path === "/sync/items/get") {
      const k = q.get("item_id") ?? "";
      if (!isNewId(k)) return invalid();
      const t = tasks.find((x) => x.id === k);
      if (!t || t.deleted) return notFound();
      return visible(projectOf(t)) ? json({ item: taskJson(t) }) : denied();
    }

    if (method === "POST" && path === "/sync") {
      const given = typeof body.sync_token === "string" ? body.sync_token : "*";
      const since = /^st:(\d+)$/.exec(given);
      // A token it doesn't know is a full sync, without a word.
      const full = !since;
      // The user's projects only (a deleted project's tasks come as deleted).
      const rows = tasks.filter((t) => projectOf(t)?.members.has(me.id) === true).filter((t) => (full ? !t.checked && !t.deleted : t.rev > Number(since[1])));
      return json({ sync_token: `st:${version}`, full_sync: full, items: rows.sort((a, b) => a.rev - b.rev).map(taskJson) });
    }

    if (path === "/comments") {
      if (method === "GET") {
        const id = q.get("task_id") ?? "";
        if (!isNewId(id)) return invalid();
        const t = tasks.find((x) => x.id === id);
        if (!t || t.deleted) return notFound();
        if (!visible(projectOf(t))) return denied();
        return paged(comments.filter((c) => c.taskId === id), q);
      }
      if (method === "POST") {
        const id = typeof body.task_id === "string" ? body.task_id : "";
        if (!isNewId(id)) return invalid();
        const t = tasks.find((x) => x.id === id);
        if (!t || t.deleted) return notFound();
        if (!visible(projectOf(t))) return denied();
        if (typeof body.content !== "string" || body.content === "") return invalid("Invalid content");
        const c = outside.comment(id, body.content);
        return json({ id: c.id, item_id: c.item_id, content: c.content, posted_uid: c.posted_uid, posted_at: c.posted_at });
      }
    }

    if (method === "GET" && path === "/activities") {
      const id = q.get("object_id") ?? "";
      if (q.get("object_type") !== "item" || !isNewId(id)) return invalid();
      const rows = activities.filter((a) => a.object_id === id).sort((a, b) => Date.parse(b.event_date) - Date.parse(a.event_date) || b.seq - a.seq);
      // Activities page by 100.
      const page = paged(rows.map((a) => ({ id: a.id, object_type: a.object_type, object_id: a.object_id, event_type: a.event_type, event_date: a.event_date, parent_project_id: a.parent_project_id, initiator_id: a.initiator_id, extra_data: a.extra_data })), q, 100);
      return page;
    }

    m = /^\/id_mappings\/tasks\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      return json(m[1].split(",").map((old) => ({ old_id: old, new_id: tasks.find((t) => t.legacyId === old)?.id ?? null })));
    }

    return notFound();
  }

  /** A webhook delivery as Todoist sends it: the raw body, signed (base64 HMAC-SHA256) under the app's client secret. */
  function webhook(event_name: string, event_data: Record<string, unknown>, o: { secret: string; signedWith?: string; deliveryId?: string; triggeredAt?: string }) {
    const rawBody = JSON.stringify({ event_name, user_id: me.id, event_data, version: "10", initiator: { id: me.id, full_name: me.full_name }, triggered_at: o.triggeredAt ?? iso(now()), event_id: ++seq });
    const signature = createHmac("sha256", o.signedWith ?? o.secret).update(rawBody, "utf8").digest("base64");
    return { rawBody, headers: { "x-todoist-hmac-sha256": signature, "x-todoist-delivery-id": o.deliveryId ?? `d-${seq}`, "content-type": "application/json" } };
  }

  return {
    apiBase,
    token,
    me,
    users,
    projects,
    sections,
    tasks,
    comments,
    activities,
    state,
    calls,
    addUser,
    addProject,
    addSection,
    add,
    project,
    task,
    outside,
    webhook,
    /** End of setup: from now on, changes are stamped with the real clock. */
    live: () => void (seeding = false),
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401, or 403 with state.badTokenStatus). */
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
