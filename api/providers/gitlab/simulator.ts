// A GitLab in memory, for tests: the REST v4 endpoints and the GraphQL queries
// the adapter calls, written from GitLab's documentation (not recorded from a
// real server), with its shapes and traps:
// - PRIVATE-TOKEN or 401; RateLimit-* headers on every answer, 429 with Retry-After and a plain-text body;
// - /issues defaults to scope=created_by_me, takes state=opened (not "open"), caps per_page at 100;
// - two ids: `id` is the instance's, `iid` the project's; a project is reached by id or by its current path (an old path is a 404);
// - what you can't see answers 404, not 403;
// - a moved issue stays, closed, with moved_to_id; scoped labels (a::b) replace each other;
// - system notes mixed into the notes; quick actions (/close) in a note run instead of being kept;
// - subscribing twice answers 304; label events of a deleted label have label: null;
// - GraphQL answers 200 with errors; its startDate/endDate on a bare date snap to UTC days;
// - self-managed sites send avatars as paths on their own site.
import type { GitLabIssue, GitLabLabelEvent, GitLabMilestoneEvent, GitLabNote, GitLabStateEvent, GitLabUser } from "./client";
import { gidOf } from "./client";

type SimNote = { id: number; body: string; author: number; created: number; system: boolean };
type SimEvent = { id: number; user: number; created: number } & ({ kind: "label"; label: string; labelId: number; action: "add" | "remove" } | { kind: "state"; state: string });
export type SimIssue = {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  labels: string[];
  assignees: number[];
  author: number;
  due: string | null;
  created: number;
  updated: number;
  closed: number | null;
  movedTo: number | null;
  type: string;
  confidential: boolean;
  subscribed: Set<number>;
  notes: SimNote[];
  events: SimEvent[];
};
type SimProject = { id: number; path: string; access: boolean; deletedLabels: Set<string> };
type SimTimelog = { id: number; issueId: number; user: number; at: number; seconds: number; summary: string };

export function gitlabSimulator(apiBase = "https://gitlab.com/api/v4", me: GitLabUser = { id: 77, username: "mrossi", name: "Mario Rossi", avatar_url: "https://secure.gravatar.com/avatar/77" }) {
  const token = "glpat-simulated";
  const web = apiBase.replace(/\/api\/v4$/, "");
  const selfHosted = new URL(apiBase).hostname !== "gitlab.com";
  const users = new Map<number, GitLabUser>([[me.id, me]]);
  users.set(78, { id: 78, username: "anna.b", name: "Anna Bianchi", avatar_url: selfHosted ? "/uploads/-/system/user/avatar/78/avatar.png" : "https://secure.gravatar.com/avatar/78" });
  const projects = new Map<number, SimProject>();
  const issues: SimIssue[] = [];
  const timelogs: SimTimelog[] = [];
  let seq = 5000;
  // Strictly increasing and never behind the real clock, so "changed since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  // What existed before the test began is dated hours ago, one second apart.
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  const iso = (ms: number) => new Date(ms).toISOString();
  const state = { exhausted: false, calls: 0, revoked: false };

  const project = (path: string, o: { access?: boolean } = {}) => {
    const known = [...projects.values()].find((p) => p.path === path);
    if (known) {
      if (o.access !== undefined) known.access = o.access;
      return known;
    }
    const p: SimProject = { id: ++seq, path, access: o.access ?? true, deletedLabels: new Set() };
    projects.set(p.id, p);
    return p;
  };
  const projectOf = (id: string) => {
    const key = decodeURIComponent(id);
    const p = /^\d+$/.test(key) ? projects.get(Number(key)) : [...projects.values()].find((q) => q.path.toLowerCase() === key.toLowerCase());
    return p?.access ? p : undefined;
  };

  const add = (
    path: string,
    title: string,
    o: { assignee?: number | null; labels?: string[]; description?: string; due?: string; type?: string; confidential?: boolean; author?: number } = {},
  ): SimIssue => {
    const p = project(path);
    const at = earlier();
    const i: SimIssue = {
      id: ++seq,
      iid: issues.filter((x) => x.projectId === p.id).length + 1,
      projectId: p.id,
      title,
      description: o.description ?? null,
      state: "opened",
      labels: o.labels ?? [],
      assignees: o.assignee === null ? [] : [o.assignee ?? me.id],
      author: o.author ?? me.id,
      due: o.due ?? null,
      created: at,
      updated: at,
      closed: null,
      movedTo: null,
      type: o.type ?? "issue",
      confidential: o.confidential ?? false,
      subscribed: new Set(),
      notes: [],
      events: [],
    };
    issues.push(i);
    return i;
  };
  const pathOf = (i: SimIssue) => projects.get(i.projectId)?.path ?? "";
  const keyOf = (i: SimIssue) => `${pathOf(i)}#${i.iid}`;
  const visible = (i: SimIssue) => !!projects.get(i.projectId)?.access;

  // ---------- Changes, whoever makes them ----------

  const system = (i: SimIssue, body: string, by = me.id) => i.notes.push({ id: ++seq, body, author: by, created: now(), system: true });
  const setState = (i: SimIssue, next: "opened" | "closed", by = me.id) => {
    if (i.state === next) return;
    i.state = next;
    i.closed = next === "closed" ? now() : null;
    i.events.push({ id: ++seq, user: by, created: now(), kind: "state", state: next === "closed" ? "closed" : "reopened" });
    system(i, next === "closed" ? "closed" : "reopened", by);
    i.updated = now();
  };
  const scopeOf = (l: string) => (l.includes("::") ? l.slice(0, l.lastIndexOf("::")).toLowerCase() : null);
  const addLabel = (i: SimIssue, label: string, by = me.id) => {
    if (i.labels.includes(label)) return;
    // A scoped label replaces the one of its scope.
    const scope = scopeOf(label);
    if (scope) for (const other of i.labels.filter((l) => scopeOf(l) === scope)) removeLabel(i, other, by);
    i.labels.push(label);
    i.events.push({ id: ++seq, user: by, created: now(), kind: "label", label, labelId: 9000 + label.length, action: "add" });
    system(i, `added ~${label} label`, by);
    i.updated = now();
  };
  const removeLabel = (i: SimIssue, label: string, by = me.id) => {
    if (!i.labels.includes(label)) return;
    i.labels = i.labels.filter((l) => l !== label);
    i.events.push({ id: ++seq, user: by, created: now(), kind: "label", label, labelId: 9000 + label.length, action: "remove" });
    system(i, `removed ~${label} label`, by);
    i.updated = now();
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    assign(i: SimIssue, user: number | null) {
      i.assignees = user === null ? [] : [user];
      system(i, user === null ? "removed all assignees" : `assigned to @${users.get(user)?.username}`);
      i.updated = now();
    },
    close: (i: SimIssue) => setState(i, "closed", 78),
    reopen: (i: SimIssue) => setState(i, "opened", 78),
    label: (i: SimIssue, label: string) => addLabel(i, label, 78),
    unlabel: (i: SimIssue, label: string) => removeLabel(i, label, 78),
    retitle(i: SimIssue, title: string) {
      i.title = title;
      i.updated = now();
    },
    comment(i: SimIssue, body: string, by = 78) {
      i.notes.push({ id: ++seq, body, author: by, created: now(), system: false });
      i.updated = now();
    },
    /** A move: a new issue (new id, new iid) in the target project; the old one stays, closed, pointing at it. */
    move(i: SimIssue, toPath: string): SimIssue {
      const to = add(toPath, i.title, { description: i.description ?? undefined, labels: [...i.labels], type: i.type });
      to.created = to.updated = now();
      to.assignees = [...i.assignees];
      to.author = i.author;
      i.movedTo = to.id;
      setState(i, "closed", 78);
      i.updated = now();
      return to;
    },
    /** A rename: the project keeps its id, its old path is a 404 from now on (and may be taken by another project). */
    renameProject(path: string, to: string) {
      const p = project(path);
      p.path = to;
      for (const i of issues.filter((x) => x.projectId === p.id)) i.updated = now();
    },
    /** A label deleted from a project: its events keep going, with label: null. */
    deleteLabel(path: string, name: string) {
      project(path).deletedLabels.add(name);
    },
    /** The user loses (or regains) access to a project: 404 for it and everything in it. */
    access(path: string, on: boolean) {
      project(path, { access: on });
    },
  };

  const timelog = (i: SimIssue, o: { seconds: number; at: number; user?: number; summary?: string }) => {
    const t: SimTimelog = { id: ++seq, issueId: i.id, user: o.user ?? me.id, at: o.at, seconds: o.seconds, summary: o.summary ?? "" };
    timelogs.push(t);
    i.updated = now();
    return t;
  };

  // ---------- Shapes ----------

  const user = (id: number): GitLabUser => users.get(id) ?? { id, username: `user${id}`, name: `User ${id}` };
  const note = (n: SimNote): GitLabNote => ({ id: n.id, body: n.body, author: user(n.author), created_at: iso(n.created), updated_at: iso(n.created), system: n.system });
  const shown = (i: SimIssue): GitLabIssue => {
    const path = pathOf(i);
    return {
      id: i.id,
      iid: i.iid,
      project_id: i.projectId,
      title: i.title,
      description: i.description,
      state: i.state,
      created_at: iso(i.created),
      updated_at: iso(i.updated),
      closed_at: i.closed === null ? null : iso(i.closed),
      labels: [...i.labels],
      assignees: i.assignees.map(user),
      author: user(i.author),
      due_date: i.due,
      web_url: `${web}/${path}/-/issues/${i.iid}`,
      references: { short: `#${i.iid}`, relative: `${path.slice(path.lastIndexOf("/") + 1)}#${i.iid}`, full: `${path}#${i.iid}` },
      moved_to_id: i.movedTo,
      issue_type: i.type,
      time_stats: { time_estimate: 0, total_time_spent: timelogs.filter((t) => t.issueId === i.id).reduce((a, t) => a + t.seconds, 0) },
      confidential: i.confidential,
    };
  };

  // ---------- HTTP ----------

  const rateHeaders = (): Record<string, string> => ({
    "RateLimit-Limit": "2000",
    "RateLimit-Observed": String(state.calls),
    "RateLimit-Remaining": String(Math.max(0, 2000 - state.calls)),
    "RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 60),
  });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 || status === 304 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...rateHeaders(), ...headers } });

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
    state.calls++;

    if (headers.get("private-token") !== token || state.revoked) return json({ message: "401 Unauthorized" }, 401);
    if (state.exhausted) return new Response("Retry later\n", { status: 429, headers: { "Content-Type": "text/plain", "Retry-After": "30", ...rateHeaders(), "RateLimit-Remaining": "0" } });

    const paged = <T>(list: T[], serialize: (t: T) => unknown = (t) => t) => {
      const per = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? 20)));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const at = (p: number) => {
        const u = new URL(url);
        u.searchParams.set("page", String(p));
        return u.toString();
      };
      const last = Math.max(1, Math.ceil(list.length / per));
      const links = [`<${at(1)}>; rel="first"`, `<${at(last)}>; rel="last"`, ...(page < last ? [`<${at(page + 1)}>; rel="next"`] : []), ...(page > 1 ? [`<${at(page - 1)}>; rel="prev"`] : [])];
      return json(list.slice((page - 1) * per, page * per).map(serialize), 200, {
        Link: links.join(", "),
        "X-Page": String(page),
        "X-Per-Page": String(per),
        "X-Next-Page": page < last ? String(page + 1) : "",
        "X-Total": String(list.length),
        "X-Total-Pages": String(last),
      });
    };

    // ----- GraphQL -----
    if (url.pathname === `${apiPath.replace(/\/v4$/, "")}/graphql`) return graphql(body);

    const path = url.pathname.slice(apiPath.length);
    if (path === "/user") return json(me);

    if (path === "/issues") {
      const scope = url.searchParams.get("scope") ?? "created_by_me";
      const wanted = url.searchParams.get("state") ?? "all";
      if (!["opened", "closed", "all"].includes(wanted)) return json({ error: "state does not have a valid value" }, 400);
      if (!["assigned_to_me", "created_by_me", "all"].includes(scope)) return json({ error: "scope does not have a valid value" }, 400);
      const after = url.searchParams.get("updated_after");
      const text = (url.searchParams.get("search") ?? "").toLowerCase();
      const dir = url.searchParams.get("sort") === "desc" ? -1 : 1;
      const field = url.searchParams.get("order_by") === "created_at" ? "created" : "updated";
      const list = issues
        .filter((i) => visible(i))
        .filter((i) => (scope === "assigned_to_me" ? i.assignees.includes(me.id) : scope === "created_by_me" ? i.author === me.id : true))
        .filter((i) => wanted === "all" || i.state === wanted)
        .filter((i) => !after || i.updated >= Date.parse(after))
        .filter((i) => !text || i.title.toLowerCase().includes(text) || (i.description ?? "").toLowerCase().includes(text))
        .sort((a, b) => dir * (a[field] - b[field] || a.id - b.id));
      return paged(list, shown);
    }

    const m = /^\/projects\/([^/]+)\/issues\/(\d+)(?:\/(.+))?$/.exec(path);
    if (!m) return json({ message: `unmocked ${method} ${path}` }, 404);
    const p = projectOf(m[1]);
    const i = p ? issues.find((x) => x.projectId === p.id && x.iid === Number(m[2])) : undefined;
    // No access and no such thing look the same.
    if (!p || !i) return json({ message: p ? "404 Not found" : "404 Project Not Found" }, 404);
    const sub = m[3];

    if (!sub) {
      if (method === "PUT") {
        const event = body.state_event;
        if (event !== undefined && event !== "close" && event !== "reopen") return json({ error: "state_event does not have a valid value" }, 400);
        if (typeof body.title === "string") i.title = body.title;
        if (typeof body.description === "string") i.description = body.description;
        if (event) setState(i, event === "close" ? "closed" : "opened");
        const names = (v: unknown) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
        for (const l of names(body.remove_labels)) removeLabel(i, l);
        for (const l of names(body.add_labels)) addLabel(i, l);
        i.updated = now();
      }
      return json(shown(i));
    }
    if (sub === "notes") {
      if (method === "POST") {
        const text = typeof body.body === "string" ? body.body : "";
        if (!text) return json({ error: "body is missing" }, 400);
        // Quick actions run, and are not part of the note.
        const kept: string[] = [];
        let ran = 0;
        let fenced = false;
        for (const line of text.split("\n")) {
          if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
          const c = fenced ? null : /^\/(\w+)/.exec(line);
          if (!c) kept.push(line);
          else {
            ran++;
            if (c[1] === "close") setState(i, "closed");
            if (c[1] === "reopen") setState(i, "opened");
          }
        }
        const rest = kept.join("\n").trim();
        if (!rest) return json({ commands_changes: { commands: ran }, summary: ["Commands applied"] }, 202);
        const n: SimNote = { id: ++seq, body: rest, author: me.id, created: now(), system: false };
        i.notes.push(n);
        i.updated = now();
        return json(note(n), 201);
      }
      const dir = url.searchParams.get("sort") === "desc" ? -1 : 1;
      return paged([...i.notes].sort((a, b) => dir * (a.created - b.created || a.id - b.id)), note);
    }
    if (sub === "subscribe" || sub === "unsubscribe") {
      const on = sub === "subscribe";
      if (i.subscribed.has(me.id) === on) return json(null, 304);
      if (on) i.subscribed.add(me.id);
      else i.subscribed.delete(me.id);
      return json(shown(i), on ? 201 : 200);
    }
    if (sub === "resource_label_events") {
      return paged(
        i.events.filter((e): e is Extract<SimEvent, { kind: "label" }> => e.kind === "label"),
        (e): GitLabLabelEvent => ({ id: e.id, user: user(e.user), created_at: iso(e.created), label: p.deletedLabels.has(e.label) ? null : { id: e.labelId, name: e.label }, action: e.action }),
      );
    }
    if (sub === "resource_state_events") {
      return paged(
        i.events.filter((e): e is Extract<SimEvent, { kind: "state" }> => e.kind === "state"),
        (e): GitLabStateEvent => ({ id: e.id, user: user(e.user), created_at: iso(e.created), state: e.state }),
      );
    }
    if (sub === "resource_milestone_events") return paged<GitLabMilestoneEvent>([]);
    return json({ message: `unmocked ${method} ${path}` }, 404);
  }

  // ---------- GraphQL ----------

  const gidNumber = (gid: unknown) => Number(/(\d+)$/.exec(String(gid))?.[1]);
  const node = (t: SimTimelog) => {
    const i = issues.find((x) => x.id === t.issueId)!;
    return {
      id: gidOf("Timelog", t.id),
      // GraphQL prints times with an offset, not Z.
      spentAt: iso(t.at).replace(/\.\d{3}Z$/, "+00:00"),
      timeSpent: t.seconds,
      summary: t.summary || null,
      user: { id: gidOf("User", t.user), username: user(t.user).username },
      issue: { id: gidOf("Issue", i.id), iid: String(i.iid), webUrl: `${web}/${pathOf(i)}/-/issues/${i.iid}`, project: { id: gidOf("Project", i.projectId), fullPath: pathOf(i) } },
    };
  };
  /** A cursor is the offset after the last row read. */
  const connection = (rows: SimTimelog[], first: number, after: unknown) => {
    const from = typeof after === "string" ? Number(Buffer.from(after, "base64").toString()) : 0;
    const end = Math.min(rows.length, from + first);
    return { nodes: rows.slice(from, end).map(node), pageInfo: { hasNextPage: end < rows.length, endCursor: Buffer.from(String(end)).toString("base64") } };
  };
  /** startDate/endDate on a bare date are UTC days: the whole day for the end. */
  const bound = (v: unknown, end: boolean) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) + (end ? 86_400_000 - 1 : 0) : Date.parse(String(v)));

  function graphql(req: { operationName?: string; variables?: Record<string, unknown> }): Response {
    const v = req.variables ?? {};
    const out = (data: unknown) => json({ data });
    if (req.operationName === "IssueById" || req.operationName === "IssueTimelogs") {
      const i = issues.find((x) => x.id === gidNumber(v.id));
      const ok = i && visible(i) ? i : null;
      if (req.operationName === "IssueById") {
        return out({ issue: ok ? { id: gidOf("Issue", ok.id), iid: String(ok.iid), webUrl: shown(ok).web_url, project: { id: gidOf("Project", ok.projectId), fullPath: pathOf(ok) } } : null });
      }
      return out({ issue: ok ? { timelogs: connection(timelogs.filter((t) => t.issueId === ok.id).sort((a, b) => a.at - b.at || a.id - b.id), 100, v.after) } : null });
    }
    if (req.operationName === "UserTimelogs") {
      if (typeof v.username !== "string" || !v.startDate || !v.endDate) return json({ errors: [{ message: "Variable $startDate of type Time! was provided invalid value" }] });
      const from = bound(v.startDate, false);
      const to = bound(v.endDate, true);
      const who = [...users.values()].find((u) => u.username === v.username);
      const rows = timelogs
        .filter((t) => t.user === who?.id && t.at >= from && t.at <= to && visible(issues.find((x) => x.id === t.issueId)!))
        .sort((a, b) => a.at - b.at || a.id - b.id);
      return out({ timelogs: connection(rows, 100, v.after) });
    }
    return json({ errors: [{ message: `unknown operation ${req.operationName}` }] });
  }

  return {
    apiBase,
    token,
    me,
    users,
    projects,
    issues,
    timelogs,
    state,
    project,
    add,
    timelog,
    outside,
    keyOf,
    /** Every call from now on is refused as over the limit (429, Retry-After 30). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
