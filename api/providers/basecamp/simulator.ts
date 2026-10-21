// A Basecamp in memory, for tests: the endpoints the adapter calls (Basecamp 3
// and 4's API), written from Basecamp's documentation (not recorded from a
// real server), with its shapes and traps:
// - an account's API is under /<account id>; the accounts of a token are listed by the launchpad
//   (another host, product bc3 for Basecamp 3 and 4); a User-Agent with a contact is required (400
//   without); Bearer token or 401; 429 with Retry-After (50 requests per 10 seconds);
// - lists are pages of 15 with a Link rel="next" header and X-Total-Count;
// - timestamps carry the account's own UTC offset (+02:00), not Z; dates (due_on, entry date) are plain;
// - every to-do or card is a "recording" in a project (the bucket), reached by bucket and id; a to-do
//   and a card have paths of their own, and the wrong one is a 404;
// - a trashed or archived recording is still answered (200) with its status; what the user cannot
//   reach is a 403; moving a recording to another project makes a new recording with a new id;
// - the recordings list holds everybody's to-dos (assignees say whose), newest change first;
//   /my/assignments lists only the open ones assigned to the user, with no change time;
// - a card table has Triage, Not now and Done columns of its own beside the ones people add;
//   completing and reopening a to-do answer 204, moving a card answers 204;
// - comments are rich text: Basecamp keeps a short list of tags (div, h1, br, strong, em, strike,
//   a, pre, ol, ul, li, blockquote) and drops the others, keeping their text;
// - timesheet entries: hours as a decimal string with two digits ("1.33"), written as "1.5" or "1:20",
//   a plain date; deleting one trashes it (it then drops out of lists but is still answered); an
//   entry of someone else can be read, not changed (403);
// - search finds every recording type and everybody's, as bare records;
// - webhooks carry no signature: { id, kind, created_at, recording, creator }.

type Rec = Record<string, unknown>;
type SimPerson = { id: number; name: string; email: string; avatar: string | null };
export type SimColumn = { id: number; title: string; type: "Kanban::Triage" | "Kanban::Column" | "Kanban::NotNowColumn" | "Kanban::DoneColumn" };
export type SimProject = { id: number; name: string; status: "active" | "archived"; access: boolean; columns: SimColumn[] | null; tableId: number | null };
type SimComment = { id: number; content: string; created: number; by: number };
type SimEvent = { id: number; action: string; created: number; by: number; details: Rec };
export type SimRecording = {
  id: number;
  bucket: number;
  type: "Todo" | "Kanban::Card" | "Message";
  title: string;
  description: string;
  completed: boolean;
  completedAt: number | null;
  dueOn: string | null;
  startsOn: string | null;
  assignees: number[];
  creator: number;
  created: number;
  updated: number;
  status: "active" | "archived" | "trashed";
  column: number | null;
  list: string;
  priority: boolean;
  comments: SimComment[];
  events: SimEvent[];
  subscribers: Set<number>;
};
export type SimEntry = {
  id: number;
  bucket: number;
  recording: number;
  person: number;
  date: string;
  minutes: number;
  description: string;
  created: number;
  updated: number;
  status: "active" | "trashed";
};

const ALLOWED_TAGS = new Set(["div", "h1", "br", "strong", "em", "strike", "a", "pre", "ol", "ul", "li", "blockquote", "bc-attachment"]);
/** The account's UTC offset, as Basecamp writes it on every timestamp. */
const OFFSET_H = 2;
const PAGE = 15;

export function basecampSimulator(apiBase = "https://3.basecampapi.com", opts: { accountId?: string } = {}) {
  const token = `BAhbB0kiAbB7ImNsaWVudF9pZCI6sim${++simulators}`;
  const accountId = opts.accountId ?? "5001234";
  const web = apiBase.replace(/basecampapi\.com/, "basecamp.com");
  const origin = new URL(apiBase).origin;
  const me: SimPerson = { id: 1049715914, name: "Mario Rossi", email: "mario@acme.example", avatar: "https://bc3-production-assets-cdn.basecamp-static.com/avatar-1.png" };
  const anna: SimPerson = { id: 1049715915, name: "Anna Bianchi", email: "anna@acme.example", avatar: null };
  const people = new Map<number, SimPerson>([
    [me.id, me],
    [anna.id, anna],
  ]);
  const accountsOfToken: { product: string; id: number; name: string; href: string }[] = [{ product: "bc3", id: Number(accountId), name: "Acme", href: `${apiBase}/${accountId}` }];
  const projects = new Map<number, SimProject>();
  const recs: SimRecording[] = [];
  const entries: SimEntry[] = [];
  let seq = 0;
  const id = () => 9_000_000_000 + ++seq;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  /** Timestamps as Basecamp writes them: the account's offset. */
  const stamp = (ms: number) => `${new Date(ms + OFFSET_H * 3_600_000).toISOString().slice(0, -1)}+0${OFFSET_H}:00`;
  const state = { exhausted: false, calls: 0, revoked: false, linkTo: null as string | null };

  // ---------- Data ----------

  const addPerson = (name: string) => {
    const p: SimPerson = { id: id(), name, email: `${name.split(" ")[0].toLowerCase()}@acme.example`, avatar: null };
    people.set(p.id, p);
    return p;
  };
  const project = (name: string, o: { columns?: string[]; access?: boolean; cardTable?: boolean } = {}): SimProject => {
    const known = [...projects.values()].find((p) => p.name === name);
    if (known) return known;
    const hasTable = o.cardTable ?? o.columns !== undefined;
    const p: SimProject = {
      id: id(),
      name,
      status: "active",
      access: o.access ?? true,
      tableId: hasTable ? id() : null,
      columns: hasTable
        ? [
            { id: id(), title: "Triage", type: "Kanban::Triage" },
            ...(o.columns ?? []).map((title) => ({ id: id(), title, type: "Kanban::Column" as const })),
            { id: id(), title: "Not now", type: "Kanban::NotNowColumn" },
            { id: id(), title: "Done", type: "Kanban::DoneColumn" },
          ]
        : null,
    };
    projects.set(p.id, p);
    return p;
  };
  const columnOf = (p: SimProject, title: string) => p.columns?.find((c) => c.title === title);

  const add = (
    title: string,
    o: { project: SimProject; kind?: "Todo" | "Kanban::Card" | "Message"; column?: string; assignees?: number[]; description?: string; dueOn?: string; startsOn?: string; author?: number; list?: string; priority?: boolean },
  ): SimRecording => {
    const at = earlier();
    const kind = o.kind ?? "Todo";
    const col = kind === "Kanban::Card" ? (o.column ? columnOf(o.project, o.column) : o.project.columns?.[0]) : undefined;
    if (kind === "Kanban::Card" && !col) throw new Error(`no column ${o.column ?? "(first)"} in ${o.project.name}`);
    const r: SimRecording = {
      id: id(),
      bucket: o.project.id,
      type: kind,
      title,
      description: o.description ?? "",
      completed: col?.type === "Kanban::DoneColumn",
      completedAt: null,
      dueOn: o.dueOn ?? null,
      startsOn: o.startsOn ?? null,
      assignees: o.assignees ?? [me.id],
      creator: o.author ?? me.id,
      created: at,
      updated: at,
      status: "active",
      column: col?.id ?? null,
      list: o.list ?? "Launch list",
      priority: o.priority ?? false,
      comments: [],
      events: [{ id: id(), action: "created", created: at, by: o.author ?? me.id, details: {} }],
      subscribers: new Set(),
    };
    recs.push(r);
    return r;
  };
  const keyOf = (r: SimRecording) => `BC-${r.bucket}-${r.id}`;
  const urlOf = (r: SimRecording) => `${web}/${accountId}/buckets/${r.bucket}/${r.type === "Kanban::Card" ? "card_tables/cards" : "todos"}/${r.id}`;
  const recOf = (bucket: string, rid: string) => recs.find((r) => r.bucket === Number(bucket) && r.id === Number(rid));

  const event = (r: SimRecording, action: string, by = me.id, details: Rec = {}) => {
    const at = now();
    r.events.push({ id: id(), action, created: at, by, details });
    r.updated = at;
  };

  const entry = (r: SimRecording, o: { minutes: number; date: string; person?: number; description?: string }) => {
    const at = now();
    const e: SimEntry = { id: id(), bucket: r.bucket, recording: r.id, person: o.person ?? me.id, date: o.date, minutes: o.minutes, description: o.description ?? "", created: at, updated: at, status: "active" };
    entries.push(e);
    return e;
  };

  // ---------- Changes, whoever makes them ----------

  const setCompleted = (r: SimRecording, on: boolean, by = me.id) => {
    if (r.completed === on) return;
    r.completed = on;
    r.completedAt = on ? now() : null;
    event(r, on ? "completed" : "uncompleted", by);
  };
  const moveToColumn = (r: SimRecording, col: SimColumn, by = me.id) => {
    r.column = col.id;
    r.completed = col.type === "Kanban::DoneColumn";
    event(r, "moved", by, { column: col.title });
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign(r: SimRecording, ids: number[]) {
      const added = ids.filter((i) => !r.assignees.includes(i));
      const removed = r.assignees.filter((i) => !ids.includes(i));
      r.assignees = ids;
      event(r, "assignment_changed", anna.id, { added_person_ids: added, removed_person_ids: removed });
    },
    complete: (r: SimRecording) => setCompleted(r, true, anna.id),
    reopen: (r: SimRecording) => setCompleted(r, false, anna.id),
    retitle(r: SimRecording, title: string) {
      r.title = title;
      event(r, "content_changed", anna.id);
    },
    comment(r: SimRecording, content: string, by = anna.id) {
      r.comments.push({ id: id(), content, created: now(), by });
      r.updated = now();
    },
    moveToColumn(r: SimRecording, title: string) {
      const col = columnOf(projects.get(r.bucket)!, title);
      if (!col) throw new Error(`no column ${title}`);
      moveToColumn(r, col, anna.id);
    },
    /** Into the trash: still answered, with status trashed. */
    trash(r: SimRecording) {
      r.status = "trashed";
      r.updated = now();
    },
    restore(r: SimRecording) {
      r.status = "active";
      r.updated = now();
    },
    archive(r: SimRecording) {
      r.status = "archived";
      r.updated = now();
    },
    /** Moved to another project: a new recording there with a new id, the old one trashed. */
    moveToProject(r: SimRecording, to: SimProject): SimRecording {
      const copy: SimRecording = { ...r, id: id(), bucket: to.id, column: null, comments: [...r.comments], events: [...r.events], subscribers: new Set(r.subscribers), created: r.created, updated: now() };
      recs.push(copy);
      r.status = "trashed";
      r.updated = now();
      return copy;
    },
    due(r: SimRecording, dueOn: string | null) {
      r.dueOn = dueOn;
      event(r, "due_on_changed", anna.id);
    },
    renameProject(p: SimProject, name: string) {
      p.name = name;
      for (const r of recs.filter((x) => x.bucket === p.id)) r.updated = now();
    },
    renameColumn(p: SimProject, from: string, to: string) {
      const c = columnOf(p, from);
      if (c) c.title = to;
      for (const r of recs.filter((x) => x.column === c?.id)) r.updated = now();
    },
    /** The user loses (or regains) access to a project: 403 for everything in it. */
    access(p: SimProject, on: boolean) {
      p.access = on;
    },
    trashEntry(e: SimEntry) {
      e.status = "trashed";
    },
  };

  // ---------- Shapes ----------

  const personRec = (pid: number | null): Rec | null => {
    if (pid === null) return null;
    const p = people.get(pid) ?? { id: pid, name: `Person ${pid}`, email: "", avatar: null };
    return { id: p.id, attachable_sgid: `sgid-${p.id}`, name: p.name, email_address: p.email, avatar_url: p.avatar, admin: false, owner: false, client: false, time_zone: "Europe/Rome", type: "Person" };
  };
  const bucketRec = (p: SimProject): Rec => ({ id: p.id, name: p.name, type: "Project" });
  const recRec = (r: SimRecording): Rec => {
    const p = projects.get(r.bucket)!;
    const col = p.columns?.find((c) => c.id === r.column);
    const base: Rec = {
      id: r.id,
      status: r.status,
      visible_to_clients: false,
      created_at: stamp(r.created),
      updated_at: stamp(r.updated),
      inherits_status: true,
      type: r.type,
      url: `${apiBase}/${accountId}/buckets/${r.bucket}/${r.type === "Kanban::Card" ? "card_tables/cards" : "todos"}/${r.id}.json`,
      app_url: urlOf(r),
      comments_count: r.comments.length,
      bucket: bucketRec(p),
      creator: personRec(r.creator),
    };
    if (r.type === "Todo") {
      return {
        ...base,
        title: r.title,
        content: r.title,
        description: r.description,
        completed: r.completed,
        starts_on: r.startsOn,
        due_on: r.dueOn,
        assignees: r.assignees.map(personRec),
        completion: r.completed ? { created_at: stamp(r.completedAt ?? r.updated), creator: personRec(me.id) } : null,
        parent: { id: 1, title: r.list, type: "Todolist", app_url: `${web}/${accountId}/buckets/${r.bucket}/todolists/1` },
      };
    }
    if (r.type === "Kanban::Card") {
      return {
        ...base,
        title: r.title,
        content: r.description,
        completed: r.completed,
        due_on: r.dueOn,
        assignees: r.assignees.map(personRec),
        completion: r.completed ? { created_at: stamp(r.completedAt ?? r.updated), creator: personRec(me.id) } : null,
        parent: col ? { id: col.id, title: col.title, type: col.type } : null,
      };
    }
    return { ...base, title: r.title, content: r.description };
  };
  /** Search gives a bare record of any type. */
  const bareRec = (r: SimRecording): Rec => ({ id: r.id, status: r.status, type: r.type, title: r.title, app_url: urlOf(r), bucket: bucketRec(projects.get(r.bucket)!), creator: personRec(r.creator) });
  const entryRec = (e: SimEntry): Rec => {
    const r = recs.find((x) => x.id === e.recording)!;
    return {
      id: e.id,
      status: e.status,
      type: "Timesheet::Entry",
      date: e.date,
      hours: (e.minutes / 60).toFixed(2),
      description: e.description,
      created_at: stamp(e.created),
      updated_at: stamp(e.updated),
      person: personRec(e.person),
      creator: personRec(e.person),
      parent: { id: r.id, title: r.title, type: r.type, app_url: urlOf(r) },
      bucket: bucketRec(projects.get(e.bucket)!),
    };
  };
  const commentRec = (r: SimRecording, cm: SimComment): Rec => ({ id: cm.id, status: "active", type: "Comment", created_at: stamp(cm.created), updated_at: stamp(cm.created), content: cm.content, creator: personRec(cm.by), parent: { id: r.id, title: r.title, type: r.type } });
  const projectRec = (p: SimProject): Rec => ({
    id: p.id,
    status: p.status,
    name: p.name,
    purpose: "",
    dock: [
      { id: id(), title: "To-dos", name: "todoset", enabled: true },
      ...(p.tableId ? [{ id: p.tableId, title: "Card Table", name: "kanban_board", enabled: true }] : []),
    ],
  });

  /** Basecamp keeps a short list of tags in rich text and drops the others, keeping what is inside. */
  const sanitize = (html: string) => html.replace(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi, (m, _slash: string, tag: string) => (ALLOWED_TAGS.has(tag.toLowerCase()) ? m : ""));

  // ---------- The wire ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
  const empty = (status = 204) => new Response(null, { status });
  const fail = (status: number, error: string, headers: Record<string, string> = {}) => json({ error }, status, headers);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    state.calls++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body: Rec = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Rec) : {};
    // Basecamp refuses a client that doesn't say who it is.
    if (!headers.get("user-agent")) return fail(400, "Bad Request: send a User-Agent header with the name of your application and a contact");
    if (state.revoked || headers.get("authorization") !== `Bearer ${token}`) return fail(401, "Bad credentials");
    if (state.exhausted) return fail(429, "Too many requests", { "Retry-After": "10" });
    const q = url.searchParams;

    if (url.origin === "https://launchpad.37signals.com") {
      if (method === "GET" && url.pathname === "/authorization.json") return json({ expires_at: "2036-10-21T00:00:00.000Z", identity: { id: me.id, first_name: "Mario", last_name: "Rossi", email_address: me.email }, accounts: accountsOfToken });
      return fail(404, "Not Found");
    }
    if (url.origin !== origin) return fail(404, "Not Found");
    const m0 = /^\/(\d+)(\/.*)$/.exec(url.pathname);
    if (!m0) return fail(404, "Not Found");
    if (!accountsOfToken.some((a) => String(a.id) === m0[1])) return fail(404, "Not Found");
    const path = m0[2];

    /** A list as a page of 15 with its Link and total. */
    const paged = (list: unknown[]) => {
      const page = Math.max(1, Number(q.get("page") ?? 1));
      const slice = list.slice((page - 1) * PAGE, page * PAGE);
      const h: Record<string, string> = { "X-Total-Count": String(list.length) };
      if (page * PAGE < list.length) {
        const next = new URL(url.href);
        next.searchParams.set("page", String(page + 1));
        const target = state.linkTo ? `${state.linkTo}${next.pathname}${next.search}` : next.toString();
        h.Link = `<${target}>; rel="next"`;
      }
      return json(slice, 200, h);
    };
    const reach = (bucket: string): SimProject | Response => {
      const p = projects.get(Number(bucket));
      if (!p) return fail(404, "Not Found");
      if (!p.access) return fail(403, "You don't have access to this project");
      return p;
    };
    const accessible = (r: SimRecording) => projects.get(r.bucket)?.access === true;

    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/my/profile.json") return json(personRec(me.id));
    if ((m = /^\/people\/(\d+)\.json$/.exec(path))) {
      const p = people.get(Number(m[1]));
      return p ? json(personRec(p.id)) : fail(404, "Not Found");
    }

    if (method === "GET" && path === "/projects.json") return paged([...projects.values()].filter((p) => p.access && p.status === "active").map(projectRec));
    if (method === "GET" && (m = /^\/projects\/(\d+)\.json$/.exec(path))) {
      const p = reach(m[1]);
      return p instanceof Response ? p : json(projectRec(p));
    }

    if (method === "GET" && path === "/my/assignments.json") {
      const open = recs.filter((r) => r.status === "active" && r.type !== "Message" && !r.completed && r.assignees.includes(me.id) && accessible(r));
      const item = (r: SimRecording): Rec => ({
        id: r.id,
        app_url: urlOf(r),
        content: r.title,
        starts_on: r.startsOn,
        due_on: r.dueOn,
        bucket: bucketRec(projects.get(r.bucket)!),
        completed: r.completed,
        type: r.type,
        assignees: r.assignees.map(personRec),
        comments_count: r.comments.length,
        has_description: r.description !== "",
        parent: { id: 1, title: r.list },
        children: [],
      });
      return json({ priorities: open.filter((r) => r.priority).map(item), non_priorities: open.filter((r) => !r.priority).map(item) });
    }

    if (method === "GET" && path === "/projects/recordings.json") {
      const type = q.get("type");
      if (!type) return fail(400, "type is required");
      const status = q.get("status") ?? "active";
      if (!["active", "archived", "trashed"].includes(status)) return fail(400, "status is not valid");
      const dir = q.get("direction") === "asc" ? 1 : -1;
      const bucket = q.get("bucket");
      const list = recs
        .filter((r) => r.type === type && r.status === status && accessible(r) && (!bucket || String(r.bucket) === bucket))
        .sort((a, b) => dir * (a.updated - b.updated || a.id - b.id));
      return paged(list.map(recRec));
    }

    if (method === "GET" && path === "/search.json") {
      const text = (q.get("q") ?? "").toLowerCase();
      if (!text) return fail(400, "q is required");
      const hits = recs.filter((r) => r.status === "active" && accessible(r) && (r.title.toLowerCase().includes(text) || r.description.toLowerCase().includes(text))).sort((a, b) => b.updated - a.updated || b.id - a.id);
      return paged(hits.map(bareRec));
    }

    if ((m = /^\/buckets\/(\d+)\/(todos|card_tables\/cards)\/(\d+)\.json$/.exec(path)) && method === "GET") {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const r = recOf(m[1], m[3]);
      // The wrong path for the type is a 404; a trashed recording is answered.
      if (!r || r.type !== (m[2] === "todos" ? "Todo" : "Kanban::Card")) return fail(404, "Not Found");
      return json(recRec(r));
    }

    if ((m = /^\/buckets\/(\d+)\/todos\/(\d+)\/completion\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const r = recOf(m[1], m[2]);
      if (!r || r.type !== "Todo" || r.status !== "active") return fail(404, "Not Found");
      if (method === "POST") setCompleted(r, true);
      else if (method === "DELETE") setCompleted(r, false);
      else return fail(405, "Method Not Allowed");
      return empty();
    }

    if (method === "GET" && (m = /^\/buckets\/(\d+)\/card_tables\/(\d+)\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      if (!p.columns || p.tableId !== Number(m[2])) return fail(404, "Not Found");
      return json({ id: p.tableId, title: "Card Table", type: "Kanban::Board", lists: p.columns.map((c) => ({ id: c.id, title: c.title, type: c.type, cards_count: recs.filter((r) => r.column === c.id && r.status === "active").length })) });
    }
    if (method === "POST" && (m = /^\/buckets\/(\d+)\/card_tables\/cards\/(\d+)\/moves\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const r = recOf(m[1], m[2]);
      if (!r || r.type !== "Kanban::Card" || r.status !== "active") return fail(404, "Not Found");
      const col = p.columns?.find((c) => c.id === Number(body.column_id));
      if (!col) return fail(422, "column_id is not a column of this card table");
      moveToColumn(r, col);
      return empty();
    }

    if ((m = /^\/buckets\/(\d+)\/recordings\/(\d+)\/(comments|subscription|events|timesheet)\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const r = recOf(m[1], m[2]);
      if (!r || r.status === "trashed") return fail(404, "Not Found");
      switch (m[3]) {
        case "comments":
          if (method === "GET") return paged(r.comments.map((c) => commentRec(r, c)));
          if (method === "POST") {
            if (typeof body.content !== "string" || body.content === "") return fail(422, "Content can't be blank");
            const cm: SimComment = { id: id(), content: sanitize(body.content), created: now(), by: me.id };
            r.comments.push(cm);
            r.updated = now();
            return json(commentRec(r, cm), 201);
          }
          break;
        case "subscription":
          if (method === "POST") r.subscribers.add(me.id);
          else if (method === "DELETE") r.subscribers.delete(me.id);
          else break;
          return json({ subscribed: r.subscribers.has(me.id), count: r.subscribers.size, subscribers: [...r.subscribers].map(personRec) });
        case "events":
          if (method === "GET") return paged(r.events.map((e) => ({ id: e.id, recording_id: r.id, action: e.action, details: e.details, created_at: stamp(e.created), creator: personRec(e.by) })));
          break;
        case "timesheet":
          if (method === "GET") return paged(entries.filter((e) => e.recording === r.id && e.status === "active").map(entryRec));
          break;
      }
      return fail(405, "Method Not Allowed");
    }

    if (method === "POST" && (m = /^\/buckets\/(\d+)\/recordings\/(\d+)\/timesheet\/entries\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const r = recOf(m[1], m[2]);
      if (!r || r.status !== "active" || r.type === "Message") return fail(404, "Not Found");
      const v = entryFields(body);
      if (typeof v === "string") return fail(422, v);
      const person = body.person_id === undefined ? me.id : Number(body.person_id);
      if (!people.has(person)) return fail(422, "Person is not valid");
      const e = entry(r, { ...v, person });
      return json(entryRec(e), 201);
    }
    if ((m = /^\/buckets\/(\d+)\/timesheet\/entries\/(\d+)\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const e = entries.find((x) => x.bucket === Number(m![1]) && x.id === Number(m![2]));
      if (!e) return fail(404, "Not Found");
      if (method === "GET") return json(entryRec(e));
      if (method === "PUT") {
        if (e.status !== "active") return fail(404, "Not Found");
        if (e.person !== me.id) return fail(403, "You can only change your own time entries");
        const v = entryFields(body);
        if (typeof v === "string") return fail(422, v);
        Object.assign(e, v, { updated: now() });
        return json(entryRec(e));
      }
      return fail(405, "Method Not Allowed");
    }
    if (method === "PUT" && (m = /^\/buckets\/(\d+)\/recordings\/(\d+)\/status\/trashed\.json$/.exec(path))) {
      const p = reach(m[1]);
      if (p instanceof Response) return p;
      const e = entries.find((x) => x.bucket === Number(m![1]) && x.id === Number(m![2]));
      if (e) {
        if (e.person !== me.id) return fail(403, "You can only trash your own time entries");
        e.status = "trashed";
        return empty();
      }
      const r = recOf(m[1], m[2]);
      if (!r) return fail(404, "Not Found");
      r.status = "trashed";
      r.updated = now();
      return empty();
    }

    if (method === "GET" && path === "/reports/timesheet.json") {
      const from = q.get("from");
      const to = q.get("to");
      if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return fail(400, "from and to are required dates");
      const person = q.get("person_id");
      // Plain strings compare as dates; the report holds the active entries of the projects the user can reach.
      const list = entries
        .filter((e) => e.status === "active" && projects.get(e.bucket)?.access === true && e.date >= from && e.date <= to && (!person || String(e.person) === person))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
      return paged(list.map(entryRec));
    }

    return fail(404, `unmocked ${method} ${path}`);
  }

  /** hours as "1.5" or "1:20", a date: what a timesheet entry takes (a message when it doesn't). */
  function entryFields(body: Rec): { date: string; minutes: number; description: string } | string {
    const date = body.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return "Date is invalid";
    const hours = typeof body.hours === "string" || typeof body.hours === "number" ? String(body.hours) : "";
    const clock = /^(\d+):([0-5]\d)$/.exec(hours);
    const decimal = /^\d+(\.\d+)?$/.test(hours) ? Number(hours) : NaN;
    const minutes = clock ? Number(clock[1]) * 60 + Number(clock[2]) : Math.round(decimal * 60);
    if (!Number.isFinite(minutes) || minutes <= 0) return "Hours is invalid";
    return { date, minutes, description: typeof body.description === "string" ? body.description : "" };
  }

  // ---------- Webhooks ----------

  /** A delivery as Basecamp sends it: a payload with the recording, no signature. */
  const webhook = (kind: string, r: SimRecording, o: { ageMs?: number; deliveryId?: number } = {}) => ({
    rawBody: JSON.stringify({ id: o.deliveryId ?? id(), kind, details: {}, created_at: stamp(Date.now() - (o.ageMs ?? 0)), recording: recRec(r), creator: personRec(anna.id) }),
    headers: { "content-type": "application/json" },
  });

  return {
    apiBase,
    web,
    token,
    accountId,
    me,
    anna,
    people,
    projects,
    recs,
    entries,
    accountsOfToken,
    state,
    project,
    addPerson,
    add,
    entry,
    outside,
    keyOf,
    urlOf,
    webhook,
    /** The user is also on another Basecamp product (or account). */
    addAccount: (product: string, accountNumber: number) => accountsOfToken.push({ product, id: accountNumber, name: `${product} ${accountNumber}`, href: `${apiBase}/${accountNumber}` }),
    /** Every call from now on is refused as over the limit (429, Retry-After 10). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    /** Pages' Link headers point to another server. */
    hijackLinks: (to: string | null) => (state.linkTo = to),
    fetch: handle,
  };
}

let simulators = 0;
