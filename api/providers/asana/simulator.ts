// An Asana in memory, for tests: the REST 1.0 endpoints the adapter calls,
// written from Asana's documentation (not recorded from a real server), with
// its shapes and traps:
// - Bearer token or 401; 429 with Retry-After; errors as { errors: [{ message, help }] };
// - everything under { data } and lists with next_page.offset; limit 1-100; an offset is good for its
//   own query only and expires (400 "offset: …");
// - a record is compact (gid, resource_type, name) unless opt_fields asks for the rest, and nested
//   fields are asked as a.b;
// - gids are strings, past 2^53; a task has no key of its own: only the gid;
// - GET /tasks wants assignee together with workspace; completed_since keeps incomplete tasks and
//   those completed since; modified_since is inclusive;
// - a subtask has no memberships (it sits in its parent's projects); a task in several projects has
//   several memberships, each with its own section (or none);
// - a due date is due_on (a plain date) or due_at (a UTC instant), never both;
// - a deleted task is a 404; what the user cannot see is a 403;
// - sections: addTask on a section of a project the task is not in adds it to that project;
// - comments are stories mixed with system stories; html_text must be a <body> with a short list of
//   tags (no <p>, no headings), and the story keeps it as such;
// - search is a paid-plan endpoint (402 on a free one), without paging, with typeahead as the
//   free way, which finds other people's tasks too;
// - time tracking entries: whole minutes, a plain date, billable_status, a category (attributable_to),
//   an approval that locks them (403), other people's entries visible but not editable.
import { createHmac } from "node:crypto";

type Rec = Record<string, unknown>;
type SimUser = { gid: string; name: string; email: string; photo: string | null };
export type SimProject = { gid: string; name: string; workspace: string; access: boolean; sections: SimSection[] };
type SimSection = { gid: string; name: string };
type SimStory = { gid: string; type: "comment" | "system"; subtype: string; created: number; by: string; html: string | null; text: string; extra?: Rec };
export type SimTask = {
  gid: string;
  workspace: string;
  name: string;
  notes: string;
  completed: boolean;
  completedAt: number | null;
  created: number;
  modified: number;
  dueOn: string | null;
  dueAt: string | null;
  startOn: string | null;
  assignee: string | null;
  createdBy: string;
  memberships: { project: string; section: string | null }[];
  tags: string[];
  parent: string | null;
  subtype: string;
  deleted: boolean;
  followers: Set<string>;
  stories: SimStory[];
};
export type SimEntry = {
  gid: string;
  task: string;
  user: string;
  minutes: number;
  enteredOn: string;
  description: string;
  category: string | null;
  billable: "billable" | "nonBillable" | "notApplicable";
  approval: "draft" | "submitted" | "approved" | "rejected";
  created: number;
};

const ALLOWED_TAGS = new Set(["body", "strong", "em", "u", "s", "code", "pre", "ol", "ul", "li", "a", "blockquote"]);
const HELP = "For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors";

export function asanaSimulator(apiBase = "https://app.asana.com/api/1.0", opts: { premium?: boolean } = {}) {
  const token = "2/1200000000000001/simulated:pat";
  const web = apiBase.replace(/\/api\/1\.0$/, "");
  const me: SimUser = { gid: "1200000000000000001", name: "Mario Rossi", email: "mario@acme.example", photo: "https://s3.amazonaws.com/asana/photo-1.png" };
  const users = new Map<string, SimUser>([[me.gid, me]]);
  users.set("1200000000000000078", { gid: "1200000000000000078", name: "Anna Bianchi", email: "anna@acme.example", photo: null });
  const anna = "1200000000000000078";
  const workspaces = new Map<string, string>([["1200000000000000100", "Acme"]]);
  const mainWorkspace = "1200000000000000100";
  const projects = new Map<string, SimProject>();
  const tasks: SimTask[] = [];
  const entries: SimEntry[] = [];
  const categories = new Map<string, { gid: string; name: string; workspace: string }>();
  let seq = 0;
  const gid = () => `1209${String(++seq).padStart(15, "0")}`;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  const iso = (ms: number) => new Date(ms).toISOString();
  const state = { exhausted: false, calls: 0, revoked: false, premium: opts.premium ?? true, epoch: 0 };

  // ---------- Data ----------

  const project = (name: string, o: { sections?: string[]; access?: boolean; workspace?: string } = {}): SimProject => {
    const known = [...projects.values()].find((p) => p.name === name);
    if (known) {
      if (o.access !== undefined) known.access = o.access;
      return known;
    }
    const p: SimProject = { gid: gid(), name, workspace: o.workspace ?? mainWorkspace, access: o.access ?? true, sections: (o.sections ?? []).map((s) => ({ gid: gid(), name: s })) };
    projects.set(p.gid, p);
    return p;
  };
  const sectionOf = (p: SimProject, name: string) => p.sections.find((s) => s.name === name);

  const addWorkspace = (name: string) => {
    const g = gid();
    workspaces.set(g, name);
    return g;
  };
  const addUser = (name: string) => {
    const g = gid();
    users.set(g, { gid: g, name, email: `${name.split(" ")[0].toLowerCase()}@acme.example`, photo: null });
    return g;
  };
  const category = (name: string, workspace = mainWorkspace) => {
    const c = { gid: gid(), name, workspace };
    categories.set(c.gid, c);
    return c;
  };

  const add = (
    name: string,
    o: { project?: SimProject; section?: string; assignee?: string | null; notes?: string; dueOn?: string; dueAt?: string; startOn?: string; tags?: string[]; parent?: SimTask; subtype?: string; author?: string; workspace?: string } = {},
  ): SimTask => {
    const at = earlier();
    const t: SimTask = {
      gid: gid(),
      workspace: o.workspace ?? o.project?.workspace ?? o.parent?.workspace ?? mainWorkspace,
      name,
      notes: o.notes ?? "",
      completed: false,
      completedAt: null,
      created: at,
      modified: at,
      dueOn: o.dueOn ?? null,
      dueAt: o.dueAt ?? null,
      startOn: o.startOn ?? null,
      assignee: o.assignee === null ? null : (o.assignee ?? me.gid),
      createdBy: o.author ?? me.gid,
      memberships: o.project && !o.parent ? [{ project: o.project.gid, section: (o.section && sectionOf(o.project, o.section)?.gid) || null }] : [],
      tags: o.tags ?? [],
      parent: o.parent?.gid ?? null,
      subtype: o.subtype ?? "default_task",
      deleted: false,
      followers: new Set(),
      stories: [],
    };
    tasks.push(t);
    return t;
  };
  const keyOf = (t: SimTask) => `ASANA-${t.gid}`;
  const taskById = (id: string) => tasks.find((t) => t.gid === id && !t.deleted);
  const visible = (t: SimTask): boolean => {
    if (t.assignee === me.gid) return true;
    if (t.parent) {
      const p = tasks.find((x) => x.gid === t.parent);
      return p ? visible(p) : false;
    }
    return t.memberships.length === 0 || t.memberships.some((m) => projects.get(m.project)?.access);
  };

  const story = (t: SimTask, subtype: string, text: string, by = me.gid, extra?: Rec) => {
    t.stories.push({ gid: gid(), type: "system", subtype, created: now(), by, html: null, text, extra });
    t.modified = now();
  };

  // ---------- Changes, whoever makes them ----------

  const setCompleted = (t: SimTask, on: boolean, by = me.gid) => {
    if (t.completed === on) return;
    t.completed = on;
    t.completedAt = on ? now() : null;
    story(t, on ? "marked_complete" : "marked_incomplete", on ? "marked this task complete" : "marked this task incomplete", by);
  };
  const moveToSection = (t: SimTask, p: SimProject, section: SimSection, by = me.gid) => {
    const m = t.memberships.find((x) => x.project === p.gid);
    const from = m?.section ? p.sections.find((s) => s.gid === m.section) : undefined;
    if (m) m.section = section.gid;
    else t.memberships.push({ project: p.gid, section: section.gid });
    story(t, "section_changed", `moved this task from ${from?.name ?? "Untitled section"} to ${section.name}`, by, { old_section: from ? { gid: from.gid, resource_type: "section", name: from.name } : null, new_section: { gid: section.gid, resource_type: "section", name: section.name } });
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign(t: SimTask, user: string | null) {
      t.assignee = user;
      story(t, user ? "assigned" : "unassigned", user ? `assigned to ${users.get(user)?.name}` : "unassigned the task", anna, user ? { assignee: ref("user", user, users.get(user)?.name) } : undefined);
    },
    complete: (t: SimTask) => setCompleted(t, true, anna),
    reopen: (t: SimTask) => setCompleted(t, false, anna),
    retitle(t: SimTask, name: string) {
      const old = t.name;
      t.name = name;
      story(t, "name_changed", `changed the name to ${name}`, anna, { old_name: old, new_name: name });
    },
    comment(t: SimTask, text: string, by = anna) {
      t.stories.push({ gid: gid(), type: "comment", subtype: "comment_added", created: now(), by, html: `<body>${text}</body>`, text });
      t.modified = now();
    },
    moveToSection(t: SimTask, p: SimProject, section: string) {
      const s = sectionOf(p, section);
      if (!s) throw new Error(`no section ${section}`);
      moveToSection(t, p, s, anna);
    },
    /** The task joins (or leaves) a project: its container changes, its gid does not. */
    moveToProject(t: SimTask, p: SimProject) {
      t.memberships = [{ project: p.gid, section: null }];
      t.modified = now();
    },
    due(t: SimTask, dueOn: string | null) {
      const old = t.dueOn;
      t.dueOn = dueOn;
      t.dueAt = null;
      story(t, "due_date_changed", dueOn ? `changed the due date to ${dueOn}` : "removed the due date", anna, { old_dates: old ? { due_on: old } : null, new_dates: dueOn ? { due_on: dueOn } : null });
    },
    /** In the trash: a 404 from now on. */
    delete(t: SimTask) {
      t.deleted = true;
      t.modified = now();
    },
    renameProject(p: SimProject, name: string) {
      p.name = name;
      for (const t of tasks.filter((x) => x.memberships.some((m) => m.project === p.gid))) t.modified = now();
    },
    renameSection(p: SimProject, from: string, to: string) {
      const s = sectionOf(p, from);
      if (s) s.name = to;
      for (const t of tasks.filter((x) => x.memberships.some((m) => m.section === s?.gid))) t.modified = now();
    },
    /** The user loses (or regains) access to a project: 403 for it and everything only in it. */
    access(p: SimProject, on: boolean) {
      p.access = on;
    },
    approve(e: SimEntry) {
      e.approval = "approved";
    },
    submit(e: SimEntry) {
      e.approval = "submitted";
    },
  };

  const entry = (t: SimTask, o: { minutes: number; enteredOn: string; user?: string; description?: string; category?: string; billable?: SimEntry["billable"] }) => {
    const e: SimEntry = { gid: gid(), task: t.gid, user: o.user ?? me.gid, minutes: o.minutes, enteredOn: o.enteredOn, description: o.description ?? "", category: o.category ?? null, billable: o.billable ?? "notApplicable", approval: "draft", created: now() };
    entries.push(e);
    t.modified = now();
    return e;
  };

  // ---------- Shapes ----------

  const ref = (type: string, g: string, name?: string | null): Rec => ({ gid: g, resource_type: type, ...(name === undefined ? {} : { name }) });
  const userRec = (id: string | null): Rec | null => {
    if (!id) return null;
    const u = users.get(id) ?? { gid: id, name: `User ${id}`, email: "", photo: null };
    return { gid: u.gid, resource_type: "user", name: u.name, email: u.email, photo: u.photo ? { image_128x128: u.photo } : null, workspaces: [...workspaces].map(([g, n]) => ref("workspace", g, n)) };
  };
  const homeOf = (t: SimTask) => (t.parent ? [] : t.memberships);
  const taskRec = (t: SimTask): Rec => ({
    gid: t.gid,
    resource_type: "task",
    name: t.name,
    notes: t.notes,
    html_notes: `<body>${t.notes}</body>`,
    completed: t.completed,
    completed_at: t.completedAt === null ? null : iso(t.completedAt),
    created_at: iso(t.created),
    modified_at: iso(t.modified),
    due_on: t.dueOn,
    due_at: t.dueAt,
    start_on: t.startOn,
    resource_subtype: t.subtype,
    permalink_url: `${web}/0/${t.memberships[0]?.project ?? "0"}/${t.gid}`,
    actual_time_minutes: entries.filter((e) => e.task === t.gid).reduce((a, e) => a + e.minutes, 0),
    assignee: userRec(t.assignee),
    created_by: userRec(t.createdBy),
    memberships: homeOf(t).map((m) => {
      const p = projects.get(m.project)!;
      const s = m.section ? p.sections.find((x) => x.gid === m.section) : undefined;
      return { project: ref("project", p.gid, p.name), section: s ? ref("section", s.gid, s.name) : null };
    }),
    parent: t.parent ? ref("task", t.parent, tasks.find((x) => x.gid === t.parent)?.name) : null,
    tags: t.tags.map((n) => ref("tag", `tag-${n}`, n)),
    workspace: ref("workspace", t.workspace, workspaces.get(t.workspace)),
  });
  const storyRec = (s: SimStory): Rec => ({
    gid: s.gid,
    resource_type: "story",
    type: s.type,
    resource_subtype: s.subtype,
    created_at: iso(s.created),
    created_by: userRec(s.by),
    html_text: s.html,
    text: s.text,
    ...s.extra,
  });
  const entryRec = (e: SimEntry): Rec => ({
    gid: e.gid,
    resource_type: "time_tracking_entry",
    duration_minutes: e.minutes,
    entered_on: e.enteredOn,
    description: e.description,
    created_at: iso(e.created),
    created_by: userRec(e.user),
    task: ref("task", e.task, tasks.find((t) => t.gid === e.task)?.name),
    attributable_to: e.category ? ref("time_tracking_category", e.category, categories.get(e.category)?.name) : null,
    billable_status: e.billable,
    approval_status: e.approval,
  });

  const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
  /** Compact: what Asana gives of any record not asked in full. */
  const compact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(compact);
    if (!isRec(v) || typeof v.gid !== "string") return v;
    return Object.fromEntries(["gid", "resource_type", "name"].flatMap((k) => (k in v ? [[k, v[k]]] : [])));
  };
  /** opt_fields: the record's compact form plus the paths asked (a.b.c). */
  function pick(value: unknown, paths: string[][]): unknown {
    if (Array.isArray(value)) return value.map((v) => pick(v, paths));
    if (!isRec(value)) return value;
    const base = compact(value);
    const out: Rec = isRec(base) && typeof value.gid === "string" ? { ...base } : {};
    for (const head of new Set(paths.map((p) => p[0]))) {
      if (!(head in value)) continue;
      const tails = paths.filter((p) => p[0] === head && p.length > 1).map((p) => p.slice(1));
      // Asked as is: a record is given compact, a plain value whole.
      out[head] = tails.length ? pick(value[head], tails) : compact(value[head]);
    }
    return out;
  }
  const shaped = (rec: Rec, fields: string | null) => pick(rec, (fields ?? "").split(",").filter(Boolean).map((f) => f.split(".")));

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, message: string, headers: Record<string, string> = {}) => json({ errors: [{ message, help: HELP }] }, status, headers);
  const unknown = (what: string, id: string) => fail(404, `${what}: Unknown object: ${id}`);

  /** A valid XML body of the tags Asana takes. */
  function badHtml(html: string): string | null {
    if (!/^<body>[\s\S]*<\/body>$/.test(html)) return "html_text: Must be wrapped in <body> tags";
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
      const name = m[2];
      if (!ALLOWED_TAGS.has(name)) return `html_text: XML tag "${name}" is not allowed`;
      if (m[1]) {
        if (stack.pop() !== name) return "html_text: Invalid XML: mismatched tag";
      } else stack.push(name);
    }
    return stack.length ? "html_text: Invalid XML: unclosed tag" : null;
  }
  const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as { data?: Rec }) : {};
    const body: Rec = parsed.data ?? {};
    const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
    state.calls++;

    if (headers.get("authorization") !== `Bearer ${token}` || state.revoked) return fail(401, "Not Authorized");
    if (state.exhausted) return fail(429, "You have exceeded the rate limit for this plan", { "Retry-After": "30" });
    const path = url.pathname.slice(apiPath.length);
    const q = url.searchParams;
    const fields = q.get("opt_fields");
    const one = (rec: Rec, status = 200) => json({ data: shaped(rec, fields) }, status);

    /** limit 1-100; an offset is valid for the same query and the same epoch. */
    const paged = <T>(list: T[], serialize: (t: T) => Rec): Response => {
      const limitText = q.get("limit");
      const limit = limitText === null ? 100 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, "limit: Must be between 1 and 100");
      const sig = [path, ...[...q.entries()].filter(([k]) => k !== "offset" && k !== "limit").map(([k, v]) => `${k}=${v}`).sort()].join("&");
      let from = 0;
      const offset = q.get("offset");
      if (offset) {
        try {
          const o = JSON.parse(Buffer.from(offset, "base64url").toString()) as { from: number; sig: string; epoch: number };
          if (o.epoch !== state.epoch) return fail(400, "offset: Invalid offset token (expired)");
          if (o.sig !== sig) return fail(400, "offset: Invalid offset token for this request");
          from = o.from;
        } catch {
          return fail(400, "offset: Invalid offset token");
        }
      }
      const end = Math.min(list.length, from + limit);
      const next = end < list.length ? Buffer.from(JSON.stringify({ from: end, sig, epoch: state.epoch })).toString("base64url") : null;
      return json({
        data: list.slice(from, end).map((t) => shaped(serialize(t), fields)),
        next_page: next ? { offset: next, path: `${path}?offset=${next}`, uri: `${apiBase}${path}?offset=${next}` } : null,
      });
    };

    if (path === "/users/me") return one(userRec(me.gid)!);

    if (path === "/tasks" && method === "GET") {
      const assignee = q.get("assignee");
      const workspace = q.get("workspace");
      if (!assignee || !workspace) return fail(400, "Must specify exactly one of project, tag, section, user task list, or assignee + workspace");
      if (!workspaces.has(workspace)) return fail(403, "workspace: Not authorized");
      const who = assignee === "me" ? me.gid : assignee;
      const modifiedSince = q.get("modified_since");
      const completedSince = q.get("completed_since");
      if (modifiedSince && Number.isNaN(Date.parse(modifiedSince))) return fail(400, "modified_since: Invalid date");
      const list = tasks
        .filter((t) => !t.deleted && t.workspace === workspace && t.assignee === who && visible(t))
        .filter((t) => !modifiedSince || t.modified >= Date.parse(modifiedSince))
        .filter((t) => !completedSince || !t.completed || (t.completedAt ?? 0) >= Date.parse(completedSince))
        .sort((a, b) => a.gid.localeCompare(b.gid));
      return paged(list, taskRec);
    }

    let m = /^\/tasks\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (m) {
      const t = taskById(m[1]);
      if (!t) return unknown("task", m[1]);
      if (!visible(t)) return fail(403, "task: You do not have access to this task");
      const sub = m[2];
      if (!sub) {
        if (method === "PUT") {
          if (typeof body.completed === "boolean") setCompleted(t, body.completed);
          if (typeof body.name === "string") t.name = body.name;
          if (typeof body.notes === "string") t.notes = body.notes;
          t.modified = now();
        }
        return one(taskRec(t));
      }
      if (sub === "stories") {
        if (method === "POST") {
          const html = typeof body.html_text === "string" ? body.html_text : null;
          const text = typeof body.text === "string" ? body.text : null;
          if (html === null && !text) return fail(400, "text: Missing input");
          if (html !== null) {
            const bad = badHtml(html);
            if (bad) return fail(400, bad);
          }
          const s: SimStory = { gid: gid(), type: "comment", subtype: "comment_added", created: now(), by: me.gid, html: html ?? `<body>${text}</body>`, text: html === null ? (text ?? "") : plain(html) };
          t.stories.push(s);
          t.modified = now();
          return one(storyRec(s), 201);
        }
        return paged([...t.stories].sort((a, b) => a.created - b.created || a.gid.localeCompare(b.gid)), storyRec);
      }
      if (sub === "addFollowers" || sub === "removeFollowers") {
        const list = Array.isArray(body.followers) ? body.followers.map((f) => (f === "me" ? me.gid : String(f))) : [];
        for (const f of list) {
          if (sub === "addFollowers") t.followers.add(f);
          else t.followers.delete(f);
        }
        return one(taskRec(t));
      }
      if (sub === "time_tracking_entries") {
        if (method === "POST") {
          const minutes = body.duration_minutes;
          if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) return fail(400, "duration_minutes: Must be a positive whole number of minutes");
          if (typeof body.entered_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.entered_on) || Number.isNaN(Date.parse(body.entered_on))) return fail(400, "entered_on: Must be a date (YYYY-MM-DD)");
          const cat = typeof body.attributable_to === "string" ? body.attributable_to : null;
          if (cat && !categories.has(cat)) return fail(400, "attributable_to: Unknown time tracking category");
          const bill = body.billable_status;
          if (bill !== undefined && bill !== "billable" && bill !== "nonBillable" && bill !== "notApplicable") return fail(400, "billable_status: Invalid value");
          const e = entry(t, { minutes, enteredOn: body.entered_on, description: typeof body.description === "string" ? body.description : "", ...(cat ? { category: cat } : {}), ...(bill ? { billable: bill } : {}) });
          return one(entryRec(e), 201);
        }
        return paged(entries.filter((e) => e.task === t.gid).sort((a, b) => a.enteredOn.localeCompare(b.enteredOn) || a.gid.localeCompare(b.gid)), entryRec);
      }
      return fail(404, `unmocked ${method} ${path}`);
    }

    m = /^\/time_tracking_entries\/([^/]+)$/.exec(path);
    if (m) {
      const e = entries.find((x) => x.gid === m![1]);
      const t = e && taskById(e.task);
      if (!e || !t) return unknown("time_tracking_entry", m[1]);
      if (!visible(t)) return fail(403, "time_tracking_entry: You do not have access to this entry");
      if (method !== "GET") {
        if (e.user !== me.gid) return fail(403, "time_tracking_entry: You can only change your own entries");
        if (e.approval === "approved" || e.approval === "submitted") return fail(403, `time_tracking_entry: The entry is ${e.approval} and cannot be changed`);
      }
      if (method === "DELETE") {
        entries.splice(entries.indexOf(e), 1);
        t.modified = now();
        return json({ data: {} });
      }
      if (method === "PUT") {
        if (body.duration_minutes !== undefined) {
          if (typeof body.duration_minutes !== "number" || !Number.isInteger(body.duration_minutes) || body.duration_minutes < 1) return fail(400, "duration_minutes: Must be a positive whole number of minutes");
          e.minutes = body.duration_minutes;
        }
        if (typeof body.entered_on === "string") e.enteredOn = body.entered_on;
        if (typeof body.description === "string") e.description = body.description;
        if (body.attributable_to !== undefined) {
          const cat = typeof body.attributable_to === "string" ? body.attributable_to : null;
          if (cat && !categories.has(cat)) return fail(400, "attributable_to: Unknown time tracking category");
          e.category = cat;
        }
        if (body.billable_status === "billable" || body.billable_status === "nonBillable" || body.billable_status === "notApplicable") e.billable = body.billable_status;
        t.modified = now();
      }
      return one(entryRec(e));
    }

    m = /^\/projects\/([^/]+)\/sections$/.exec(path);
    if (m) {
      const p = projects.get(m[1]);
      if (!p) return unknown("project", m[1]);
      if (!p.access) return fail(403, "project: You do not have access to this project");
      return paged(p.sections, (s) => ref("section", s.gid, s.name));
    }

    if (path === "/projects") {
      const workspace = q.get("workspace");
      if (!workspace) return fail(400, "workspace: Missing input");
      return paged([...projects.values()].filter((p) => p.workspace === workspace && p.access), (p) => ref("project", p.gid, p.name));
    }

    m = /^\/sections\/([^/]+)\/addTask$/.exec(path);
    if (m && method === "POST") {
      const p = [...projects.values()].find((x) => x.sections.some((s) => s.gid === m![1]));
      const s = p?.sections.find((x) => x.gid === m![1]);
      if (!p || !s) return unknown("section", m[1]);
      if (!p.access) return fail(403, "section: You do not have access to this project");
      const t = typeof body.task === "string" ? taskById(body.task) : undefined;
      if (!t) return fail(404, `task: Unknown object: ${String(body.task)}`);
      if (!visible(t)) return fail(403, "task: You do not have access to this task");
      // Not in this project yet: it is added to it, in this section.
      moveToSection(t, p, s);
      return json({ data: {} });
    }

    m = /^\/workspaces\/([^/]+)\/(tasks\/search|typeahead)$/.exec(path);
    if (m) {
      if (!workspaces.has(m[1])) return fail(403, "workspace: Not authorized");
      const text = (q.get("text") ?? q.get("query") ?? "").toLowerCase();
      const inWs = tasks.filter((t) => !t.deleted && t.workspace === m[1] && visible(t) && (!text || t.name.toLowerCase().includes(text) || t.notes.toLowerCase().includes(text)));
      if (m[2] === "tasks/search") {
        if (!state.premium) return fail(402, "This endpoint requires a premium workspace", {});
        const limit = Number(q.get("limit") ?? 20);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, "limit: Must be between 1 and 100");
        const mine = inWs.filter((t) => (q.get("assignee.any") ? t.assignee === (q.get("assignee.any") === "me" ? me.gid : q.get("assignee.any")) : true));
        // No paging: the newest `limit`, and nothing says there is more.
        const list = mine.sort((a, b) => b.modified - a.modified || b.gid.localeCompare(a.gid)).slice(0, limit);
        return json({ data: list.map((t) => shaped(taskRec(t), fields)) });
      }
      if (q.get("resource_type") !== "task") return fail(400, "resource_type: Missing input");
      const count = Number(q.get("count") ?? 20);
      return json({ data: inWs.sort((a, b) => b.modified - a.modified).slice(0, Math.min(100, count)).map((t) => shaped(taskRec(t), fields)) });
    }

    if (path === "/time_tracking_categories") {
      const workspace = q.get("workspace");
      if (!workspace) return fail(400, "workspace: Missing input");
      return paged([...categories.values()].filter((c) => c.workspace === workspace), (c) => ref("time_tracking_category", c.gid, c.name));
    }

    return fail(404, `unmocked ${method} ${path}`);
  }

  // ---------- Webhooks ----------

  type SimEvent = { action: "changed" | "added" | "removed" | "deleted" | "undeleted"; resource: { gid: string; resource_type: string }; created_at?: string };
  /** A delivery as Asana sends it: the events, signed with the handshake secret (X-Hook-Signature), the raw body kept. */
  const webhook = (events: SimEvent[], o: { secret: string; signedWith?: string; ageMs?: number }) => {
    const at = iso(Date.now() - (o.ageMs ?? 0));
    const rawBody = JSON.stringify({ events: events.map((e) => ({ user: ref("user", me.gid), created_at: at, ...e, resource: { ...e.resource } })) });
    return { rawBody, headers: { "x-hook-signature": createHmac("sha256", o.signedWith ?? o.secret).update(rawBody, "utf8").digest("hex"), "content-type": "application/json" } };
  };
  /** The handshake: Asana sends X-Hook-Secret, the receiver echoes it. */
  const handshake = (secret: string) => ({ rawBody: JSON.stringify({}), headers: { "x-hook-secret": secret, "content-type": "application/json" } });

  return {
    apiBase,
    web,
    token,
    me,
    anna,
    users,
    workspaces,
    mainWorkspace,
    projects,
    tasks,
    entries,
    categories,
    state,
    project,
    addWorkspace,
    addUser,
    category,
    add,
    entry,
    outside,
    keyOf,
    webhook,
    handshake,
    /** Every call from now on is refused as over the limit (429, Retry-After 30). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    /** Every offset handed out so far stops working (400). */
    expireOffsets: () => state.epoch++,
    fetch: handle,
  };
}
