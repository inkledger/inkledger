// A YouTrack in memory, for tests: the REST endpoints the adapter calls,
// written from YouTrack's documentation (not from a real server: see
// docs/dev/spikes.md, YouTrack). Models its traps on purpose:
// - `fields` is mandatory: without it only ids come back, and a field not
//   named is absent (the projection is real, see `project`);
// - lists are cut by `$top` (default 42, never more than `limits.maxTop`), no
//   Link header and no total: `$skip` offsets, so an item changed during a
//   pass moves in the order and shifts the rest;
// - timestamps are epoch ms; work item dates are the day at 00:00 UTC;
//   durations are whole minutes; dates in a query are days in the requesting
//   user's zone (`userOffsetMinutes`);
// - ids are internal (`2-45`), keys (`PROJ-12`) are readable, change when an
//   issue moves, and the old key still answers; keys are case-insensitive;
// - an issue the user may not see is a 404, never a 403;
// - the State field's name is localized (found by type); a state machine
//   offers events, not values; the activities endpoint refuses a call
//   without `categories`;
// - deleted comments are still listed, flagged `deleted`; a token that is
//   wrong is 401, and a guest account may answer in its place;
// - avatar URLs are relative paths.
export type SimUser = { id: string; login: string; fullName: string; email?: string; avatarUrl?: string };
export type SimState = { name: string; isResolved: boolean };

type SimProject = {
  num: number;
  id: string;
  shortName: string;
  name: string;
  states: SimState[];
  machine: boolean;
  hidden: boolean;
  stateFieldName: string;
  workTypes: { id: string; name: string }[];
  seq: number;
};
type SimComment = { id: string; text: string; created: number; updated: number; deleted: boolean; author: string };
export type SimWorkItem = { id: string; issueId: string; date: number; minutes: number; text: string; author: string; created: number; updated: number; type: { id: string; name: string } | null };
type SimActivity = { id: string; timestamp: number; category: string; field: { id: string; name: string }; author: string; added: unknown[]; removed: unknown[] };
export type SimIssue = {
  id: string;
  project: SimProject;
  number: number;
  /** Keys it answered to before a move */
  oldKeys: string[];
  summary: string;
  description: string | null;
  created: number;
  updated: number;
  resolved: number | null;
  state: string;
  assignee: string | null;
  reporter: string;
  tags: string[];
  priority: string | null;
  type: string | null;
  estimateMinutes: number | null;
  /** Midnight UTC of the due day */
  due: number | null;
  comments: SimComment[];
  activities: SimActivity[];
  watchers: Set<string>;
};

type Tree = Map<string, Tree | null>;

/** `a,b(c,d)` as a tree. */
function parseFields(spec: string | null): Tree {
  let i = 0;
  const list = (): Tree => {
    const t: Tree = new Map();
    while (i < spec!.length && spec![i] !== ")") {
      let name = "";
      while (i < spec!.length && !",()".includes(spec![i])) name += spec![i++];
      let sub: Tree | null = null;
      if (spec![i] === "(") {
        i++;
        sub = list();
        i++;
      }
      const prior = t.get(name);
      if (prior && sub) for (const [k, v] of sub) prior.set(k, v);
      else t.set(name, sub ?? prior ?? null);
      if (spec![i] === ",") i++;
    }
    return t;
  };
  return spec ? list() : new Map<string, Tree | null>();
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What YouTrack sends for the fields asked: an entity with no sub-fields named gives only its id (and $type). */
function project(v: unknown, tree: Tree): unknown {
  if (Array.isArray(v)) return v.map((x) => project(x, tree));
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  if ("$type" in v) out.$type = v.$type;
  if (tree.size === 0) {
    if ("id" in v) out.id = v.id;
    return out;
  }
  for (const [k, sub] of tree) if (k in v) out[k] = project(v[k], sub ?? new Map<string, Tree | null>());
  return out;
}

const DAY = 86_400_000;
const DEFAULT_STATES: SimState[] = [
  { name: "Open", isResolved: false },
  { name: "In Progress", isResolved: false },
  { name: "Fixed", isResolved: true },
  { name: "Won't fix", isResolved: true },
];

export function youtrackSimulator(site = "https://acme.youtrack.cloud", me: SimUser = { id: "1-1", login: "mrossi", fullName: "Mario Rossi", email: "mario@example.com", avatarUrl: "/hub/api/rest/avatar/mrossi" }) {
  const web = site.replace(/\/+$/, "");
  const apiBase = `${web}/api`;
  const webPath = new URL(web).pathname.replace(/\/+$/, "");
  const token = "perm:sim";
  const tokens = new Set([token]);
  const users = new Map<string, SimUser>([[me.id, me]]);
  const projects = new Map<string, SimProject>();
  const issues: SimIssue[] = [];
  const workItems: SimWorkItem[] = [];
  const state = {
    clock: Date.now(),
    seq: 100,
    /** The page size YouTrack never exceeds, whatever `$top` asks */
    maxTop: 200,
    /** The requesting user's zone, minutes east of UTC: how query dates are read */
    userOffsetMinutes: 0,
    allowOnBehalf: true,
    guest: false,
    /** Requests seen, "METHOD path?query" */
    calls: [] as string[],
    onIssueList: null as (() => void) | null,
  };
  const injected: { status: number; headers?: Record<string, string>; body?: unknown }[] = [];
  const tick = () => (state.clock += 1000);
  const id = (prefix: string) => `${prefix}-${++state.seq}`;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json;charset=utf-8", ...headers } });
  const error = (status: number, description: string) => json({ error: status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request", error_description: description }, status);

  const key = (i: SimIssue) => `${i.project.shortName}-${i.number}`;
  const userRaw = (uid: string | null) => {
    const u = uid ? users.get(uid) : undefined;
    return u ? { $type: "User", id: u.id, login: u.login, name: u.fullName, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl ?? null, guest: false } : null;
  };
  const stateValue = (p: SimProject, name: string) => {
    const idx = p.states.findIndex((s) => s.name === name);
    const s = p.states[idx];
    return { $type: "StateBundleElement", id: `bv-${p.num}-${idx}`, name, isResolved: s?.isResolved ?? false, ordinal: idx };
  };
  const issueRaw = (i: SimIssue) => {
    const p = i.project;
    const bundle = { $type: "StateBundle", values: p.states.map((s) => stateValue(p, s.name)) };
    const stateCf = {
      $type: p.machine ? "StateMachineIssueCustomField" : "StateIssueCustomField",
      name: p.stateFieldName,
      value: stateValue(p, i.state),
      possibleEvents: p.machine ? p.states.filter((s) => s.name !== i.state).map((s) => ({ $type: "Event", id: `ev-${s.name}`, presentation: s.name })) : [],
      projectCustomField: { $type: "StateProjectCustomField", id: `pcf-${p.num}`, bundle },
    };
    return {
      $type: "Issue",
      id: i.id,
      idReadable: key(i),
      summary: i.summary,
      description: i.description,
      created: i.created,
      updated: i.updated,
      resolved: i.resolved,
      project: { $type: "Project", id: p.id, shortName: p.shortName, name: p.name },
      reporter: userRaw(i.reporter),
      tags: i.tags.map((name) => ({ $type: "Tag", id: `tag-${name}`, name })),
      customFields: [
        stateCf,
        { $type: "SingleUserIssueCustomField", name: "Assignee", value: userRaw(i.assignee) },
        { $type: "SingleEnumIssueCustomField", name: "Priority", value: i.priority ? { $type: "EnumBundleElement", id: `pr-${i.priority}`, name: i.priority, ordinal: 0 } : null },
        { $type: "SingleEnumIssueCustomField", name: "Type", value: i.type ? { $type: "EnumBundleElement", id: `ty-${i.type}`, name: i.type, ordinal: 0 } : null },
        { $type: "PeriodIssueCustomField", name: "Estimation", value: i.estimateMinutes === null ? null : { $type: "PeriodValue", minutes: i.estimateMinutes, presentation: `${i.estimateMinutes}m` } },
        { $type: "DateIssueCustomField", name: "Due Date", value: i.due },
      ],
    };
  };
  const workItemRaw = (w: SimWorkItem) => {
    const i = issues.find((x) => x.id === w.issueId)!;
    return {
      $type: "IssueWorkItem",
      id: w.id,
      date: w.date,
      duration: { $type: "DurationValue", minutes: w.minutes, presentation: `${w.minutes}m` },
      text: w.text,
      author: userRaw(w.author),
      creator: userRaw(w.author),
      created: w.created,
      updated: w.updated,
      type: w.type ? { $type: "WorkItemType", ...w.type } : null,
      issue: { $type: "Issue", id: i.id, idReadable: key(i) },
    };
  };
  const commentRaw = (c: SimComment) => ({ $type: "IssueComment", id: c.id, text: c.text, created: c.created, updated: c.updated, deleted: c.deleted, author: userRaw(c.author) });

  // ---------- Setup helpers ----------

  const addProject = (shortName: string, o: Partial<Pick<SimProject, "name" | "states" | "machine" | "hidden" | "stateFieldName" | "workTypes">> = {}) => {
    const num = projects.size;
    const p: SimProject = {
      num,
      id: `0-${num}`,
      shortName,
      name: o.name ?? `Project ${shortName}`,
      states: o.states ?? DEFAULT_STATES,
      machine: o.machine ?? false,
      hidden: o.hidden ?? false,
      stateFieldName: o.stateFieldName ?? "State",
      workTypes: o.workTypes ?? [
        { id: "wt-dev", name: "Development" },
        { id: "wt-test", name: "Testing" },
      ],
      seq: 0,
    };
    projects.set(shortName.toUpperCase(), p);
    return p;
  };
  const addUser = (u: SimUser) => void users.set(u.id, u);

  const add = (
    projectKey: string,
    summary: string,
    o: { assignee?: string | null; state?: string; description?: string; updated?: number; priority?: string; type?: string; estimateMinutes?: number; due?: string; tags?: string[] } = {},
  ) => {
    const p = projects.get(projectKey.toUpperCase()) ?? addProject(projectKey);
    const at = tick();
    const st = o.state ?? p.states[0].name;
    const i: SimIssue = {
      id: `${p.num + 2}-${++p.seq + 40}`,
      project: p,
      number: p.seq,
      oldKeys: [],
      summary,
      description: o.description ?? null,
      created: at,
      updated: o.updated ?? at,
      resolved: p.states.find((s) => s.name === st)?.isResolved ? at : null,
      state: st,
      assignee: o.assignee === undefined ? me.id : o.assignee,
      reporter: me.id,
      tags: o.tags ?? [],
      priority: o.priority ?? null,
      type: o.type ?? null,
      estimateMinutes: o.estimateMinutes ?? null,
      due: o.due ? Date.parse(`${o.due}T00:00:00Z`) : null,
      comments: [],
      activities: [],
      watchers: new Set(),
    };
    issues.push(i);
    return Object.assign(i, { key: key(i) });
  };
  const byKey = (k: string) => {
    const up = k.toUpperCase();
    return issues.find((i) => key(i).toUpperCase() === up || i.oldKeys.some((o) => o.toUpperCase() === up));
  };
  const need = (k: string) => {
    const i = byKey(k);
    if (!i) throw new Error(`no issue ${k}`);
    return i;
  };

  /** Changes made "outside" (in YouTrack's own UI or by someone else). */
  const outside = {
    touch: (k: string) => void (need(k).updated = tick()),
    setState: (k: string, name: string) => setState(need(k), name, "2-2"),
    unassign: (k: string) => {
      const i = need(k);
      i.assignee = null;
      i.updated = tick();
    },
    /** The issue moves to another project: same id, new key; the old key still answers */
    move: (k: string, to: string) => {
      const i = need(k);
      const p = projects.get(to.toUpperCase()) ?? addProject(to);
      i.oldKeys.push(key(i));
      i.project = p;
      i.number = ++p.seq;
      i.updated = tick();
    },
    remove: (k: string) => void issues.splice(issues.indexOf(need(k)), 1),
    comment: (k: string, text: string, o: { deleted?: boolean } = {}) => {
      const i = need(k);
      const at = tick();
      i.comments.push({ id: id("4"), text, created: at, updated: at, deleted: o.deleted ?? false, author: me.id });
      i.updated = at;
    },
    workItem: (k: string, o: { date: string; minutes: number; text?: string; author?: string }) => {
      const i = need(k);
      const at = tick();
      const w: SimWorkItem = { id: id("5"), issueId: i.id, date: Date.parse(`${o.date}T00:00:00Z`), minutes: o.minutes, text: o.text ?? "", author: o.author ?? me.id, created: at, updated: at, type: null };
      workItems.push(w);
      return w;
    },
    editWorkItem: (wid: string, minutes: number) => {
      const w = workItems.find((x) => x.id === wid)!;
      w.minutes = minutes;
      w.updated = tick();
    },
    removeWorkItem: (wid: string) => void workItems.splice(workItems.findIndex((w) => w.id === wid), 1),
  };

  function setState(i: SimIssue, name: string, by: string) {
    const s = i.project.states.find((x) => x.name === name);
    if (!s) return false;
    const at = tick();
    i.activities.push({
      id: id("6"),
      timestamp: at,
      category: "CustomFieldCategory",
      field: { id: `pcf-${i.project.num}`, name: i.project.stateFieldName },
      author: by,
      added: [{ $type: "StateBundleElement", name }],
      removed: [{ $type: "StateBundleElement", name: i.state }],
    });
    i.state = name;
    i.resolved = s.isResolved ? at : null;
    i.updated = at;
    return true;
  }

  // ---------- Query language (the part the adapter writes) ----------

  type Parsed = { terms: ((i: SimIssue) => boolean)[]; sort: "asc" | "desc" | null };
  function parseQuery(q: string): Parsed | string {
    if ((q.match(/\{/g) ?? []).length !== (q.match(/\}/g) ?? []).length) return "Invalid query: unbalanced braces";
    if ((q.match(/"/g) ?? []).length % 2 !== 0) return "Invalid query: unclosed quote";
    const terms: Parsed["terms"] = [];
    let rest = q;
    let sort: Parsed["sort"] = null;
    const take = (re: RegExp, f: (m: RegExpExecArray) => void) => {
      const m = re.exec(rest);
      if (m) {
        f(m);
        rest = rest.replace(re, " ");
      }
    };
    take(/sort by:\s*updated\s+(asc|desc)/i, (m) => (sort = m[1].toLowerCase() as "asc" | "desc"));
    take(/for:\s*me\b/i, () => terms.push((i) => i.assignee === me.id));
    take(/project:\s*(\S+)/i, (m) => terms.push((i) => i.project.shortName.toUpperCase() === m[1].toUpperCase()));
    take(/#Unresolved\b/i, () => terms.push((i) => i.resolved === null));
    take(/issue id:\s*(\S+)/i, (m) => terms.push((i) => byKey(m[1])?.id === i.id));
    // A day in the requesting user's zone, from midnight: the trap.
    take(/updated:\s*(\d{4}-\d{2}-\d{2})\s*\.\.\s*\*/i, (m) => {
      const from = Date.parse(`${m[1]}T00:00:00Z`) - state.userOffsetMinutes * 60_000;
      terms.push((i) => i.updated >= from);
    });
    for (const m of rest.matchAll(/\{([^}]*)\}|(\S+)/g)) {
      const text = (m[1] ?? m[2]).toLowerCase().trim();
      if (text) terms.push((i) => `${i.summary} ${i.description ?? ""} ${i.comments.map((c) => c.text).join(" ")}`.toLowerCase().includes(text));
    }
    return { terms, sort };
  }

  const pageOf = <T>(list: T[], url: URL) => {
    const top = Math.min(Number(url.searchParams.get("$top") ?? 42), state.maxTop);
    const skip = Number(url.searchParams.get("$skip") ?? 0);
    return list.slice(skip, skip + top);
  };
  const reply = (body: unknown, url: URL, status = 200) => json(project(body, parseFields(url.searchParams.get("fields"))), status);
  const visible = (i: SimIssue) => !i.project.hidden;

  const findIssue = (ref: string) => {
    const r = decodeURIComponent(ref);
    return issues.find((i) => i.id === r) ?? byKey(r);
  };

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    state.calls.push(`${method} ${url.pathname.slice(webPath.length)}${url.search ? "?" + decodeURIComponent(url.search.slice(1)) : ""}`);
    if (url.origin !== new URL(web).origin) return error(404, "unknown site");
    const fault = injected.shift();
    if (fault) return json(fault.body ?? { error: "Injected", error_description: `injected ${fault.status}` }, fault.status, fault.headers);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const bearer = /^Bearer (.+)$/.exec(auth)?.[1] ?? "";
    const path = url.pathname.slice(`${webPath}/api`.length);
    if (!tokens.has(bearer)) {
      // A wrong token is 401; a server with guest access may answer as the guest.
      if (state.guest && path === "/users/me") return reply({ $type: "User", id: "0-0", login: "guest", guest: true }, url);
      return json({ error: "invalid_token", error_description: "Invalid token" }, 401);
    }
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    let m: RegExpExecArray | null;

    if (path === "/users/me") return reply(userRaw(me.id), url);
    if (path === "/issues" && method === "GET") {
      state.onIssueList?.();
      const parsed = parseQuery(url.searchParams.get("query") ?? "");
      if (typeof parsed === "string") return error(400, parsed);
      const found = issues.filter((i) => visible(i) && parsed.terms.every((t) => t(i)));
      if (parsed.sort) found.sort((a, b) => (parsed.sort === "asc" ? 1 : -1) * (a.updated - b.updated || a.id.localeCompare(b.id)));
      return reply(pageOf(found, url).map(issueRaw), url);
    }
    if ((m = /^\/issues\/([^/]+)$/.exec(path))) {
      const i = findIssue(m[1]);
      if (!i || !visible(i)) return error(404, `Entity with id ${decodeURIComponent(m[1])} not found`);
      if (method === "POST") {
        const cf = (body.customFields as { name?: string; $type?: string; value?: { name?: string }; event?: { id?: string } }[] | undefined)?.[0];
        if (cf) {
          const target = cf.event ? i.project.states.find((s) => `ev-${s.name}` === cf.event?.id)?.name : cf.value?.name;
          if (cf.name !== i.project.stateFieldName) return error(400, `Unknown field ${cf.name}`);
          if (i.project.machine && !cf.event) return error(400, "The State field changes by events");
          if (!target || !setState(i, target, me.id)) return error(400, `Unknown value ${cf.value?.name ?? cf.event?.id} for State`);
        }
        const w = body.watchers as { hasStar?: boolean } | undefined;
        if (w) {
          if (w.hasStar) i.watchers.add(me.id);
          else i.watchers.delete(me.id);
        }
      }
      return reply(issueRaw(i), url);
    }
    if ((m = /^\/issues\/([^/]+)\/comments$/.exec(path))) {
      const i = findIssue(m[1]);
      if (!i || !visible(i)) return error(404, `Entity with id ${decodeURIComponent(m[1])} not found`);
      if (method === "POST") {
        const at = tick();
        const c: SimComment = { id: id("4"), text: typeof body.text === "string" ? body.text : "", created: at, updated: at, deleted: false, author: me.id };
        i.comments.push(c);
        i.updated = at;
        return reply(commentRaw(c), url, 200);
      }
      return reply(pageOf(i.comments, url).map(commentRaw), url);
    }
    if ((m = /^\/issues\/([^/]+)\/activities$/.exec(path))) {
      const i = findIssue(m[1]);
      if (!i || !visible(i)) return error(404, `Entity with id ${decodeURIComponent(m[1])} not found`);
      if (!url.searchParams.get("categories")) return error(400, "Required query parameter categories is missing");
      const wanted = new Set(url.searchParams.get("categories")!.split(","));
      const list = i.activities.filter((a) => wanted.has(a.category));
      return reply(
        pageOf(list, url).map((a) => ({ $type: "CustomFieldActivityItem", id: a.id, timestamp: a.timestamp, category: { $type: "ActivityCategory", id: a.category }, field: { $type: "PresentableField", ...a.field }, author: userRaw(a.author), added: a.added, removed: a.removed })),
        url,
      );
    }
    if ((m = /^\/issues\/([^/]+)\/timeTracking\/workItems$/.exec(path))) {
      const i = findIssue(m[1]);
      if (!i || !visible(i)) return error(404, `Entity with id ${decodeURIComponent(m[1])} not found`);
      if (method === "GET") return reply(pageOf(workItems.filter((w) => w.issueId === i.id), url).map(workItemRaw), url);
      const made = writeWorkItem(i, undefined, body);
      return typeof made === "string" ? made === "forbidden" ? error(403, "Not allowed to add work items for other users") : error(400, made) : reply(workItemRaw(made), url, 200);
    }
    if ((m = /^\/issues\/([^/]+)\/timeTracking\/workItems\/([^/]+)$/.exec(path))) {
      const i = findIssue(m[1]);
      const w = workItems.find((x) => x.id === decodeURIComponent(m![2]) && x.issueId === i?.id);
      if (!i || !visible(i) || !w) return error(404, `Entity with id ${decodeURIComponent(m[2])} not found`);
      if (method === "DELETE") {
        workItems.splice(workItems.indexOf(w), 1);
        return json(undefined, 204);
      }
      const made = writeWorkItem(i, w, body);
      return typeof made === "string" ? error(400, made) : reply(workItemRaw(made), url);
    }
    if (path === "/workItems") {
      // A change filter across issues: by author and `updatedStart` (ms).
      const author = url.searchParams.get("author");
      const since = Number(url.searchParams.get("updatedStart") ?? 0);
      const list = workItems
        .filter((w) => visible(issues.find((i) => i.id === w.issueId)!) && (!author || w.author === author) && w.updated >= since)
        .sort((a, b) => a.updated - b.updated || a.id.localeCompare(b.id));
      return reply(pageOf(list, url).map(workItemRaw), url);
    }
    if (path === "/admin/projects") return reply(pageOf([...projects.values()].filter((p) => !p.hidden), url).map((p) => ({ $type: "Project", id: p.id, shortName: p.shortName, name: p.name })), url);
    if ((m = /^\/admin\/projects\/([^/]+)\/customFields$/.exec(path))) {
      const p = [...projects.values()].find((x) => x.id === m![1]);
      if (!p || p.hidden) return error(404, `Entity with id ${m[1]} not found`);
      const bundle = { $type: "StateBundle", values: p.states.map((s) => stateValue(p, s.name)) };
      return reply([{ $type: p.machine ? "StateMachineProjectCustomField" : "StateProjectCustomField", id: `pcf-${p.num}`, bundle }], url);
    }
    if ((m = /^\/admin\/projects\/([^/]+)\/timeTrackingSettings$/.exec(path))) {
      const p = [...projects.values()].find((x) => x.id === m![1]);
      if (!p || p.hidden) return error(404, `Entity with id ${m[1]} not found`);
      return reply({ $type: "ProjectTimeTrackingSettings", workItemTypes: p.workTypes.map((t) => ({ $type: "WorkItemType", ...t })) }, url);
    }
    if (path === "/admin/timeTrackingSettings/workItemTypes") {
      const all = [...projects.values()].flatMap((p) => p.workTypes);
      return reply(pageOf([...new Map(all.map((t) => [t.id, t])).values()].map((t) => ({ $type: "WorkItemType", ...t })), url), url);
    }
    return error(404, `simulator: ${method} ${path} not handled`);
  }

  /** Creates or changes a work item: the date is kept as the day at 00:00 UTC, the duration in whole minutes. */
  function writeWorkItem(i: SimIssue, existing: SimWorkItem | undefined, body: Record<string, unknown>): SimWorkItem | string {
    const minutes = (body.duration as { minutes?: unknown } | undefined)?.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1) return "Duration must be a whole number of minutes";
    if (typeof body.date !== "number") return "date is required";
    const author = (body.author as { id?: string } | undefined)?.id ?? existing?.author ?? me.id;
    if (author !== me.id && !state.allowOnBehalf) return "forbidden";
    if (!users.has(author)) return `Unknown user ${author}`;
    const typeId = (body.type as { id?: string } | undefined)?.id;
    const type = typeId ? (i.project.workTypes.find((t) => t.id === typeId) ?? null) : (existing?.type ?? null);
    if (typeId && !type) return `Unknown work item type ${typeId}`;
    const at = tick();
    const w: SimWorkItem = existing ?? { id: id("5"), issueId: i.id, date: 0, minutes: 0, text: "", author, created: at, updated: at, type: null };
    Object.assign(w, { date: Math.floor(body.date / DAY) * DAY, minutes, text: typeof body.text === "string" ? body.text : "", author, updated: at, type });
    if (!existing) workItems.push(w);
    i.updated = at;
    return w;
  }

  const failNext = (status: number, headers?: Record<string, string>, errBody?: unknown) => void injected.push({ status, headers, body: errBody });

  return {
    apiBase,
    web,
    me,
    token,
    tokens,
    state,
    issues,
    workItems,
    projects,
    fetch: handle,
    project: addProject,
    user: addUser,
    add,
    outside,
    failNext,
    byKey,
  };
}
