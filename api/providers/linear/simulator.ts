// A Linear in memory, for tests: the GraphQL operations the adapter sends, in
// Linear's own shapes and with its documented traps, written from its public
// API documentation (not checked against a real workspace: see the spikes).
//   - one endpoint, POST /graphql; a personal key goes as is, "Bearer" is for
//     OAuth tokens and is refused with a key (401)
//   - failures such as "Entity not found" come as HTTP 200 with `errors`; a
//     spent rate limit comes as HTTP 400 (code RATELIMITED), with budgets in
//     X-RateLimit-* headers (epoch seconds)
//   - Relay cursors, at most 250 per page, newest-updated first (never
//     oldest first), and a query over 10,000 complexity points is refused
//   - archived and trashed issues only when asked (includeArchived)
//   - an issue moved to another team gets a new identifier and keeps the old
//     ones (previousIdentifiers), which still resolve to it
//   - dueDate is a date without a zone; every timestamp is UTC
//   - priority 0 means "no priority"; workflow states are the team's, named
//     as the team likes, typed by a fixed enum; triage exists only when the
//     team turned it on
//   - a mutation can answer success: false with HTTP 200
//   - an integration's comment has no user, only a botActor
import { createHmac } from "node:crypto";
import type { LinearComment, LinearIssue, LinearState, LinearStateType, LinearTeam, LinearUser } from "./client";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/** What a query may weigh, per node of a connection, and in all. */
export const NODE_COST = 45;
export const COMPLEXITY_LIMIT = 10_000;
export const MAX_PAGE = 250;

type SimState = LinearState & { position: number };
type SimTeam = LinearTeam & { states: SimState[]; next: number; member: boolean; triage: boolean };
type HistoryEntry = { id: string; createdAt: string; actor: LinearUser | null } & Record<string, unknown>;
type SimComment = LinearComment & { issueId: string };
type SimIssue = {
  id: string;
  teamId: string;
  number: number;
  previous: string[];
  title: string;
  description: string | null;
  stateId: string;
  assigneeId: string | null;
  creatorId: string;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  parentId: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashed: boolean;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  subscribers: Set<string>;
  history: HistoryEntry[];
};

const DEFAULT_STATES: [string, LinearStateType][] = [
  ["Backlog", "backlog"],
  ["Todo", "unstarted"],
  ["In Progress", "started"],
  ["Done", "completed"],
  ["Canceled", "canceled"],
];

export function linearSimulator(apiBase = "https://api.linear.app", me: LinearUser = { id: uuid(1), name: "Mario Rossi", displayName: "mario", email: "mario@acme.example", avatarUrl: null }) {
  const users = new Map<string, LinearUser>([[me.id, me]]);
  const teams: SimTeam[] = [];
  const issues: SimIssue[] = [];
  const comments: SimComment[] = [];
  const tokens = new Set(["lin_api_test"]);
  const oauthTokens = new Set(["oauth_test"]);
  /** The next requests answered "rate limited" */
  let limited = 0;
  let clock = Date.UTC(2026, 9, 1);
  let seq = 100;
  const tick = () => new Date((clock += 1000)).toISOString();
  const calls: { operationName: string; cost: number; authorization: string | null }[] = [];

  const addUser = (name: string) => {
    const u: LinearUser = { id: uuid(++seq), name, displayName: name.split(" ")[0].toLowerCase(), email: null, avatarUrl: null };
    users.set(u.id, u);
    return u;
  };

  const addTeam = (key: string, name = key, o: { triage?: boolean; member?: boolean; states?: [string, LinearStateType][] } = {}) => {
    const defs: [string, LinearStateType][] = [...(o.triage ? ([["Triage", "triage"]] as [string, LinearStateType][]) : []), ...(o.states ?? DEFAULT_STATES)];
    const t: SimTeam = {
      id: uuid(++seq),
      key,
      name,
      next: 1,
      member: o.member ?? true,
      triage: o.triage ?? false,
      states: defs.map(([n, type], i) => ({ id: uuid(++seq), name: n, type, color: "#888888", position: i })),
    };
    teams.push(t);
    return t;
  };
  const team = (key: string) => {
    const t = teams.find((x) => x.key === key);
    if (!t) throw new Error(`no team ${key}`);
    return t;
  };
  const stateIn = (t: SimTeam, name: string) => {
    const s = t.states.find((x) => x.name === name);
    if (!s) throw new Error(`no state ${name} in ${t.key}`);
    return s;
  };
  const identifier = (i: SimIssue) => `${teams.find((t) => t.id === i.teamId)!.key}-${i.number}`;
  const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const add = (teamKey: string, title: string, o: { assignee?: LinearUser | null; state?: string; priority?: number; estimate?: number; dueDate?: string; description?: string; parent?: string; labels?: string[]; subscribe?: LinearUser[] } = {}) => {
    const t = team(teamKey);
    const at = tick();
    const state = o.state ? stateIn(t, o.state) : t.states.find((s) => s.type === "backlog") ?? t.states[0];
    const assignee = o.assignee === undefined ? me : o.assignee;
    const i: SimIssue = {
      id: uuid(++seq),
      teamId: t.id,
      number: t.next++,
      previous: [],
      title,
      description: o.description ?? null,
      stateId: state.id,
      assigneeId: assignee?.id ?? null,
      creatorId: me.id,
      priority: o.priority ?? 0,
      estimate: o.estimate ?? null,
      dueDate: o.dueDate ?? null,
      parentId: o.parent ? byAny(o.parent)?.id ?? null : null,
      labels: o.labels ?? [],
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      trashed: false,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      subscribers: new Set([...(assignee ? [assignee.id] : []), ...(o.subscribe ?? []).map((u) => u.id)]),
      history: [],
    };
    issues.push(i);
    return i;
  };

  /** By id, identifier, or an identifier it had before a move to another team. */
  function byAny(idOrKey: string): SimIssue | undefined {
    const k = idOrKey.toUpperCase();
    return issues.find((i) => i.id === idOrKey || identifier(i) === k) ?? issues.find((i) => i.previous.includes(k));
  }

  const record = (i: SimIssue, actor: LinearUser | null, fields: Record<string, unknown>) => {
    i.history.push({ id: uuid(++seq), createdAt: i.updatedAt, actor, ...fields });
  };

  /** Changes made "outside" (in Linear's own app, by someone else). */
  const outside = {
    setState(key: string, stateName: string, actor: LinearUser = me) {
      const i = byAny(key)!;
      const t = teams.find((x) => x.id === i.teamId)!;
      const from = t.states.find((s) => s.id === i.stateId)!;
      const to = stateIn(t, stateName);
      i.stateId = to.id;
      i.updatedAt = tick();
      i.startedAt = to.type === "started" ? i.updatedAt : i.startedAt;
      i.completedAt = to.type === "completed" ? i.updatedAt : null;
      i.canceledAt = to.type === "canceled" ? i.updatedAt : null;
      record(i, actor, { fromState: { id: from.id, name: from.name }, toState: { id: to.id, name: to.name } });
    },
    assign(key: string, who: LinearUser | null, actor: LinearUser = me) {
      const i = byAny(key)!;
      const from = i.assigneeId ? users.get(i.assigneeId) ?? null : null;
      i.assigneeId = who?.id ?? null;
      if (who) i.subscribers.add(who.id);
      i.updatedAt = tick();
      record(i, actor, { fromAssignee: from, toAssignee: who });
    },
    update(key: string, patch: { title?: string; priority?: number; estimate?: number | null; dueDate?: string | null; labels?: string[] }, actor: LinearUser = me) {
      const i = byAny(key)!;
      const h: Record<string, unknown> = {};
      if (patch.title !== undefined) Object.assign(h, { fromTitle: i.title, toTitle: patch.title });
      if (patch.priority !== undefined) Object.assign(h, { fromPriority: i.priority, toPriority: patch.priority });
      if (patch.estimate !== undefined) Object.assign(h, { fromEstimate: i.estimate, toEstimate: patch.estimate });
      if (patch.dueDate !== undefined) Object.assign(h, { fromDueDate: i.dueDate, toDueDate: patch.dueDate });
      if (patch.labels) {
        Object.assign(h, { addedLabels: patch.labels.filter((l) => !i.labels.includes(l)).map((name) => ({ id: name, name })), removedLabels: i.labels.filter((l) => !patch.labels!.includes(l)).map((name) => ({ id: name, name })) });
        i.labels = patch.labels;
      }
      Object.assign(i, { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.priority !== undefined ? { priority: patch.priority } : {}), ...(patch.estimate !== undefined ? { estimate: patch.estimate } : {}), ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}) });
      i.updatedAt = tick();
      record(i, actor, h);
    },
    archive(key: string) {
      const i = byAny(key)!;
      i.archivedAt = i.updatedAt = tick();
    },
    /** Deleting in Linear's UI moves the issue to the trash (archived and trashed). */
    trash(key: string) {
      const i = byAny(key)!;
      i.trashed = true;
      i.archivedAt = i.updatedAt = tick();
    },
    /** Moving to another team: a new number in that team, the old identifier kept as a previous one; the id stays. */
    moveToTeam(key: string, teamKey: string) {
      const i = byAny(key)!;
      const from = teams.find((t) => t.id === i.teamId)!;
      const to = team(teamKey);
      i.previous.push(identifier(i));
      i.teamId = to.id;
      i.number = to.next++;
      // The state is the new team's: the same type, else its first of that type.
      const old = from.states.find((s) => s.id === i.stateId)!;
      i.stateId = (to.states.find((s) => s.type === old.type) ?? to.states[0]).id;
      i.updatedAt = tick();
    },
    comment(key: string, body: string, o: { bot?: string } = {}) {
      const i = byAny(key)!;
      const at = tick();
      const c: SimComment = { id: uuid(++seq), issueId: i.id, body, createdAt: at, updatedAt: at, user: o.bot ? null : me, botActor: o.bot ? { id: null, name: o.bot, avatarUrl: null } : null };
      comments.push(c);
      i.updatedAt = at;
      return c;
    },
    /** The next n requests are answered "rate limited". */
    rateLimit(n = 1) {
      limited = n;
    },
  };

  // ---------- Rendering and filters ----------

  /** A comment as Linear sends it (the simulator's own bookkeeping left out). */
  const plain = (c: SimComment): LinearComment => ({ id: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, user: c.user, botActor: c.botActor });

  const stateOf = (i: SimIssue) => teams.find((t) => t.id === i.teamId)!.states.find((s) => s.id === i.stateId)!;
  const shown = (i: SimIssue): LinearIssue => {
    const t = teams.find((x) => x.id === i.teamId)!;
    const key = identifier(i);
    const parent = i.parentId ? issues.find((x) => x.id === i.parentId) : undefined;
    return {
      id: i.id,
      identifier: key,
      number: i.number,
      title: i.title,
      url: `https://linear.app/acme/issue/${key}/${slug(i.title)}`,
      priority: i.priority,
      estimate: i.estimate,
      dueDate: i.dueDate,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      archivedAt: i.archivedAt,
      trashed: i.trashed,
      startedAt: i.startedAt,
      completedAt: i.completedAt,
      canceledAt: i.canceledAt,
      state: stateOf(i),
      team: { id: t.id, key: t.key, name: t.name },
      assignee: i.assigneeId ? users.get(i.assigneeId) ?? null : null,
      creator: users.get(i.creatorId) ?? null,
      parent: parent ? { id: parent.id, identifier: identifier(parent) } : null,
      labels: { nodes: i.labels.map((name) => ({ name })), pageInfo: { hasNextPage: false, endCursor: null } },
    };
  };

  type Filter = Record<string, unknown>;
  const obj = (v: unknown): Filter => (v && typeof v === "object" ? (v as Filter) : {});
  /** The comparators the adapter sends, and a few more a real caller would: anything else refuses, as a real schema would. */
  function matches(i: SimIssue, f: Filter): boolean {
    for (const [k, v] of Object.entries(f)) {
      const c = obj(v);
      if (k === "and") {
        if (!(v as Filter[]).every((x) => matches(i, x))) return false;
      } else if (k === "or") {
        if (!(v as Filter[]).some((x) => matches(i, x))) return false;
      } else if (k === "updatedAt") {
        if (typeof c.gte === "string" && !(i.updatedAt >= c.gte)) return false;
        if (typeof c.gt === "string" && !(i.updatedAt > c.gt)) return false;
      } else if (k === "assignee") {
        const isMe = obj(c.isMe);
        if (isMe.eq !== undefined && (i.assigneeId === me.id) !== isMe.eq) return false;
      } else if (k === "subscribers") {
        const some = obj(obj(c.some).isMe);
        if (some.eq !== undefined && i.subscribers.has(me.id) !== some.eq) return false;
      } else if (k === "team") {
        const t = teams.find((x) => x.id === i.teamId)!;
        if (obj(c.id).eq !== undefined && t.id !== obj(c.id).eq) return false;
        if (obj(c.key).eq !== undefined && t.key !== obj(c.key).eq) return false;
      } else if (k === "number") {
        if (obj(v).eq !== undefined && i.number !== obj(v).eq) return false;
      } else throw new Error(`unsupported filter ${k}`);
    }
    return true;
  }

  // ---------- HTTP ----------

  const reset = () => String(Math.ceil(Date.now() / 1000) + 3600);
  const budgets = (cost: number): Record<string, string> => ({
    "x-ratelimit-requests-limit": "5000",
    "x-ratelimit-requests-remaining": "4999",
    "x-ratelimit-requests-reset": reset(),
    "x-ratelimit-complexity-limit": "250000",
    "x-ratelimit-complexity-remaining": String(250000 - cost),
    "x-ratelimit-complexity-reset": reset(),
    "x-complexity": String(cost),
  });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (message: string, type: string, code: string, status = 200, headers: Record<string, string> = {}) => json({ errors: [{ message, extensions: { type, code, userError: true } }], data: null }, status, headers);
  const notFound = (what: string) => fail(`Entity not found: ${what} - Could not find referenced ${what}.`, "invalid input", "INPUT_ERROR");

  type Vars = Record<string, unknown>;
  const cursorOf = (i: SimIssue) => b64(`${i.updatedAt}|${i.id}`);
  /** Newest-updated first, keyset by (updatedAt, id): a cursor survives edits to other items. */
  function pageIssues(list: SimIssue[], first: number, after: string | null) {
    const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const from = after ? sorted.findIndex((i) => `${i.updatedAt}|${i.id}` < unb64(after)) : 0;
    const slice = from < 0 ? [] : sorted.slice(from, from + first);
    const last = slice[slice.length - 1];
    return { nodes: slice.map(shown), pageInfo: { hasNextPage: from >= 0 && from + first < sorted.length, endCursor: last ? cursorOf(last) : null } };
  }
  function pageIndex<T>(list: T[], first: number, after: string | null) {
    const from = after ? Number(unb64(after)) : 0;
    const slice = list.slice(from, from + first);
    return { nodes: slice, pageInfo: { hasNextPage: from + first < list.length, endCursor: slice.length ? b64(String(from + slice.length)) : null } };
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const base = new URL(apiBase);
    if (url.origin !== base.origin || url.pathname !== `${base.pathname.replace(/\/$/, "")}/graphql`) return json({ errors: [{ message: "Not Found" }] }, 404);
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return json({ errors: [{ message: "Method not allowed" }] }, 405);

    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const authorized = !auth ? false : auth.startsWith("Bearer lin_api_") ? false : auth.startsWith("Bearer ") ? oauthTokens.has(auth.slice(7)) : tokens.has(auth);
    if (!authorized) return fail("Authentication required, not authenticated", "authentication error", "AUTHENTICATION_ERROR", 401);

    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { operationName?: string; query?: string; variables?: Vars };
    const op = body.operationName ?? "";
    const v = body.variables ?? {};

    const first = typeof v.first === "number" ? v.first : 50;
    const weighs = ["Issues", "SearchIssues", "Comments", "IssueHistory"].includes(op);
    const cost = 1 + (weighs ? first * NODE_COST : 5);
    calls.push({ operationName: op, cost, authorization: auth });
    if (limited > 0) {
      limited--;
      return fail("Rate limit exceeded", "ratelimited", "RATELIMITED", 400, { ...budgets(cost), "x-ratelimit-requests-remaining": "0" });
    }
    if (first > MAX_PAGE) return fail(`Argument Validation Error: first must not be greater than ${MAX_PAGE}`, "invalid input", "INPUT_ERROR", 400);
    if (cost > COMPLEXITY_LIMIT) return fail(`Query too complex: ${cost} points, the limit is ${COMPLEXITY_LIMIT}`, "invalid input", "QUERY_TOO_COMPLEX", 400, budgets(0));

    const ok = (data: unknown) => json({ data }, 200, budgets(cost));
    const after = typeof v.after === "string" ? v.after : null;

    switch (op) {
      case "Viewer":
        return ok({ viewer: me });
      case "ViewerTeams":
        return ok({ viewer: { id: me.id, teams: pageIndex(teams.filter((t) => t.member).map(({ id, key, name }) => ({ id, key, name })), first, after) } });
      case "TeamStates": {
        const t = teams.find((x) => x.id === v.id);
        return t ? ok({ team: { id: t.id, states: pageIndex(t.states, first, after) } }) : notFound("Team");
      }
      case "Issues":
      case "SearchIssues": {
        const archived = v.includeArchived === true;
        const term = op === "SearchIssues" ? (typeof v.term === "string" ? v.term : "").toLowerCase() : "";
        const list = issues.filter((i) => (archived || (!i.archivedAt && !i.trashed)) && matches(i, obj(v.filter)) && (!term || i.title.toLowerCase().includes(term) || identifier(i).toLowerCase() === term));
        return ok(op === "Issues" ? { issues: pageIssues(list, first, after) } : { searchIssues: pageIssues(list, first, after) });
      }
      case "Issue": {
        const i = byAny(String(v.id));
        return i ? ok({ issue: shown(i) }) : notFound("Issue");
      }
      case "IssueDescription": {
        const i = byAny(String(v.id));
        return i ? ok({ issue: { id: i.id, description: i.description } }) : notFound("Issue");
      }
      case "Comments": {
        const i = byAny(String(v.id));
        if (!i) return notFound("Issue");
        const list = comments.filter((c) => c.issueId === i.id);
        return ok({ issue: { id: i.id, comments: pageIndex(list.map(plain), first, after) } });
      }
      case "IssueHistory": {
        const i = byAny(String(v.id));
        // Newest first, as Linear lists it.
        return i ? ok({ issue: { id: i.id, history: pageIndex([...i.history].reverse(), first, after) } }) : notFound("Issue");
      }
      case "IssueUpdate": {
        const i = byAny(String(v.id));
        if (!i) return notFound("Issue");
        // A trashed issue can't be changed: Linear answers success false, not an error.
        if (i.trashed) return ok({ issueUpdate: { success: false, issue: null } });
        const input = obj(v.input);
        const t = teams.find((x) => x.id === i.teamId)!;
        if (typeof input.stateId === "string") {
          const to = t.states.find((s) => s.id === input.stateId);
          if (!to) return fail("Invalid input: the state does not belong to the issue's team", "invalid input", "INPUT_ERROR");
          const from = stateOf(i);
          i.stateId = to.id;
          i.updatedAt = tick();
          i.startedAt = to.type === "started" ? i.updatedAt : i.startedAt;
          i.completedAt = to.type === "completed" ? i.updatedAt : null;
          i.canceledAt = to.type === "canceled" ? i.updatedAt : null;
          record(i, me, { fromState: { id: from.id, name: from.name }, toState: { id: to.id, name: to.name } });
        }
        return ok({ issueUpdate: { success: true, issue: shown(i) } });
      }
      case "CommentCreate": {
        const input = obj(v.input);
        const i = byAny(String(input.issueId));
        if (!i) return notFound("Issue");
        if (i.trashed) return ok({ commentCreate: { success: false, comment: null } });
        const c = outside.comment(identifier(i), typeof input.body === "string" ? input.body : "");
        return ok({ commentCreate: { success: true, comment: plain(c) } });
      }
      case "IssueSubscribe":
      case "IssueUnsubscribe": {
        const i = byAny(String(v.id));
        if (!i) return notFound("Issue");
        if (op === "IssueSubscribe") i.subscribers.add(me.id);
        else i.subscribers.delete(me.id);
        return ok({ [op === "IssueSubscribe" ? "issueSubscribe" : "issueUnsubscribe"]: { success: true } });
      }
      default:
        return fail(`Cannot query: unmocked operation ${op}`, "invalid input", "INPUT_ERROR", 400);
    }
  }

  /** A webhook delivery as Linear sends it: the raw body, signed (hex HMAC-SHA256) under the secret, stamped `webhookTimestamp` (epoch ms). */
  function webhook(payload: Record<string, unknown>, o: { secret: string; ageMs?: number; signedWith?: string }) {
    const rawBody = JSON.stringify({ ...payload, webhookTimestamp: Date.now() - (o.ageMs ?? 0) });
    return {
      rawBody,
      headers: { "linear-signature": createHmac("sha256", o.signedWith ?? o.secret).update(rawBody).digest("hex"), "linear-delivery": uuid(++seq), "content-type": "application/json" },
    };
  }

  return { apiBase, me, users, addUser, addTeam, team, add, issues, comments, outside, calls, webhook, tokens, oauthTokens, find: byAny, now: () => clock, advance: (ms: number) => void (clock += ms), fetch: handle };
}
