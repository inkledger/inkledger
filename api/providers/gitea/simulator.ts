// A Gitea in memory, for tests: the REST endpoints the adapter calls, with
// Gitea's documented shapes and its traps. Written from the official API
// documentation (swagger of Gitea 1.22 / Forgejo 7), never run against a real
// server (docs/dev/spikes.md lists what to check):
// - ids and indexes: an issue has a global `id` and a per-repository `number`
//   (the one paths use); renamed repositories redirect;
// - pages: `limit` is cut to the server's ceiling (50), Link headers are built
//   from ROOT_URL (wrong behind a badly set proxy), X-Total-Count;
// - assignees come as null, not [], when nobody is assigned; pull requests are
//   issues too (type=issues leaves them out); a deleted user is "Ghost";
// - `since` must be RFC 3339 (a raw "+02:00" in a query string is a space);
//   timestamps carry the server's own UTC offset, not "Z";
// - an edit answers 201; subscribing answers 200 or 201; deleting a time entry
//   already gone is a 404;
// - tracked time: seconds, no note, no update; a repository can switch it off
//   (400 "time tracking disabled"); without permission an empty 403;
// - tokens have scopes (403 naming the missing one); bad token: 401;
//   archived repositories refuse writes (403); a repository the user can't see
//   is a 404.
import type { GiteaComment, GiteaIssue, GiteaTimelineEntry, GiteaTrackedTime, GiteaUser } from "./client";

type SimRepo = { id: number; owner: string; name: string; archived: boolean; timeTracking: boolean; canWrite: boolean; access: boolean };
type SimComment = { id: number; userId: number; body: string; created: number; updated: number };
type SimTimeline = { id: number; type: string; at: number; userId: number; extra: Partial<GiteaTimelineEntry> };
type SimIssue = {
  id: number;
  repoId: number;
  number: number;
  pr: boolean;
  title: string;
  body: string | null;
  state: "open" | "closed";
  userId: number;
  assignees: number[];
  labels: string[];
  created: number;
  updated: number;
  closed: number | null;
  comments: SimComment[];
  timeline: SimTimeline[];
  subscribers: Set<number>;
};
type SimTime = { id: number; issueId: number; userId: number; created: number; time: number };
type Failure = { status: number; headers: Record<string, string>; body: unknown };

const ALL_SCOPES = ["read:user", "read:issue", "write:issue", "read:repository"];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const GHOST: GiteaUser = { id: -1, login: "Ghost", full_name: "" };

export type GiteaSimOptions = {
  /** The server's own UTC offset, minutes: its timestamps are written with it ("+02:00") */
  utcOffsetMinutes?: number;
  /** The most items a page holds, whatever `limit` asks (Gitea's MAX_RESPONSE_ITEMS) */
  maxLimit?: number;
  /** The server's ROOT_URL, from which Link headers are built (wrong behind a proxy not told its public address) */
  rootUrl?: string;
};

export function giteaSimulator(
  apiBase = "https://git.example.com/api/v1",
  me: GiteaUser = { id: 7, login: "mrossi", full_name: "Mario Rossi", email: "mario@example.com" },
  options: GiteaSimOptions = {},
) {
  const offset = options.utcOffsetMinutes ?? 120;
  const sim = { maxLimit: options.maxLimit ?? 50, rootUrl: options.rootUrl ?? null as string | null };
  const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
  const web = apiBase.replace(/\/api\/v1\/?$/, "");
  const users = new Map<number, GiteaUser>([[me.id, me]]);
  const deletedUsers = new Set<number>();
  const tokens = new Map<string, { userId: number; scopes: Set<string> }>([["gt_test", { userId: me.id, scopes: new Set(ALL_SCOPES) }]]);
  const repos = new Map<string, SimRepo>();
  const redirects = new Map<string, string>();
  const issues: SimIssue[] = [];
  const times: SimTime[] = [];
  const requests: { method: string; origin: string; path: string; search: string; headers: Record<string, string> }[] = [];
  const failures: Failure[] = [];
  let seq = 1000;
  let last = 0;
  /** A strictly increasing moment: the real (or faked) clock, so a test moves time with it. */
  const stamp = () => (last = Math.max(Date.now(), last + 1));

  /** An instant as the server writes it: its own UTC offset, to the second. */
  const iso = (ms: number) => {
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${new Date(ms + offset * 60_000).toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const problem = (status: number, message: string) => json({ message, url: "https://docs.gitea.com/api/1.22/" }, status);

  const userOf = (id: number): GiteaUser => (deletedUsers.has(id) ? GHOST : (users.get(id) ?? GHOST));
  const repoKey = (full: string) => full.toLowerCase();
  const addRepo = (full: string, o: Partial<Pick<SimRepo, "archived" | "timeTracking" | "canWrite" | "access">> = {}) => {
    const [owner, name] = full.split("/");
    const known = repos.get(repoKey(full));
    const repo: SimRepo = known ?? { id: repos.size + 1, owner, name, archived: false, timeTracking: true, canWrite: true, access: true };
    Object.assign(repo, o);
    repos.set(repoKey(full), repo);
    return repo;
  };
  const fullOf = (r: SimRepo) => `${r.owner}/${r.name}`;
  const repoById = (id: number) => [...repos.values()].find((r) => r.id === id) as SimRepo;

  const add = (full: string, title: string, o: { assignee?: number | null; pr?: boolean; body?: string; state?: "open" | "closed"; author?: number } = {}) => {
    const repo = repos.get(repoKey(full)) ?? addRepo(full);
    const number = issues.filter((i) => i.repoId === repo.id).length + 1;
    const at = stamp();
    const assignee = o.assignee === undefined ? me.id : o.assignee;
    const issue: SimIssue = {
      id: ++seq,
      repoId: repo.id,
      number,
      pr: o.pr ?? false,
      title,
      body: o.body ?? null,
      state: o.state ?? "open",
      userId: o.author ?? me.id,
      assignees: assignee === null ? [] : [assignee],
      labels: [],
      created: at,
      updated: at,
      closed: o.state === "closed" ? at : null,
      comments: [],
      timeline: [],
      subscribers: new Set(),
    };
    issues.push(issue);
    return issue;
  };
  const event = (i: SimIssue, type: string, userId: number, extra: SimTimeline["extra"] = {}) => {
    const at = stamp();
    i.timeline.push({ id: ++seq, type, at, userId, extra });
    i.updated = at;
  };

  const labelJson = (name: string) => ({ id: name.length, name, color: "00aabb", exclusive: name.includes("/") });
  /** An issue as Gitea sends it (the simulator's own bookkeeping left out). */
  const shown = (i: SimIssue): GiteaIssue => {
    const repo = repoById(i.repoId);
    const full = fullOf(repo);
    const people = i.assignees.map(userOf);
    return {
      id: i.id,
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state,
      html_url: `${web}/${full}/${i.pr ? "pulls" : "issues"}/${i.number}`,
      user: userOf(i.userId),
      labels: i.labels.map(labelJson),
      // Nobody assigned: null, not [].
      assignees: people.length ? people : null,
      assignee: people[0] ?? null,
      repository: { id: repo.id, name: repo.name, owner: repo.owner, full_name: full },
      pull_request: i.pr ? { merged: false } : null,
      created_at: iso(i.created),
      updated_at: iso(i.updated),
      closed_at: i.closed === null ? null : iso(i.closed),
    };
  };
  const commentJson = (c: SimComment): GiteaComment => ({ id: c.id, body: c.body, user: userOf(c.userId), created_at: iso(c.created), updated_at: iso(c.updated) });
  const timeJson = (t: SimTime): GiteaTrackedTime => {
    const issue = issues.find((i) => i.id === t.issueId) as SimIssue;
    return { id: t.id, created: iso(t.created), time: t.time, user_id: t.userId, user_name: userOf(t.userId).login, issue_id: t.issueId, issue: shown(issue) };
  };
  const timelineJson = (e: SimTimeline): GiteaTimelineEntry => ({ id: e.id, type: e.type, created_at: iso(e.at), user: userOf(e.userId), ...e.extra });

  const find = (full: string, n: number) => {
    const repo = repos.get(repoKey(full));
    return repo ? issues.find((i) => i.repoId === repo.id && i.number === n) : undefined;
  };

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const sent = new Headers(init?.headers);
    requests.push({ method, origin: url.origin, path: url.pathname, search: url.search, headers: Object.fromEntries(sent.entries()) });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname.startsWith(apiPath) ? url.pathname.slice(apiPath.length) : url.pathname;

    const failure = failures.shift();
    if (failure) return json(failure.body, failure.status, failure.headers);
    if (path === "/version") return json({ version: "1.22.0" });

    // Authorization: "token X" (the documented form) or "Bearer X".
    const auth = /^(?:token|bearer)\s+(\S+)$/i.exec(sent.get("authorization") ?? "");
    const granted = auth ? tokens.get(auth[1]) : undefined;
    if (!granted) return problem(401, "user does not exist [uid: 0, name: ]");
    const doer = users.get(granted.userId) as GiteaUser;
    const need = (scope: string) => (granted.scopes.has(scope) ? null : problem(403, `token does not have at least one of required scope(s): [${scope}]`));

    if (path === "/user") return need("read:user") ?? json(doer);
    const scopeError = need(path.startsWith("/user/") || method === "GET" ? "read:issue" : "write:issue");
    if (scopeError) return scopeError;

    const limit = Math.min(sim.maxLimit, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
    const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const paged = <T>(list: T[]) => {
      const at = (n: number) => {
        const u = new URL(url.pathname + url.search, sim.rootUrl ?? url.origin);
        u.searchParams.set("page", String(n));
        return u.toString();
      };
      const lastPage = Math.max(1, Math.ceil(list.length / limit));
      const links = [pageNo < lastPage ? `<${at(pageNo + 1)}>; rel="next"` : null, `<${at(lastPage)}>; rel="last"`].filter(Boolean).join(", ");
      return json(list.slice((pageNo - 1) * limit, pageNo * limit), 200, { Link: links, "X-Total-Count": String(list.length) });
    };
    const since = url.searchParams.get("since");
    if (since !== null && !RFC3339.test(since)) return problem(422, `invalid since "${since}": must be RFC 3339`);
    const sinceMs = since === null ? 0 : Date.parse(since);

    // Issues the user can see (a repository without access is not there).
    const visible = (i: SimIssue) => repoById(i.repoId).access;

    if (path === "/repos/issues/search") {
      const type = url.searchParams.get("type");
      const state = url.searchParams.get("state") ?? "open";
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = issues
        .filter(visible)
        .filter((i) => (type === "issues" ? !i.pr : type === "pulls" ? i.pr : true))
        .filter((i) => state === "all" || i.state === state)
        .filter((i) => url.searchParams.get("assigned") !== "true" || i.assignees.includes(doer.id))
        .filter((i) => url.searchParams.get("created") !== "true" || i.userId === doer.id)
        // Mentioned: named as @login in the text (Gitea also counts comments; the simulator doesn't).
        .filter((i) => url.searchParams.get("mentioned") !== "true" || new RegExp(`@${doer.login}\\b`, "i").test(i.body ?? ""))
        .filter((i) => i.updated >= sinceMs)
        .filter((i) => !q || i.title.toLowerCase().includes(q) || (i.body ?? "").toLowerCase().includes(q))
        // Newest first, not by update: the order says nothing about what changed.
        .sort((a, b) => b.created - a.created || b.id - a.id);
      return paged(hits.map(shown));
    }

    if (path === "/user/times") {
      const before = url.searchParams.get("before");
      if (before !== null && !RFC3339.test(before)) return problem(422, `invalid before "${before}": must be RFC 3339`);
      const mine = times
        .filter((t) => t.userId === doer.id && t.created >= sinceMs && (before === null || t.created <= Date.parse(before)))
        .filter((t) => visible(issues.find((i) => i.id === t.issueId) as SimIssue))
        .sort((a, b) => a.id - b.id);
      return paged(mine.map(timeJson));
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/.*)?$/.exec(path);
    if (!m) return problem(404, `unmocked ${method} ${path}`);
    const [, owner, name, num, rest = ""] = m;
    // A renamed repository answers with a redirect to its new name.
    const moved = redirects.get(repoKey(`${owner}/${name}`));
    if (moved && !repos.has(repoKey(`${owner}/${name}`))) {
      return new Response(null, { status: method === "GET" ? 301 : 307, headers: { Location: `${url.origin}${apiPath}/repos/${moved}/issues/${num}${rest}${url.search}` } });
    }
    const repo = repos.get(repoKey(`${owner}/${name}`));
    const issue = repo?.access ? find(`${owner}/${name}`, Number(num)) : undefined;
    if (!repo || !issue) return problem(404, "The target couldn't be found.");
    const writeRefused = () => (method !== "GET" && repo.archived ? problem(403, "repo is archived") : null);

    if (rest === "") {
      if (method === "PATCH") {
        const refused = writeRefused();
        if (refused) return refused;
        if (typeof body.state === "string" && body.state !== issue.state) {
          issue.state = body.state === "closed" ? "closed" : "open";
          issue.closed = issue.state === "closed" ? stamp() : null;
          event(issue, issue.state === "closed" ? "close" : "reopen", doer.id);
        }
        if (typeof body.title === "string" && body.title !== issue.title) {
          event(issue, "change_title", doer.id, { old_title: issue.title, new_title: body.title });
          issue.title = body.title;
        }
        if (typeof body.body === "string") issue.body = body.body;
        issue.updated = stamp();
        // The edit answers 201 Created (a quirk of the documentation).
        return json(shown(issue), 201);
      }
      return json(shown(issue));
    }

    if (rest === "/comments") {
      if (method === "POST") {
        const refused = writeRefused();
        if (refused) return refused;
        const at = stamp();
        const c: SimComment = { id: ++seq, userId: doer.id, body: typeof body.body === "string" ? body.body : "", created: at, updated: at };
        issue.comments.push(c);
        issue.updated = at;
        return json(commentJson(c), 201);
      }
      // Comments of one issue: not paged by the real server, but `limit` is accepted.
      return paged(issue.comments.map(commentJson));
    }

    if (rest === "/timeline") return paged(issue.timeline.map(timelineJson));

    const sub = /^\/subscriptions\/([^/]+)$/.exec(rest);
    if (sub) {
      const target = [...users.values()].find((u) => u.login === decodeURIComponent(sub[1]));
      if (!target) return problem(404, "user does not exist");
      const refused = writeRefused();
      if (refused) return refused;
      const had = issue.subscribers.has(target.id);
      if (method === "PUT") issue.subscribers.add(target.id);
      else issue.subscribers.delete(target.id);
      // Already in the asked state: 200; changed: 201.
      return new Response(null, { status: method === "PUT" ? (had ? 200 : 201) : had ? 201 : 200 });
    }

    if (rest === "/times" || /^\/times\/\d+$/.test(rest)) {
      if (!repo.timeTracking) return problem(400, "time tracking disabled");
      // Without write access (or being assigned) the answer is an empty 403.
      if (!repo.canWrite && !issue.assignees.includes(doer.id)) return new Response(null, { status: 403 });
      if (rest === "/times" && method === "GET") {
        const own = times.filter((t) => t.issueId === issue.id && (repo.canWrite || t.userId === doer.id) && t.created >= sinceMs);
        return paged(own.sort((a, b) => a.id - b.id).map(timeJson));
      }
      const refused = writeRefused();
      if (refused) return refused;
      if (rest === "/times" && method === "POST") {
        const seconds = body.time;
        if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) return problem(400, "time must be a positive number of seconds");
        const createdAt = typeof body.created === "string" ? body.created : null;
        if (createdAt !== null && !RFC3339.test(createdAt)) return problem(422, `invalid created "${createdAt}": must be RFC 3339`);
        const t: SimTime = { id: ++seq, issueId: issue.id, userId: doer.id, created: createdAt ? Date.parse(createdAt) : stamp(), time: seconds };
        times.push(t);
        return json(timeJson(t));
      }
      const entry = times.find((t) => t.id === Number(rest.slice("/times/".length)) && t.issueId === issue.id);
      if (!entry) return problem(404, "tracked time not found");
      // Only one's own entry (or a repository admin's) can be deleted.
      if (entry.userId !== doer.id) return new Response(null, { status: 403 });
      times.splice(times.indexOf(entry), 1);
      return json(undefined, 204);
    }
    return problem(404, `unmocked ${method} ${path}`);
  }

  const key = (i: SimIssue) => `${fullOf(repoById(i.repoId))}#${i.number}`;
  return {
    apiBase,
    me,
    fetch: handle,
    /** Everything the server was asked, in order */
    requests,
    /** Server settings a test changes: the page ceiling, ROOT_URL */
    settings: sim,
    key,
    repo: addRepo,
    issues,
    add,
    /** A person who can be assigned, comment, log time */
    user(u: GiteaUser) {
      users.set(u.id, u);
      return u;
    },
    /** A token with some scopes (a PAT is made with the scopes asked) */
    token(token: string, scopes: string[] = ALL_SCOPES, userId = me.id) {
      tokens.set(token, { userId, scopes: new Set(scopes) });
    },
    /** The next request(s) fail like this (a proxy's 429, a 502…) */
    failNext(status: number, headers: Record<string, string> = {}, body: unknown = { message: "failed" }, count = 1) {
      for (let n = 0; n < count; n++) failures.push({ status, headers, body });
    },
    /** Time logged by someone, outside inkledger */
    time(i: SimIssue, o: { seconds: number; created: number; userId?: number }) {
      const t: SimTime = { id: ++seq, issueId: i.id, userId: o.userId ?? me.id, created: o.created, time: o.seconds };
      times.push(t);
      return t;
    },
    times,
    /** Changes made on the server by someone else (the web UI, another client) */
    outside: {
      close: (i: SimIssue) => {
        i.state = "closed";
        i.closed = stamp();
        event(i, "close", me.id);
      },
      reopen: (i: SimIssue) => {
        i.state = "open";
        i.closed = null;
        event(i, "reopen", me.id);
      },
      retitle: (i: SimIssue, title: string) => {
        event(i, "change_title", me.id, { old_title: i.title, new_title: title });
        i.title = title;
      },
      label: (i: SimIssue, label: string, added = true) => {
        i.labels = added ? [...i.labels, label] : i.labels.filter((l) => l !== label);
        event(i, "label", me.id, { label: labelJson(label), body: added ? "1" : "" });
      },
      assign: (i: SimIssue, userId: number, assigned = true) => {
        i.assignees = assigned ? [...i.assignees, userId] : i.assignees.filter((u) => u !== userId);
        event(i, "assignees", me.id, { assignee: userOf(userId), removed_assignee: !assigned });
      },
      comment: (i: SimIssue, text: string, userId = me.id) => {
        const at = stamp();
        i.comments.push({ id: ++seq, userId, body: text, created: at, updated: at });
        i.updated = at;
      },
      removeTime: (id: number) => {
        const at = times.findIndex((t) => t.id === id);
        if (at >= 0) times.splice(at, 1);
      },
      /** The repository gets another name; the old one redirects */
      rename: (from: string, to: string) => {
        const repo = repos.get(repoKey(from));
        if (!repo) return;
        repos.delete(repoKey(from));
        [repo.owner, repo.name] = to.split("/");
        repos.set(repoKey(to), repo);
        redirects.set(repoKey(from), to);
      },
      /** The user can't see the repository any more (private, removed from the team) */
      revokeAccess: (full: string) => addRepo(full, { access: false }),
      /** The account is deleted: what it wrote is now by "Ghost" */
      deleteUser: (id: number) => void deletedUsers.add(id),
    },
  };
}
