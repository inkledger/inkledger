// Tests only: a small Jira Cloud (REST v3) in memory, answering the calls the
// Jira client makes, so the provider contract runs against the real adapter
// and client code end to end. Install it as `fetch`.
type Issue = {
  id: string;
  key: string;
  summary: string;
  status: { id: string; name: string; category: "new" | "indeterminate" | "done" };
  /** Its changelog, oldest first: status changes only */
  histories: { created: string; items: { field: string; fieldtype: string; from: string; fromString: string; to: string; toString: string }[] }[];
  assignee: string | null;
  /** Its priority's name (Medium unless a test raises it) */
  priority: string;
  /** Its labels and components (none unless a test sets them) */
  labels?: string[];
  components?: string[];
  updated: string;
  watchers: Set<string>;
  comments: { id: string; body: unknown; created: string; author: string }[];
};
type Worklog = { id: string; issueId: string; timeSpentSeconds: number; started: string; comment: unknown; author: string; updated: number };

const STATUSES = [
  { id: "11", name: "To Do", category: "new" as const },
  { id: "21", name: "In Progress", category: "indeterminate" as const },
  { id: "31", name: "Done", category: "done" as const },
];

export function jiraSimulator(site = "https://sim.atlassian.net", me = "acc-sim", o: { statusNames?: Record<string, string> } = {}) {
  /** Status names as the site shows them (a localized site renames them; ids stay) */
  const named = (s: (typeof STATUSES)[number]) => ({ ...s, name: o.statusNames?.[s.id] ?? s.name });
  const statuses = STATUSES.map(named);
  const issues = new Map<string, Issue>();
  const worklogs = new Map<string, Worklog>();
  const deleted: { id: string; at: number }[] = [];
  let seq = 100;
  let clock = Date.UTC(2026, 9, 1);
  const tick = () => (clock += 1000);

  const add = (key: string, summary: string, status = STATUSES[0], assignee: string | null = me) => {
    const s = named(status);
    const issue: Issue = { id: String(++seq), key, summary, status: { id: s.id, name: s.name, category: s.category }, histories: [], assignee, priority: "Medium", updated: new Date(tick()).toISOString(), watchers: new Set(), comments: [] };
    issues.set(key, issue);
    return issue;
  };

  const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const view = (i: Issue) => ({
    id: i.id,
    key: i.key,
    fields: {
      summary: i.summary,
      status: { id: i.status.id, name: i.status.name, statusCategory: { key: i.status.category } },
      project: { key: i.key.split("-")[0], name: `Project ${i.key.split("-")[0]}` },
      issuetype: { name: "Task" },
      priority: { name: i.priority },
      labels: i.labels ?? [],
      components: (i.components ?? []).map((name) => ({ name })),
      assignee: i.assignee ? { accountId: i.assignee, displayName: i.assignee } : null,
      updated: i.updated,
      created: "2026-09-01T10:00:00.000+0000",
    },
  });
  const worklogView = (w: Worklog) => ({ id: w.id, issueId: w.issueId, timeSpentSeconds: w.timeSpentSeconds, started: w.started, comment: w.comment, author: { accountId: w.author }, updated: new Date(w.updated).toISOString() });
  const byId = (id: string) => [...issues.values()].find((i) => i.id === id);

  /** Answers to inject before the next real one (errors), and a delay to answer after (for cancellation). */
  const injected: { status: number; headers?: Record<string, string> }[] = [];
  let delayMs = 0;
  const failNext = (status: number, headers?: Record<string, string>) => void injected.push({ status, headers });
  const slow = (ms: number) => void (delayMs = ms);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
    const fault = injected.shift();
    if (fault) return new Response(JSON.stringify({ errorMessages: [`injected ${fault.status}`] }), { status: fault.status, headers: { "Content-Type": "application/json", ...fault.headers } });
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== site) return json({ errorMessages: ["unknown site"] }, 404);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = url.pathname.replace(/^\/rest\/api\/3/, "");
    let m: RegExpExecArray | null;

    if (path === "/myself") return json({ accountId: me, displayName: "Sim User", emailAddress: "sim@example.com" });
    if (path === "/search/jql") {
      const jql = url.searchParams.get("jql") ?? "";
      const key = /^key = (\S+)$/.exec(jql)?.[1];
      const id = /^id = (\d+)$/.exec(jql)?.[1];
      const text = /^text ~ "(.*)"/.exec(jql)?.[1]?.toLowerCase();
      const found = key
        ? [...issues.values()].filter((i) => i.key === key)
        : id
          ? [...issues.values()].filter((i) => i.id === id)
          : text !== undefined
            ? [...issues.values()].filter((i) => i.summary.toLowerCase().includes(text))
            : [...issues.values()].filter((i) => !/assignee/.test(jql) || i.assignee === me);
      return json({ isLast: true, issues: found.map(view) });
    }
    if ((m = /^\/issue\/([^/]+)$/.exec(path))) {
      const i = issues.get(decodeURIComponent(m[1]));
      return i ? json({ ...view(i), changelog: { histories: i.histories } }) : json({ errorMessages: ["Issue does not exist"] }, 404);
    }
    if ((m = /^\/issue\/([^/]+)\/changelog$/.exec(path))) {
      const i = issues.get(decodeURIComponent(m[1]));
      return i ? json({ values: i.histories, isLast: true }) : json({ errorMessages: ["Issue does not exist"] }, 404);
    }
    if ((m = /^\/issue\/([^/]+)\/transitions$/.exec(path))) {
      const i = issues.get(decodeURIComponent(m[1]));
      if (!i) return json({ errorMessages: ["Issue does not exist"] }, 404);
      if (method === "GET") return json({ transitions: statuses.filter((s) => s.id !== i.status.id).map((s) => ({ id: s.id, name: s.name, to: { id: s.id, name: s.name, statusCategory: { key: s.category } } })) });
      if (!transition(i, (body.transition as { id?: string } | undefined)?.id)) return json({ errorMessages: ["Invalid transition"] }, 400);
      return json(undefined, 204);
    }
    if ((m = /^\/issue\/([^/]+)\/worklog$/.exec(path))) {
      const i = issues.get(decodeURIComponent(m[1]));
      if (!i) return json({ errorMessages: ["Issue does not exist"] }, 404);
      if (method === "GET") {
        const list = [...worklogs.values()].filter((w) => w.issueId === i.id);
        return json({ worklogs: list.map(worklogView), total: list.length });
      }
      const w: Worklog = { id: String(++seq), issueId: i.id, timeSpentSeconds: Number(body.timeSpentSeconds), started: String(body.started), comment: body.comment, author: me, updated: tick() };
      worklogs.set(w.id, w);
      return json(worklogView(w), 201);
    }
    if ((m = /^\/issue\/([^/]+)\/worklog\/([^/]+)$/.exec(path))) {
      const w = worklogs.get(decodeURIComponent(m[2]));
      if (!w) return json({ errorMessages: ["Worklog does not exist"] }, 404);
      if (method === "DELETE") {
        worklogs.delete(w.id);
        deleted.push({ id: w.id, at: tick() });
        return json(undefined, 204);
      }
      Object.assign(w, { timeSpentSeconds: Number(body.timeSpentSeconds), started: String(body.started), comment: body.comment, updated: tick() });
      return json(worklogView(w));
    }
    if ((m = /^\/worklog\/(updated|deleted)$/.exec(path))) {
      const since = Number(url.searchParams.get("since") ?? 0);
      const values =
        m[1] === "updated"
          ? [...worklogs.values()].filter((w) => w.updated > since).map((w) => ({ worklogId: Number(w.id) }))
          : deleted.filter((d) => d.at > since).map((d) => ({ worklogId: Number(d.id) }));
      return json({ values, until: clock, lastPage: true });
    }
    if (path === "/worklog/list" && method === "POST") {
      const ids = ((body.ids as number[] | undefined) ?? []).map(String);
      return json(ids.map((id) => worklogs.get(id)).filter((w): w is Worklog => !!w).map(worklogView));
    }
    if ((m = /^\/issue\/([^/]+)\/comment$/.exec(path))) {
      const i = issues.get(decodeURIComponent(m[1]));
      if (!i) return json({ errorMessages: ["Issue does not exist"] }, 404);
      if (method === "GET") return json({ comments: i.comments.map((c) => ({ ...c, author: { accountId: c.author, displayName: c.author } })) });
      const c = { id: String(++seq), body: body.body, created: new Date(tick()).toISOString(), author: me };
      i.comments.push(c);
      return json({ ...c, author: { accountId: me, displayName: me } }, 201);
    }
    if ((m = /^\/issue\/([^/]+)\/watchers$/.exec(path))) {
      const i = issues.get(decodeURIComponent(m[1]));
      if (!i) return json({ errorMessages: ["Issue does not exist"] }, 404);
      if (method === "POST") i.watchers.add(me);
      if (method === "DELETE") i.watchers.delete(me);
      return json(undefined, 204);
    }
    return json({ errorMessages: [`simulator: ${method} ${path} not handled`] }, 501);
  }

  /** The issue goes to a status (by id), its changelog recording it. */
  function transition(i: Issue, statusId: string | undefined) {
    const to = statuses.find((s) => s.id === statusId);
    if (!to) return false;
    const at = new Date(tick()).toISOString();
    i.histories.push({ created: at, items: [{ field: "status", fieldtype: "jira", from: i.status.id, fromString: i.status.name, to: to.id, toString: to.name }] });
    i.status = { id: to.id, name: to.name, category: to.category };
    i.updated = at;
    return true;
  }
  /** Changes made by someone else, on the site */
  const outside = { transition: (key: string, statusId: string) => void transition(issues.get(key)!, statusId) };

  /** The issue moves to another project: same id, new key (the old key answers 404). */
  const move = (key: string, newKey: string) => {
    const i = issues.get(key)!;
    issues.delete(key);
    i.key = newKey;
    i.updated = new Date(tick()).toISOString();
    issues.set(newKey, i);
  };

  return { site, me, add, move, outside, issues, worklogs, fetch: handle, byId, failNext, slow };
}
