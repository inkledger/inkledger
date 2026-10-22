// A GitHub in memory, for tests: the REST endpoints the adapter calls, with
// GitHub's own shapes (pages by Link header, pull requests mixed in the
// assigned list, 404 for what isn't there).
import { createHash } from "node:crypto";
import type { GitHubComment, GitHubIssue, GitHubUser } from "./client";

export function githubSimulator(apiBase = "https://api.github.com", me: GitHubUser = { id: 4242, login: "mrossi", name: "Mario Rossi" }) {
  const issues: (GitHubIssue & { owner: string; repo: string; assignee: number | null; comments: GitHubComment[] })[] = [];
  /**
   * Repositories: `member` (owned, collaborated on or org member: in the `filter=all` feed), `watched` (subscribed),
   * `org` (reached only as an org member, not owned or collaborated on) and `push` (the user can write to it).
   */
  const repos = new Map<string, { member: boolean; watched: boolean; org: boolean; push: boolean }>();
  /** People who can be assigned (besides me), and every repository's labels. */
  const people: GitHubUser[] = [me, { id: 5151, login: "anna-b", name: "Anna Bianchi" }];
  const LABELS = ["bug", "enhancement", "ui"];
  const addRepo = (full: string, o: { member?: boolean; watched?: boolean; org?: boolean; push?: boolean } = {}) => {
    const known = repos.get(full);
    const org = o.org ?? known?.org ?? false;
    repos.set(full, { member: o.member ?? known?.member ?? true, watched: o.watched ?? known?.watched ?? false, org, push: o.push ?? known?.push ?? !org });
  };
  let clock = Date.UTC(2026, 9, 1);
  // Ids unique across simulators, as GitHub's are across accounts (the default one starts at 1000).
  let seq = me.id === 4242 ? 1000 : me.id * 1000;
  const tick = () => new Date((clock += 1000)).toISOString();
  const web = apiBase === "https://api.github.com" ? "https://github.com" : apiBase.replace(/\/api\/v3$/, "");
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  const add = (full: string, title: string, o: { assignee?: number | null; pr?: boolean; body?: string; author?: GitHubUser } = {}) => {
    if (!repos.has(full)) addRepo(full);
    const [owner, repo] = full.split("/");
    const number = issues.filter((i) => i.owner === owner && i.repo === repo).length + 1;
    const at = tick();
    const i = {
      id: ++seq,
      node_id: `I_${seq}`,
      number,
      title,
      body: o.body ?? null,
      state: "open" as const,
      state_reason: null,
      html_url: `${web}/${full}/issues/${number}`,
      repository_url: `${apiBase}/repos/${full}`,
      repository: { id: 1, node_id: `R_${full}`, full_name: full, name: repo },
      labels: [] as GitHubIssue["labels"],
      assignees: o.assignee === null ? [] : [me],
      user: o.author ?? me,
      created_at: at,
      updated_at: at,
      closed_at: null,
      ...(o.pr ? { pull_request: { url: "x" } } : {}),
      owner,
      repo,
      assignee: o.assignee === undefined ? me.id : o.assignee,
      comments: [] as GitHubComment[],
    };
    issues.push(i);
    return i;
  };
  /** An issue as GitHub sends it (the simulator's own bookkeeping left out). */
  const shown = (i: (typeof issues)[number]): GitHubIssue => {
    const out: Partial<(typeof issues)[number]> = { ...i };
    delete out.owner;
    delete out.repo;
    delete out.assignee;
    delete out.comments;
    return out as GitHubIssue;
  };
  const find = (owner: string, repo: string, n: number) => issues.find((i) => i.owner === owner && i.repo === repo && i.number === n);

  /** The user's notification threads (GitHub's inbox). */
  const threads: { id: string; reason: string; unread: boolean; updated_at: string; subject: { title: string; url: string; type: string } }[] = [];
  const notify = (full: string, number: number, reason: string, title = "") => {
    const t = { id: String(9000 + threads.length), reason, unread: true, updated_at: tick(), subject: { title, url: `${apiBase}/repos/${full}/issues/${number}`, type: "Issue" } };
    threads.push(t);
    return t;
  };

  /** Conditional reads answered 304 (GitHub's ETags), counted. */
  let notModified = 0;
  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const res = await answer(input, init);
    // A GET answers with an ETag of its body; asked again with it, unchanged: 304 (free on GitHub).
    if ((init?.method ?? "GET").toUpperCase() !== "GET" || !res.ok) return res;
    const text = await res.text();
    const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
    const headers = new Headers(res.headers);
    headers.set("ETag", etag);
    if (new Headers(init?.headers).get("If-None-Match") === etag) {
      notModified++;
      return new Response(null, { status: 304, headers });
    }
    return new Response(text, { status: res.status, headers });
  }

  async function answer(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname.replace(new URL(apiBase).pathname.replace(/\/$/, ""), "");
    if (path === "/user") return json(me);
    if (path === "/notifications" && method === "GET") {
      const since = url.searchParams.get("since");
      return json(threads.filter((t) => t.unread && (!since || t.updated_at > since)));
    }
    const thread = /^\/notifications\/threads\/(\d+)$/.exec(path);
    if (thread && method === "PATCH") {
      const t = threads.find((x) => x.id === thread[1]);
      if (!t) return json({ message: "Not Found" }, 404);
      t.unread = false;
      return new Response(null, { status: 205 });
    }
    if (path === "/rate_limit") return json({ resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });
    const paged = <T>(list: T[]) => {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return json(list.slice((page - 1) * per, page * per), 200, page * per < list.length ? { Link: `<${next.toString()}>; rel="next"` } : {});
    };
    const since = url.searchParams.get("since");
    const byUpdate = (list: typeof issues) =>
      list.filter((i) => !since || i.updated_at >= since).sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id).map(shown);
    if (path === "/issues") {
      // assigned: mine anywhere; all: every issue of the member repositories.
      const filter = url.searchParams.get("filter") ?? "assigned";
      return paged(byUpdate(issues.filter((i) => (filter === "all" ? repos.get(`${i.owner}/${i.repo}`)?.member : i.assignee === me.id))));
    }
    const repoJson = (full: string) => ({ id: 1, node_id: `R_${full}`, full_name: full, name: full.split("/")[1], has_issues: true, permissions: { admin: false, push: !!repos.get(full)?.push, pull: true } });
    if (path === "/user/repos") {
      // affiliation: owner and collaborator (the user's own), organization_member (every repository of the user's orgs).
      const affiliation = (url.searchParams.get("affiliation") ?? "owner,collaborator,organization_member").split(",");
      const own = affiliation.includes("owner") || affiliation.includes("collaborator");
      const orgs = affiliation.includes("organization_member");
      return paged([...repos].filter(([, r]) => r.member && (r.org ? orgs : own)).map(([full]) => repoJson(full)));
    }
    if (path === "/user/subscriptions") return paged([...repos].filter(([, r]) => r.watched).map(([full]) => repoJson(full)));
    const list = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    if (list && method === "POST") {
      const full = `${list[1]}/${list[2]}`;
      if (!repos.has(full)) return json({ message: "Not Found" }, 404);
      const created = add(full, typeof body.title === "string" ? body.title : "", { body: typeof body.body === "string" ? body.body : undefined, assignee: null });
      if (Array.isArray(body.labels)) created.labels = body.labels.map((name) => ({ name: String(name) }));
      if (Array.isArray(body.assignees)) {
        created.assignees = people.filter((u) => (body.assignees as unknown[]).includes(u.login));
        created.assignee = created.assignees[0]?.id ?? null;
      }
      return json(shown(created), 201);
    }
    const meta = /^\/repos\/([^/]+)\/([^/]+)\/(assignees|labels)$/.exec(path);
    if (meta) {
      if (!repos.has(`${meta[1]}/${meta[2]}`)) return json({ message: "Not Found" }, 404);
      return meta[3] === "assignees" ? paged(people) : paged(LABELS.map((name) => ({ name })));
    }
    if (list && method === "GET") {
      if (!repos.has(`${list[1]}/${list[2]}`)) return json({ message: "Not Found" }, 404);
      return paged(byUpdate(issues.filter((i) => i.owner === list[1] && i.repo === list[2])));
    }
    if (path === "/search/issues") {
      // GitHub's qualifiers the adapter writes (repo, user, label, is/state, assignee, author, involves, -negation); the rest are words of the title.
      const tokens = (url.searchParams.get("q") ?? "").match(/-?[a-z]+:"[^"]*"|-?[a-z]+:\S+|"[^"]*"|\S+/gi) ?? [];
      const test = (i: (typeof issues)[number], tok: string): boolean => {
        const [k, ...rest] = tok.split(":");
        const v = rest.join(":").replace(/^"|"$/g, "").toLowerCase();
        if (!rest.length) return i.title.toLowerCase().includes(tok.replace(/^"|"$/g, "").toLowerCase());
        switch (k.toLowerCase()) {
          case "is":
            return v === "issue" || v === "pr" ? true : i.state === v;
          case "state":
            return i.state === v;
          case "repo":
            return `${i.owner}/${i.repo}`.toLowerCase() === v;
          case "user":
            return i.owner.toLowerCase() === v;
          case "label":
            return i.labels.some((l) => (typeof l === "string" ? l : l.name ?? "").toLowerCase() === v);
          case "assignee":
            return v === "@me" ? i.assignee === me.id : (i.assignees ?? []).some((a) => a.login.toLowerCase() === v);
          case "author":
            return v === "@me" ? i.user?.id === me.id : i.user?.login.toLowerCase() === v;
          case "involves":
            // Author, assignee or mentioned (the simulator has no mentions): the user's own part in it.
            return v === "@me" ? i.user?.id === me.id || i.assignee === me.id : i.user?.login.toLowerCase() === v || (i.assignees ?? []).some((a) => a.login.toLowerCase() === v);
          default:
            return true;
        }
      };
      const hits = issues
        .filter((i) => !i.pull_request && tokens.every((tok) => (tok.startsWith("-") ? !test(i, tok.slice(1)) : test(i, tok))))
        .map(shown);
      return json({ total_count: hits.length, incomplete_results: false, items: hits });
    }
    let m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (m) {
      const i = find(m[1], m[2], Number(m[3]));
      if (!i) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") {
        if (typeof body.state === "string") Object.assign(i, { state: body.state, state_reason: body.state_reason ?? null, closed_at: body.state === "closed" ? tick() : null });
        if (typeof body.title === "string") i.title = body.title;
        if (typeof body.body === "string") i.body = body.body;
        if (Array.isArray(body.labels)) i.labels = body.labels.map((name) => ({ name: String(name) }));
        if (Array.isArray(body.assignees)) {
          i.assignees = people.filter((u) => (body.assignees as unknown[]).includes(u.login));
          i.assignee = i.assignees[0]?.id ?? null;
        }
        i.updated_at = tick();
      }
      return json(shown(i));
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (m) {
      const i = find(m[1], m[2], Number(m[3]));
      if (!i) return json({ message: "Not Found" }, 404);
      if (method === "POST") {
        const at = tick();
        const c: GitHubComment = { id: ++seq, body: typeof body.body === "string" ? body.body : "", user: me, created_at: at, updated_at: at };
        i.comments.push(c);
        i.updated_at = at;
        return json(c, 201);
      }
      return json(i.comments);
    }
    return json({ message: `unmocked ${method} ${path}` }, 404);
  }

  return { apiBase, me, add, repo: addRepo, issues, threads, notify, fetch: handle, notModified: () => notModified };
}
