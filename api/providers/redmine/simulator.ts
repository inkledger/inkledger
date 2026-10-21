// A Redmine in memory, for tests: the REST (JSON) endpoints the adapter calls,
// written from Redmine's documentation (not recorded from a real server), with
// its shapes and traps:
// - X-Redmine-API-Key or 401 (an empty body); a proxy's 429 with Retry-After and an HTML body; no rate headers of its own;
// - the format is the `.json` suffix: with the REST API off (or a login page in the way) every answer is HTML;
// - /issues lists open issues unless status_id is given (`*` for all), newest id first unless sorted; limit tops out at 100 (default 25), total_count says how many;
// - an issue id is unique on the server, not per project: a move to another project keeps it; the issue JSON names its project by id and name only (no identifier), and its status without is_closed;
// - an issue the user may not see is a 403 (Redmine authorizes after finding), not a 404;
// - timestamps are UTC to the second ("…Z"); dates (spent_on, due_date) are plain; the updated_on filter takes ">=" with a time; a bare date is the start of that UTC day;
// - journals (comments and history in one list): a journal with no notes is only history; changing an issue or adding a note answers 204 with nothing;
// - allowed_statuses (Redmine 5.0+, include=allowed_statuses) lists the current status too; an older server omits it; a workflow may demand a field (422);
// - time entries: hours are decimal to two places, spent_on a plain date; the default sort is newest day first; creating answers 201 with the record, updating 204;
//   an activity is required (the default one is used when none is given, 422 when the server has no default or the project does not offer it);
//   the issue_id filter also returns the issue's subtasks' entries; time logged on a project has no issue; comments are at most 1024 characters;
//   a user_id the account may not log for is silently ignored: the entry is made for the caller;
// - watchers: POST/DELETE answer 204 whether or not it changed anything; 403 without the permission.
import type { RmActivity, RmIssue, RmJournal, RmJournalDetail, RmProject, RmStatus, RmTimeEntry, RmUser } from "./client";

export type SimStatus = { id: number; name: string; closed: boolean };
export type SimProject = { id: number; identifier: string; name: string; parent: number | null; access: boolean; activities: number[] | null };
export type SimJournal = { id: number; user: number; notes: string; created: number; private: boolean; details: RmJournalDetail[] };
export type SimIssue = {
  id: number;
  projectId: number;
  trackerId: number;
  statusId: number;
  priorityId: number;
  author: number;
  assignee: number | null;
  parent: number | null;
  subject: string;
  description: string;
  start: string | null;
  due: string | null;
  estimated: number | null;
  created: number;
  updated: number;
  closed: number | null;
  watchers: Set<number>;
  journals: SimJournal[];
  customFields: { id: number; name: string; value: string }[];
};
export type SimEntry = { id: number; issueId: number | null; projectId: number; user: number; activity: number; hours: number; comments: string; spentOn: string; created: number; updated: number };

export const STATUS = { new: 1, inProgress: 2, resolved: 3, feedback: 4, closed: 5, rejected: 6 } as const;

export function redmineSimulator(apiBase = "https://redmine.example.com", me: RmUser = { id: 77, login: "mrossi", firstname: "Mario", lastname: "Rossi", mail: "mario@example.com" }) {
  const token = "redmine-simulated-key";
  const prefix = new URL(apiBase).pathname.replace(/\/$/, "");
  const users = new Map<number, RmUser>([
    [me.id, me],
    [78, { id: 78, login: "anna.b", firstname: "Anna", lastname: "Bianchi", mail: "anna@example.com" }],
  ]);
  const statuses: SimStatus[] = [
    { id: 1, name: "New", closed: false },
    { id: 2, name: "In Progress", closed: false },
    { id: 3, name: "Resolved", closed: false },
    { id: 4, name: "Feedback", closed: false },
    { id: 5, name: "Closed", closed: true },
    { id: 6, name: "Rejected", closed: true },
  ];
  const trackers = [
    { id: 1, name: "Bug" },
    { id: 2, name: "Feature" },
    { id: 3, name: "Support" },
  ];
  const priorities = [
    { id: 3, name: "Low" },
    { id: 4, name: "Normal" },
    { id: 5, name: "High" },
  ];
  const activities: (RmActivity & { active: boolean })[] = [
    { id: 8, name: "Design", is_default: false, active: true },
    { id: 9, name: "Development", is_default: true, active: true },
    { id: 10, name: "Testing", is_default: false, active: true },
    { id: 11, name: "Retired", is_default: false, active: false },
  ];
  const projects = new Map<number, SimProject>();
  const issues: SimIssue[] = [];
  const entries: SimEntry[] = [];
  /** from status id → the ones it may move to (absent: every other); to status id → a field it demands */
  const workflow = new Map<number, number[]>();
  const demands = new Map<number, "assigned_to">();
  let seq = 100;
  // Strictly increasing and never behind the real clock, so "changed since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  // What existed before the test began is dated hours ago, one second apart.
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  /** UTC to the second, as Redmine prints it */
  const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const state = {
    exhausted: false,
    calls: 0,
    revoked: false,
    /** The REST web service is off: every answer is an HTML page */
    html: false,
    /** Redmine 5.0+: include=allowed_statuses is honoured */
    v5: true,
    /** The account may not see time entries: spent_hours is left out */
    hideSpent: false,
    canLogForOthers: false,
    canEditAllEntries: false,
    canWatch: true,
    hasDefaultActivity: true,
  };

  const project = (identifier: string, o: { access?: boolean; name?: string; parent?: string; activities?: number[] | null } = {}) => {
    const known = [...projects.values()].find((p) => p.identifier === identifier);
    if (known) {
      if (o.access !== undefined) known.access = o.access;
      if (o.activities !== undefined) known.activities = o.activities;
      return known;
    }
    const p: SimProject = { id: ++seq, identifier, name: o.name ?? identifier.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), parent: o.parent ? project(o.parent).id : null, access: o.access ?? true, activities: o.activities ?? null };
    projects.set(p.id, p);
    return p;
  };
  const projectById = (id: string) => (/^\d+$/.test(id) ? projects.get(Number(id)) : [...projects.values()].find((p) => p.identifier === id));

  const add = (
    identifier: string,
    subject: string,
    o: { assignee?: number | null; status?: number; description?: string; due?: string; start?: string; author?: number; parent?: SimIssue; estimated?: number; tracker?: number; priority?: number; custom?: { id: number; name: string; value: string }[] } = {},
  ): SimIssue => {
    const p = project(identifier);
    const at = earlier();
    const status = o.status ?? STATUS.new;
    const i: SimIssue = {
      id: ++seq,
      projectId: p.id,
      trackerId: o.tracker ?? 1,
      statusId: status,
      priorityId: o.priority ?? 4,
      author: o.author ?? me.id,
      assignee: o.assignee === null ? null : (o.assignee ?? me.id),
      parent: o.parent?.id ?? null,
      subject,
      description: o.description ?? "",
      start: o.start ?? null,
      due: o.due ?? null,
      estimated: o.estimated ?? null,
      created: at,
      updated: at,
      closed: statuses.find((s) => s.id === status)?.closed ? at : null,
      watchers: new Set(),
      journals: [],
      customFields: o.custom ?? [],
    };
    issues.push(i);
    return i;
  };
  const keyOf = (i: SimIssue) => `#${i.id}`;
  const visible = (i: SimIssue) => !!projects.get(i.projectId)?.access;
  const statusOf = (id: number) => statuses.find((s) => s.id === id)!;

  const journal = (i: SimIssue, by: number, notes: string, details: RmJournalDetail[] = [], isPrivate = false) => {
    const j: SimJournal = { id: ++seq, user: by, notes, created: now(), private: isPrivate, details };
    i.journals.push(j);
    i.updated = j.created;
    return j;
  };
  const setStatus = (i: SimIssue, next: number, by = me.id) => {
    if (i.statusId === next) return;
    journal(i, by, "", [{ property: "attr", name: "status_id", old_value: String(i.statusId), new_value: String(next) }]);
    i.statusId = next;
    i.closed = statusOf(next).closed ? now() : null;
  };
  const setAssignee = (i: SimIssue, user: number | null, by = me.id) => {
    journal(i, by, "", [{ property: "attr", name: "assigned_to_id", old_value: i.assignee === null ? null : String(i.assignee), new_value: user === null ? null : String(user) }]);
    i.assignee = user;
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign: (i: SimIssue, user: number | null) => setAssignee(i, user, 78),
    status: (i: SimIssue, id: number) => setStatus(i, id, 78),
    retitle(i: SimIssue, subject: string) {
      journal(i, 78, "", [{ property: "attr", name: "subject", old_value: i.subject, new_value: subject }]);
      i.subject = subject;
    },
    comment: (i: SimIssue, notes: string, by = 78) => journal(i, by, notes),
    /** Redmine keeps the issue's id when it moves to another project; only its project changes */
    moveToProject(i: SimIssue, identifier: string) {
      const to = project(identifier);
      journal(i, 78, "", [{ property: "attr", name: "project_id", old_value: String(i.projectId), new_value: String(to.id) }]);
      i.projectId = to.id;
    },
    /** The user loses (or regains) access to a project: 403 for its issues, absent from every list */
    access: (identifier: string, on: boolean) => void project(identifier, { access: on }),
    deleteEntry(e: SimEntry) {
      entries.splice(entries.indexOf(e), 1);
    },
    editEntry(e: SimEntry, o: { hours?: number; comments?: string; spentOn?: string }) {
      if (o.hours !== undefined) e.hours = o.hours;
      if (o.comments !== undefined) e.comments = o.comments;
      if (o.spentOn !== undefined) e.spentOn = o.spentOn;
      e.updated = now();
    },
  };

  const entry = (issue: SimIssue | null, o: { hours: number; spentOn: string; user?: number; activity?: number; comments?: string; project?: string }): SimEntry => {
    const e: SimEntry = {
      id: ++seq,
      issueId: issue?.id ?? null,
      projectId: issue ? issue.projectId : project(o.project ?? "acme").id,
      user: o.user ?? me.id,
      activity: o.activity ?? 9,
      hours: o.hours,
      comments: o.comments ?? "",
      spentOn: o.spentOn,
      created: now(),
      updated: now(),
    };
    entries.push(e);
    if (issue) issue.updated = now();
    return e;
  };

  // ---------- Shapes ----------

  const userRef = (id: number) => {
    const u = users.get(id);
    return { id, name: u ? `${u.firstname} ${u.lastname}` : `User ${id}` };
  };
  const shownJournal = (j: SimJournal): RmJournal => ({ id: j.id, user: userRef(j.user), notes: j.notes, created_on: iso(j.created), private_notes: j.private, details: j.details });
  const spentHours = (i: SimIssue) => Math.round(entries.filter((e) => e.issueId === i.id).reduce((a, e) => a + e.hours, 0) * 100) / 100;
  const shown = (i: SimIssue, include: string[] = []): RmIssue => {
    const p = projects.get(i.projectId)!;
    const s = statusOf(i.statusId);
    const allowed = workflow.get(i.statusId) ?? statuses.filter((x) => x.id !== i.statusId).map((x) => x.id);
    return {
      id: i.id,
      // The project by id and name only: its identifier is not here.
      project: { id: p.id, name: p.name },
      tracker: trackers.find((t) => t.id === i.trackerId),
      // The status without is_closed: that comes with the status list.
      status: { id: s.id, name: s.name },
      priority: priorities.find((x) => x.id === i.priorityId),
      author: userRef(i.author),
      ...(i.assignee === null ? {} : { assigned_to: userRef(i.assignee) }),
      ...(i.parent === null ? {} : { parent: { id: i.parent } }),
      subject: i.subject,
      description: i.description,
      start_date: i.start,
      due_date: i.due,
      ...(i.estimated === null ? {} : { estimated_hours: i.estimated }),
      ...(state.hideSpent ? {} : { spent_hours: spentHours(i) }),
      ...(i.customFields.length > 0 ? { custom_fields: i.customFields } : {}),
      created_on: iso(i.created),
      updated_on: iso(i.updated),
      closed_on: i.closed === null ? null : iso(i.closed),
      ...(include.includes("journals") ? { journals: i.journals.map(shownJournal) } : {}),
      ...(include.includes("allowed_statuses") && state.v5
        ? { allowed_statuses: [statusOf(i.statusId), ...allowed.map(statusOf)].map((x): RmStatus => ({ id: x.id, name: x.name, is_closed: x.closed })) }
        : {}),
    };
  };
  const shownEntry = (e: SimEntry): RmTimeEntry => {
    const a = activities.find((x) => x.id === e.activity)!;
    return {
      id: e.id,
      project: { id: e.projectId, name: projects.get(e.projectId)?.name },
      ...(e.issueId === null ? {} : { issue: { id: e.issueId } }),
      user: userRef(e.user),
      activity: { id: a.id, name: a.name },
      hours: e.hours,
      comments: e.comments,
      spent_on: e.spentOn,
      created_on: iso(e.created),
      updated_on: iso(e.updated),
    };
  };

  // ---------- HTTP ----------

  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : status === 401 ? "" : JSON.stringify(body), { status, headers: { ...(status === 204 || status === 401 ? {} : { "Content-Type": "application/json; charset=utf-8" }), Date: new Date(clock).toUTCString(), ...headers } });
  const errors = (messages: string[], status = 422) => respond({ errors: messages }, status);

  /** A filter value as Redmine reads it: an optional operator, then the value. */
  const operator = (raw: string | null) => {
    const m = raw === null ? null : /^(><|>=|<=|=|>|<|~|!)?(.*)$/s.exec(raw);
    return m ? { op: m[1] ?? "=", value: m[2] } : null;
  };
  /** A date-time filter bound: a time with a zone is exact (to the second); a bare date is the start of that UTC day. */
  const bound = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(v) ? Date.parse(v) : NaN);

  const listed = <T>(url: URL, key: string, rows: T[], shape: (t: T) => unknown) => {
    // limit tops out at 100, whatever was asked
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    return respond({ [key]: rows.slice(offset, offset + limit).map(shape), total_count: rows.length, offset, limit });
  };

  const sortRows = <T extends { id: number }>(url: URL, rows: T[], fallback: string, field: (t: T, name: string) => number | string) => {
    const keys = (url.searchParams.get("sort") ?? fallback).split(",").map((k) => ({ name: k.split(":")[0], dir: k.endsWith(":desc") ? -1 : 1 }));
    return [...rows].sort((a, b) => {
      for (const k of keys) {
        const x = field(a, k.name);
        const y = field(b, k.name);
        if (x !== y) return k.dir * (x < y ? -1 : 1);
      }
      return 0;
    });
  };

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, Record<string, unknown>>) : {};
    state.calls++;

    if (state.exhausted) return new Response("<html><body>429 Too Many Requests</body></html>", { status: 429, headers: { "Content-Type": "text/html", "Retry-After": "30" } });
    if (state.html) return new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    if (headers.get("x-redmine-api-key") !== token || state.revoked) return respond({}, 401);

    const path = url.pathname.slice(prefix.length);
    if (!path.endsWith(".json")) return new Response("<html><body>Redmine</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const include = (url.searchParams.get("include") ?? "").split(",");

    if (path === "/users/current.json") return respond({ user: me });
    let m = /^\/users\/(\d+)\.json$/.exec(path);
    if (m) {
      const u = users.get(Number(m[1]));
      return u ? respond({ user: u }) : respond({}, 404);
    }
    if (path === "/issue_statuses.json") return respond({ issue_statuses: statuses.map((s) => ({ id: s.id, name: s.name, is_closed: s.closed })) });
    if (path === "/enumerations/issue_priorities.json") return respond({ issue_priorities: priorities });
    if (path === "/trackers.json") return respond({ trackers });
    if (path === "/enumerations/time_entry_activities.json") return respond({ time_entry_activities: activities });

    if (path === "/projects.json") {
      const rows = [...projects.values()].filter((p) => p.access);
      return listed(url, "projects", rows, (p): RmProject => ({ id: p.id, name: p.name, identifier: p.identifier, ...(p.parent === null ? {} : { parent: { id: p.parent, name: projects.get(p.parent)?.name } }) }));
    }
    m = /^\/projects\/([^/]+)\.json$/.exec(path);
    if (m) {
      const p = projectById(decodeURIComponent(m[1]));
      if (!p) return respond({}, 404);
      if (!p.access) return respond({}, 403);
      const offered = activities.filter((a) => a.active && (p.activities === null || p.activities.includes(a.id)));
      return respond({ project: { id: p.id, name: p.name, identifier: p.identifier, ...(include.includes("time_entry_activities") ? { time_entry_activities: offered.map((a) => ({ id: a.id, name: a.name })) } : {}) } });
    }

    // ----- Issues -----
    if (path === "/issues.json" && method === "GET") {
      const q = url.searchParams;
      const who = (v: string | null) => (v === null ? null : v === "me" ? me.id : Number(v));
      const assigned = who(q.get("assigned_to_id"));
      const author = who(q.get("author_id"));
      const wanted = q.get("status_id") ?? "open";
      const updated = operator(q.get("updated_on"));
      const bounds = updated ? (updated.op === "><" ? updated.value.split("|").map(bound) : [bound(updated.value)]) : [];
      if (bounds.some((b) => Number.isNaN(b)) || (updated && ![">=", "<=", "=", ">", "<", "><"].includes(updated.op))) return errors(["Updated is invalid"]);
      const text = (name: string) => operator(q.get(name));
      const subject = text("subject");
      const description = text("description");
      const has = (value: string, f: { op: string; value: string } | null) => !f || (f.op === "~" ? value.toLowerCase().includes(f.value.toLowerCase()) : value === f.value);
      const rows = issues
        .filter(visible)
        .filter((i) => assigned === null || i.assignee === assigned)
        .filter((i) => author === null || i.author === author)
        .filter((i) => (wanted === "*" ? true : wanted === "open" ? !statusOf(i.statusId).closed : wanted === "closed" ? statusOf(i.statusId).closed : i.statusId === Number(wanted)))
        .filter((i) => {
          // Compared to the second: Redmine prints no more.
          const at = Math.floor(i.updated / 1000) * 1000;
          if (!updated) return true;
          const [a, b] = bounds;
          return updated.op === ">=" ? at >= a : updated.op === ">" ? at > a : updated.op === "<=" ? at <= a : updated.op === "<" ? at < a : updated.op === "=" ? at === a : at >= a && at <= b;
        })
        .filter((i) => has(i.subject, subject) && has(i.description, description));
      return listed(url, "issues", sortRows(url, rows, "id:desc", (i, f) => (f === "updated_on" ? Math.floor(i.updated / 1000) : f === "created_on" ? Math.floor(i.created / 1000) : i.id)), (i) => shown(i));
    }
    m = /^\/issues\/(\d+)\.json$/.exec(path);
    if (m) {
      const i = issues.find((x) => x.id === Number(m![1]));
      if (!i) return respond({}, 404);
      // Found first, authorized after: an issue that exists but is not the user's to see is a 403.
      if (!visible(i)) return respond({}, 403);
      if (method === "GET") return respond({ issue: shown(i, include) });
      if (method === "PUT") {
        const f = body.issue ?? {};
        const problems: string[] = [];
        let next: number | null = null;
        if (f.status_id !== undefined) {
          next = Number(f.status_id);
          const allowed = workflow.get(i.statusId) ?? statuses.filter((x) => x.id !== i.statusId).map((x) => x.id);
          if (!statuses.some((s) => s.id === next) || (next !== i.statusId && !allowed.includes(next))) problems.push("Status is invalid");
          else if (demands.get(next) === "assigned_to" && i.assignee === null) problems.push("Assignee cannot be blank");
        }
        if (f.subject !== undefined && (typeof f.subject !== "string" || !f.subject.trim())) problems.push("Subject cannot be blank");
        if (problems.length > 0) return errors(problems);
        if (typeof f.subject === "string") i.subject = f.subject;
        if (next !== null) setStatus(i, next);
        if (typeof f.notes === "string" && f.notes.trim()) journal(i, me.id, f.notes);
        return respond(null, 204);
      }
    }
    m = /^\/issues\/(\d+)\/watchers(?:\/(\d+))?\.json$/.exec(path);
    if (m) {
      const i = issues.find((x) => x.id === Number(m![1]));
      if (!i) return respond({}, 404);
      if (!visible(i) || !state.canWatch) return respond({}, 403);
      if (method === "POST") i.watchers.add(Number((body as unknown as { user_id?: number }).user_id));
      else if (method === "DELETE") i.watchers.delete(Number(m[2]));
      return respond(null, 204);
    }

    // ----- Time entries -----
    if (path === "/time_entries.json" && method === "GET") {
      const q = url.searchParams;
      const user = q.get("user_id") === null ? null : q.get("user_id") === "me" ? me.id : Number(q.get("user_id"));
      const issue = q.get("issue_id") === null ? null : Number(q.get("issue_id"));
      const from = q.get("from");
      const to = q.get("to");
      if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) return errors(["Date is invalid"]);
      // The issue filter reaches the subtasks too.
      const family = (id: number): number[] => [id, ...issues.filter((x) => x.parent === id).flatMap((x) => family(x.id))];
      const reach = issue === null ? null : family(issue);
      const rows = entries
        .filter((e) => projects.get(e.projectId)?.access)
        .filter((e) => user === null || e.user === user)
        .filter((e) => reach === null || (e.issueId !== null && reach.includes(e.issueId)))
        .filter((e) => (!from || e.spentOn >= from) && (!to || e.spentOn <= to));
      return listed(url, "time_entries", sortRows(url, rows, "spent_on:desc,id:desc", (e, f) => (f === "spent_on" ? e.spentOn : e.id)), shownEntry);
    }
    if (path === "/time_entries.json" && method === "POST") {
      const f = body.time_entry ?? {};
      const issue = f.issue_id === undefined ? null : issues.find((x) => x.id === Number(f.issue_id));
      if (f.issue_id !== undefined && !issue) return errors(["Issue is invalid"]);
      if (issue && !visible(issue)) return respond({}, 403);
      const problems = entryProblems(f, issue?.projectId ?? null, true);
      if (problems.length > 0) return errors(problems);
      // A user_id the account may not log for is dropped without a word: the entry is the caller's.
      const user = f.user_id !== undefined && state.canLogForOthers && users.has(Number(f.user_id)) ? Number(f.user_id) : me.id;
      const defaultActivity = activities.find((a) => a.is_default)?.id ?? 9;
      const e = entry(issue ?? null, {
        hours: roundHours(f.hours),
        spentOn: typeof f.spent_on === "string" ? f.spent_on : day(Date.now()),
        user,
        activity: f.activity_id !== undefined ? Number(f.activity_id) : defaultActivity,
        comments: typeof f.comments === "string" ? f.comments : "",
      });
      return respond({ time_entry: shownEntry(e) }, 201);
    }
    m = /^\/time_entries\/(\d+)\.json$/.exec(path);
    if (m) {
      const e = entries.find((x) => x.id === Number(m[1]));
      if (!e) return respond({}, 404);
      if (!projects.get(e.projectId)?.access) return respond({}, 403);
      if (method === "GET") return respond({ time_entry: shownEntry(e) });
      if (e.user !== me.id && !state.canEditAllEntries) return respond({}, 403);
      if (method === "DELETE") {
        entries.splice(entries.indexOf(e), 1);
        return respond(null, 204);
      }
      if (method === "PUT") {
        const f = body.time_entry ?? {};
        const problems = entryProblems(f, e.projectId, false);
        if (problems.length > 0) return errors(problems);
        if (f.hours !== undefined) e.hours = roundHours(f.hours);
        if (typeof f.spent_on === "string") e.spentOn = f.spent_on;
        if (typeof f.comments === "string") e.comments = f.comments;
        if (f.activity_id !== undefined) e.activity = Number(f.activity_id);
        e.updated = now();
        return respond(null, 204);
      }
    }
    return errors([`unmocked ${method} ${path}`], 404);
  }

  /** Hours are kept to two places. */
  const roundHours = (v: unknown) => Math.round(Number(v) * 100) / 100;

  /** What Redmine refuses in a time entry; a create needs hours, an update only checks what it changes. */
  function entryProblems(f: Record<string, unknown>, projectId: number | null, creating: boolean): string[] {
    const out: string[] = [];
    if (creating && projectId === null && f.project_id === undefined) out.push("Project cannot be blank");
    if (f.hours === undefined || f.hours === null || f.hours === "") {
      if (creating) out.push("Hours cannot be blank");
    } else if (typeof f.hours !== "number" || Number.isNaN(f.hours) || f.hours < 0 || f.hours >= 1000) out.push("Hours is invalid");
    if (f.spent_on !== undefined && (typeof f.spent_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f.spent_on) || Number.isNaN(Date.parse(f.spent_on)))) out.push("Date is invalid");
    if (typeof f.comments === "string" && f.comments.length > 1024) out.push("Comment is too long (maximum is 1024 characters)");
    if (f.activity_id !== undefined) {
      const a = activities.find((x) => x.id === Number(f.activity_id));
      const p = projectId === null ? undefined : [...projects.values()].find((x) => x.id === projectId);
      if (!a || !a.active || (p?.activities && !p.activities.includes(a.id))) out.push("Activity is invalid");
    } else if (creating && !state.hasDefaultActivity) out.push("Activity cannot be blank");
    if (creating && f.activity_id === undefined && state.hasDefaultActivity) {
      const a = activities.find((x) => x.is_default);
      const p = projectId === null ? undefined : [...projects.values()].find((x) => x.id === projectId);
      if (a && p?.activities && !p.activities.includes(a.id)) out.push("Activity cannot be blank");
    }
    return out;
  }

  return {
    apiBase,
    token,
    me,
    users,
    projects,
    issues,
    entries,
    statuses,
    activities,
    state,
    project,
    add,
    entry,
    outside,
    keyOf,
    workflow,
    demands,
    /** Every call from now on is refused as over the limit (429, Retry-After 30). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The key stops working (401). */
    revoke: () => (state.revoked = true),
    /** Take the default activity away (the server has none set). */
    noDefaultActivity: () => {
      state.hasDefaultActivity = false;
      for (const a of activities) a.is_default = false;
    },
    fetch: handle,
  };
}
