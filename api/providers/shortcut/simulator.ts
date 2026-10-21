// A Shortcut in memory, for tests: the REST v3 endpoints the adapter calls, in
// Shortcut's own shapes and with its documented traps, written from its public
// API documentation (not checked against a real workspace: see SPIKES.md).
//   - the token goes in `Shortcut-Token` (no Bearer); a bad one answers 401
//   - 200 requests a minute; past it, 429 with Retry-After (seconds)
//   - GET /member has its names at the top level, GET /members has them in
//     `profile`; a story names its state, workflow and people by id only
//   - story ids are plain numbers, the same in every URL (sc-123 is a display)
//   - search: GET /search/stories?query=… takes operators (owner:<mention name>,
//     updated:<day>..*, is:archived), pages of at most 25 whose `next` is a
//     path including /api/v3; archived stories only with is:archived; an
//     `updated:` operator counts whole UTC days; an unknown `word:value` is an
//     operator the search refuses, which is why a user's text is quoted
//   - workflow states are typed backlog/unstarted/started/done, no "cancelled";
//     a state of another workflow is refused; follower_ids replaces the list
//   - a story never changed has updated_at null; `deadline` is a date-time at
//     midnight UTC
//   - comments are listed with the deleted ones (deleted: true)
//   - a deleted story is a 404, like one the token can't see
import { randomUUID } from "node:crypto";
import { hmacHex } from "../core/webhooks";
import type { ShortcutChanges, ShortcutComment, ShortcutHistory, ShortcutMe, ShortcutMember, ShortcutRef, ShortcutState, ShortcutStory, ShortcutWorkflow } from "./client";

export const PER_MINUTE = 200;
export const SEARCH_MAX = 25;

type SimState = ShortcutState & { position: number };
type SimWorkflow = { id: number; name: string; states: SimState[] };
type SimComment = ShortcutComment & { storyId: number };
export type SimStory = {
  id: number;
  title: string;
  description: string | null;
  type: string;
  workflowId: number;
  stateId: number;
  owners: string[];
  followers: string[];
  requestedBy: string;
  labels: string[];
  /** A date-time at midnight UTC */
  deadline: string | null;
  estimate: number | null;
  parent: number | null;
  archived: boolean;
  deleted: boolean;
  created: number;
  updated: number | null;
  moved: number | null;
  started: number | null;
  completed: number | null;
  comments: SimComment[];
  history: ShortcutHistory[];
};

const DEFAULT_STATES: [string, string][] = [
  ["Backlog", "backlog"],
  ["To Do", "unstarted"],
  ["In Progress", "started"],
  ["In Review", "started"],
  ["Done", "done"],
];

const uuid = (n: number) => `5f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slugOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function shortcutSimulator(apiBase = "https://api.app.shortcut.com", meOverride?: { name: string; mention: string }) {
  const token = "sc-token-test";
  const workspace = "acme";
  const members = new Map<string, ShortcutMember>();
  const addMember = (name: string, mention = name.split(" ")[0].toLowerCase(), o: { disabled?: boolean } = {}): string => {
    const id = uuid(members.size + 1);
    members.set(id, { id, disabled: o.disabled ?? false, profile: { name, mention_name: mention, email_address: `${mention}@acme.example`, display_icon: { url: `https://avatars.example/${mention}.png` }, deactivated: o.disabled ?? false } });
    return id;
  };
  const meId = addMember(meOverride?.name ?? "Mario Rossi", meOverride?.mention ?? "mario");
  const otherId = addMember("Anna Bianchi", "anna");
  const me: ShortcutMe = {
    id: meId,
    name: members.get(meId)!.profile.name ?? "",
    mention_name: members.get(meId)!.profile.mention_name,
    role: "member",
    workspace2: { url_slug: workspace },
  };

  let seq = 500;
  let stateSeq = 700;
  const workflows: SimWorkflow[] = [];
  const stories: SimStory[] = [];
  // Strictly increasing and never behind the real clock, so "changed since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  // What existed before the test began is dated hours ago, one second apart.
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  const iso = (ms: number) => new Date(ms).toISOString();
  const state = { revoked: false, perMinute: PER_MINUTE, limited: 0 };
  const calls: { method: string; path: string; token: string | null; authorization: string | null }[] = [];
  const windowCalls: number[] = [];

  const addWorkflow = (name: string, states: [string, string][] = DEFAULT_STATES): SimWorkflow => {
    const w: SimWorkflow = { id: ++seq, name, states: states.map(([n, type], i) => ({ id: ++stateSeq, name: n, type, position: (i + 1) * 1024, color: null })) };
    workflows.push(w);
    return w;
  };
  const workflow = (name: string) => workflows.find((w) => w.name === name)!;
  addWorkflow("Default");
  const stateIn = (w: SimWorkflow, name: string) => w.states.find((s) => s.name === name)!;
  const find = (id: number) => stories.find((s) => s.id === id)!;
  const wfOf = (s: SimStory) => workflows.find((w) => w.id === s.workflowId)!;
  const stateOf = (s: SimStory) => wfOf(s).states.find((x) => x.id === s.stateId)!;

  const add = (
    title: string,
    o: { workflow?: string; state?: string; owners?: string[]; type?: string; description?: string; deadline?: string; estimate?: number; labels?: string[]; requestedBy?: string; parent?: number; archived?: boolean } = {},
  ): SimStory => {
    const w = o.workflow ? workflow(o.workflow) : workflows[0];
    const at = earlier();
    const st = o.state ? stateIn(w, o.state) : w.states[0];
    const s: SimStory = {
      id: ++seq,
      title,
      description: o.description ?? null,
      type: o.type ?? "feature",
      workflowId: w.id,
      stateId: st.id,
      owners: o.owners ?? [meId],
      followers: [],
      requestedBy: o.requestedBy ?? meId,
      labels: o.labels ?? [],
      deadline: o.deadline ? `${o.deadline}T00:00:00Z` : null,
      estimate: o.estimate ?? null,
      parent: o.parent ?? null,
      archived: o.archived ?? false,
      deleted: false,
      created: at,
      // Never changed: no update time.
      updated: null,
      moved: null,
      started: st.type === "started" ? at : null,
      completed: st.type === "done" ? at : null,
      comments: [],
      history: [],
    };
    stories.push(s);
    return s;
  };

  // ---------- Changes, whoever makes them ----------

  const refsOf = (changes: ShortcutChanges): ShortcutRef[] => {
    const out: ShortcutRef[] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (k === "workflow_state_id") {
        for (const id of [v.old, v.new]) {
          const st = workflows.flatMap((w) => w.states).find((x) => x.id === id);
          if (st) out.push({ id: st.id, entity_type: "workflow-state", name: st.name });
        }
      }
      if (k === "label_ids") for (const id of [...(v.adds ?? []), ...(v.removes ?? [])]) out.push({ id: Number(id), entity_type: "label", name: labelNames.get(Number(id)) ?? "" });
    }
    return out;
  };
  const record = (s: SimStory, by: string, changes: ShortcutChanges) => {
    s.history.push({ id: randomUUID(), changed_at: iso(now()), member_id: by, actions: [{ id: ++seq, entity_type: "story", action: "update", changes }], references: refsOf(changes) });
    s.updated = now();
  };
  const setState = (s: SimStory, stateId: number, by = meId) => {
    if (s.stateId === stateId) return;
    const was = s.stateId;
    s.stateId = stateId;
    const type = stateOf(s).type;
    s.moved = now();
    if (type === "started" && !s.started) s.started = now();
    s.completed = type === "done" ? now() : null;
    record(s, by, { workflow_state_id: { old: was, new: stateId } });
  };
  const setOwners = (s: SimStory, owners: string[], by = meId) => {
    const adds = owners.filter((o) => !s.owners.includes(o));
    const removes = s.owners.filter((o) => !owners.includes(o));
    s.owners = owners;
    record(s, by, { owner_ids: { adds, removes } });
  };
  const setTitle = (s: SimStory, title: string, by = meId) => {
    const was = s.title;
    s.title = title;
    record(s, by, { name: { old: was, new: title } });
  };

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const outside = {
    setState(id: number, name: string, by = otherId) {
      const s = find(id);
      setState(s, stateIn(wfOf(s), name).id, by);
    },
    retitle: (id: number, title: string, by = otherId) => setTitle(find(id), title, by),
    assign: (id: number, owners: string[], by = otherId) => setOwners(find(id), owners, by),
    label(id: number, name: string, by = otherId) {
      const s = find(id);
      s.labels = [...s.labels, name];
      record(s, by, { label_ids: { adds: [labelId(name)], removes: [] } });
    },
    archive(id: number, by = otherId) {
      const s = find(id);
      s.archived = true;
      record(s, by, { archived: { old: false, new: true } });
    },
    unarchive(id: number, by = otherId) {
      const s = find(id);
      s.archived = false;
      record(s, by, { archived: { old: true, new: false } });
    },
    /** A hard delete: the story is a 404 from now on, and no search finds it. */
    delete(id: number) {
      find(id).deleted = true;
    },
    follow(id: number, member: string) {
      const s = find(id);
      s.followers = [...s.followers, member];
      s.updated = now();
    },
    comment(id: number, text: string, o: { by?: string | null; external?: string } = {}) {
      const s = find(id);
      const c: SimComment = { id: ++seq, storyId: id, author_id: o.by === undefined ? otherId : o.by, text, created_at: iso(now()), updated_at: iso(now()), deleted: false, ...(o.external ? { external_id: o.external } : {}) };
      s.comments.push(c);
      s.updated = now();
      return c;
    },
    /** Soft-deleted: still listed, marked. */
    deleteComment(id: number, commentId: number) {
      const c = find(id).comments.find((x) => x.id === commentId)!;
      c.deleted = true;
      c.text = null;
    },
    /** To another workflow: the same story id, the new workflow's first state. */
    moveToWorkflow(id: number, name: string, by = otherId) {
      const s = find(id);
      const to = workflow(name);
      const was = { workflow: s.workflowId, state: s.stateId };
      s.workflowId = to.id;
      s.stateId = to.states[0].id;
      s.moved = now();
      record(s, by, { workflow_id: { old: was.workflow, new: to.id }, workflow_state_id: { old: was.state, new: s.stateId } });
    },
    /** A change with no history worth reading (an edit in the description, say). */
    touch(id: number) {
      find(id).updated = now();
    },
    /** The next requests answer 429, whatever the budget. */
    rateLimit(n = 1) {
      state.limited = n;
    },
  };
  const labelNames = new Map<number, string>();
  function labelId(name: string): number {
    const id = 9000 + [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    labelNames.set(id, name);
    return id;
  }

  // ---------- Shapes ----------

  const appUrl = (s: SimStory) => `https://app.shortcut.com/${workspace}/story/${s.id}/${slugOf(s.title)}`;
  const shown = (s: SimStory): ShortcutStory => {
    const type = stateOf(s).type;
    return {
      id: s.id,
      name: s.title,
      description: s.description,
      story_type: s.type,
      app_url: appUrl(s),
      workflow_id: s.workflowId,
      workflow_state_id: s.stateId,
      owner_ids: [...s.owners],
      follower_ids: [...s.followers],
      requested_by_id: s.requestedBy,
      labels: s.labels.map((name) => ({ id: labelId(name), name })),
      deadline: s.deadline,
      estimate: s.estimate,
      archived: s.archived,
      started: s.started !== null,
      completed: type === "done",
      started_at: s.started === null ? null : iso(s.started),
      completed_at: s.completed === null ? null : iso(s.completed),
      moved_at: s.moved === null ? null : iso(s.moved),
      created_at: iso(s.created),
      updated_at: s.updated === null ? null : iso(s.updated),
      parent_story_id: s.parent,
    };
  };
  const visible = (s: SimStory | undefined): s is SimStory => !!s && !s.deleted;

  // ---------- Search ----------

  const tokens = (query: string) => query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const unquote = (v: string) => v.replace(/^"|"$/g, "");

  /** null: the query is refused (an operator the search doesn't know). */
  function matcher(query: string): { test: (s: SimStory) => boolean; archivedOnly: boolean } | { error: string } {
    const tests: ((s: SimStory) => boolean)[] = [];
    let archivedOnly = false;
    for (const t of tokens(query)) {
      const op = /^([a-z-]+):(.+)$/i.exec(t);
      if (!op) {
        const words = unquote(t).toLowerCase();
        tests.push((s) => `${s.title} ${s.description ?? ""}`.toLowerCase().includes(words));
        continue;
      }
      const name = op[1].toLowerCase();
      const value = unquote(op[2]);
      if (name === "owner") {
        const who = [...members.values()].find((m) => m.profile.mention_name.toLowerCase() === value.toLowerCase());
        tests.push((s) => !!who && s.owners.includes(who.id));
      } else if (name === "is") {
        if (value === "archived") archivedOnly = true;
        else if (value !== "story") return { error: `Unknown search value "is:${value}"` };
      } else if (name === "updated") {
        const [from, to] = value.includes("..") ? value.split("..") : [value, value];
        tests.push((s) => {
          const day = iso(s.updated ?? s.created).slice(0, 10);
          return (from === "*" || day >= from) && (to === "*" || day <= to);
        });
      } else if (name === "state") tests.push((s) => stateOf(s).name.toLowerCase() === value.toLowerCase());
      else if (name === "type") tests.push((s) => s.type === value.toLowerCase());
      else return { error: `Unknown search operator "${name}"` };
    }
    return { test: (s) => tests.every((f) => f(s)), archivedOnly };
  }

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
  const unprocessable = (...errors: string[]) => json({ message: "Unprocessable", errors, tag: "unprocessable" }, 400);
  const missing = () => json({ message: "Resource does not exist.", tag: "not_found" }, 404);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, path: `${url.pathname}${url.search}`, token: headers.get("shortcut-token"), authorization: headers.get("authorization") });

    if (headers.get("shortcut-token") !== token || state.revoked) return json({ message: "Unauthorized" }, 401);
    // The budget: a minute's worth of calls; past it, wait for the oldest to leave the window.
    const t = Date.now();
    while (windowCalls.length && windowCalls[0] <= t - 60_000) windowCalls.shift();
    if (state.limited > 0 || windowCalls.length >= state.perMinute) {
      const wait = state.limited > 0 ? 30 : Math.max(1, Math.ceil((windowCalls[0] + 60_000 - t) / 1000));
      if (state.limited > 0) state.limited--;
      return json({ message: "Rate limit exceeded.", tag: "rate_limited" }, 429, { "Retry-After": String(wait) });
    }
    windowCalls.push(t);

    const root = new URL(apiBase).pathname.replace(/\/$/, "") + "/api/v3";
    if (!url.pathname.startsWith(`${root}/`)) return missing();
    const path = url.pathname.slice(root.length);

    if (path === "/member") return json(me);
    if (path === "/members") return json([...members.values()]);
    if (path === "/workflows") return json(workflows.map((w): ShortcutWorkflow => ({ id: w.id, name: w.name, states: w.states.map((s) => ({ ...s })), default_state_id: w.states[0].id })));

    if (path === "/search/stories") {
      const query = url.searchParams.get("query");
      if (!query) return unprocessable("query is required");
      const size = Number(url.searchParams.get("page_size") ?? SEARCH_MAX);
      if (!Number.isInteger(size) || size < 1 || size > SEARCH_MAX) return unprocessable(`page_size must be between 1 and ${SEARCH_MAX}`);
      const m = matcher(query);
      if ("error" in m) return unprocessable(m.error);
      // Archived stories only with is:archived; newest-updated first.
      const rows = stories
        .filter((s) => !s.deleted && s.archived === m.archivedOnly && m.test(s))
        .sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created) || b.id - a.id);
      const cursor = url.searchParams.get("next");
      const from = cursor ? (JSON.parse(unb64(cursor)) as { o: number }).o : 0;
      const end = Math.min(rows.length, from + size);
      const more = new URLSearchParams({ query, page_size: String(size), next: b64(JSON.stringify({ o: end })) });
      return json({ total: rows.length, data: rows.slice(from, end).map(shown), next: end < rows.length ? `${root}/search/stories?${more.toString()}` : null });
    }

    const m = /^\/stories\/(\d+)(?:\/(comments|history))?$/.exec(path);
    if (!m) return json({ message: `unmocked ${method} ${path}` }, 404);
    const s = stories.find((x) => x.id === Number(m[1]));
    if (!visible(s)) return missing();

    if (m[2] === "comments") {
      if (method === "POST") {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text) return unprocessable("text is required");
        const c: SimComment = { id: ++seq, storyId: s.id, author_id: meId, text, created_at: iso(now()), updated_at: iso(now()), deleted: false };
        s.comments.push(c);
        s.updated = now();
        return json(c, 201);
      }
      return json(s.comments);
    }
    if (m[2] === "history") return json(s.history);

    if (method === "PUT") {
      if ("workflow_state_id" in body) {
        const id = Number(body.workflow_state_id);
        const own = wfOf(s).states.some((x) => x.id === id);
        if (!own) {
          const known = workflows.some((w) => w.states.some((x) => x.id === id));
          return unprocessable(known ? "workflow_state_id does not belong to the story's workflow" : "workflow_state_id is not a workflow state");
        }
        setState(s, id);
      }
      if (typeof body.name === "string") setTitle(s, body.name);
      if (typeof body.description === "string") {
        s.description = body.description;
        s.updated = now();
      }
      if (Array.isArray(body.follower_ids)) {
        // Replaces the list.
        s.followers = body.follower_ids.map(String);
        s.updated = now();
      }
      if (typeof body.archived === "boolean") s.archived = body.archived;
    }
    return json(shown(s));
  }

  /** A webhook delivery as Shortcut sends it: the payload (with its own id and time), signed with the secret. */
  const webhook = (actions: unknown[], o: { secret: string; signedWith?: string; ageMs?: number; storyId?: number } = { secret: "" }) => {
    const rawBody = JSON.stringify({ id: randomUUID(), changed_at: iso(Date.now() - (o.ageMs ?? 0)), version: "v1", primary_id: o.storyId ?? null, member_id: otherId, actions, references: [] });
    return { rawBody, headers: { "payload-signature": hmacHex(o.signedWith ?? o.secret, rawBody), "content-type": "application/json" } as Record<string, string> };
  };

  return {
    apiBase,
    token,
    me,
    meId,
    otherId,
    members,
    workflows,
    stories,
    state,
    calls,
    addMember,
    addWorkflow,
    workflow,
    add,
    find,
    outside,
    keyOf: (s: SimStory) => `sc-${s.id}`,
    urlOf: appUrl,
    /** The story as the API prints it. */
    shown,
    now,
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    webhook,
    fetch: handle,
  };
}
