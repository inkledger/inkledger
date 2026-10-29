// Linear as a tracker, through the provider contract. Issues assigned to the
// user, keyed by Linear's display identifier (ENG-123); their status is the
// team's workflow state, categorized by the state's `type` (never its name,
// which is the team's own words). Linear keeps no time inkledger can use
// (estimates are points): the time stays in inkledger's own register.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, type Instant, type JsonValue } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { ActiveWorkflowSource, CallContext, ChangeValue, IssueHandle, RemoteChange, RemoteComment, RemoteIssue, RemotePerson, RemoteStatus, TrackerProvider, Transition } from "../types";
import { ISSUE_FIELDS, allNodes, gql, gqlRaw, type Connection, type LinearComment, type LinearCreds, type LinearIssue, type LinearState, type LinearTeam, type LinearUser } from "./client";
import { statusSteps } from "../core/statusSteps";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

export const linearCapabilities: TrackerCapabilities = {
  // The team's workflow states; any state can be moved to from any other.
  workflow: { sources: [{ kind: "itemState", transitions: "direct" }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["commonmark"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: true,
  history: true,
  statusHistory: true,
  time: { mode: "local", remoteTotals: false },
  sync: {
    issueCheckpoints: true,
    // Trashed issues are reported; so is an issue the user was subscribed to that someone else now holds (spikes: Linear, departures).
    gone: { deleted: true, lostAccess: false, movedOut: true, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const linearTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: true,
  devLinks: true,
  attachments: { read: true, upload: true },
  timeboxes: ["cycle"],
  fields: ["priority", "due", "estimate", "points", "labels"],
};

const optionsSchema = z.strictObject({});
export type LinearOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"linear", LinearOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** Where a pass is: the user's issues ("feed"), then, on an incremental pass, those that left them ("gone"). */
type PageAt = { phase: "feed" | "gone"; after: string | null; at: number };

/** Overlap read again at each pass: updates may land while a pass runs (the list is newest first). */
const OVERLAP_MS = 60_000;
/** Linear allows 250 per page, but a page's weight counts against a 10,000-point complexity cap per query. */
const PER_PAGE = 50;

async function credsOf(x: X): Promise<LinearCreds> {
  const cred = await x.conn.credential();
  return { apiBase: x.conn.baseUrl, token: secretOf(cred), oauth: cred.kind === "oauth" };
}

/** ENG-123: the team key (letters and digits, up to 7, starting with a letter), a dash, the number. */
export const ISSUE_KEY = /^([A-Za-z][A-Za-z0-9]{0,6})-(\d{1,9})$/;
const normalizeKey = (raw: string) => {
  const m = ISSUE_KEY.exec(raw.trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
};

const CATEGORY: Record<LinearState["type"], StatusCategory> = { triage: "triage", backlog: "backlog", unstarted: "todo", started: "doing", completed: "done", canceled: "cancelled" };

/** A workflow state as a status; the team is its source (states belong to one team). */
export const statusOf = (s: LinearState, teamId: string): RemoteStatus => ({
  id: s.id,
  name: s.name,
  category: CATEGORY[s.type] ?? "todo",
  categoryOrigin: { by: "native" },
  source: { kind: "itemState", containerRemoteId: teamId },
  nativeReason: s.type,
  ...(s.color ? { color: s.color } : {}),
  ...(s.position != null ? { order: s.position } : {}),
});

const person = (u: LinearUser): RemotePerson => ({ remoteId: u.id, name: u.name || u.displayName || "", avatarUrl: u.avatarUrl ?? null, ...(u.displayName ? { handle: u.displayName } : {}) });

/** 1 urgent … 4 low on the coarse 0–4 scale shared by every provider; 0 is "no priority", not the lowest. */
const PRIORITIES: Record<number, { name: string; rank: number }> = { 1: { name: "Urgent", rank: 0 }, 2: { name: "High", rank: 1 }, 3: { name: "Medium", rank: 3 }, 4: { name: "Low", rank: 4 } };
const priorityOf = (n: number) => (PRIORITIES[n] ? { id: String(n), name: PRIORITIES[n].name, rank: PRIORITIES[n].rank } : null);

export function toRemoteIssue(i: LinearIssue): RemoteIssue {
  const t = i.state.type;
  const changed = t === "completed" ? i.completedAt : t === "canceled" ? i.canceledAt : t === "started" ? i.startedAt : null;
  return {
    remoteId: i.id,
    key: i.identifier,
    url: i.url,
    title: i.title,
    type: { id: "issue", name: "Issue", level: i.parent ? "sub" : "standard" },
    status: statusOf(i.state, i.team.id),
    container: { remoteId: i.team.id, key: i.team.key, name: i.team.name, kind: "team" },
    priority: priorityOf(i.priority),
    labels: (i.labels?.nodes ?? []).map((l) => l.name),
    assignees: i.assignee ? [person(i.assignee)] : [],
    reporter: i.creator ? person(i.creator) : null,
    // A date without a zone: kept as the day it says.
    due: i.dueDate ? localDate(i.dueDate.slice(0, 10)) : null,
    estimateSeconds: null,
    createdAt: instantFrom(i.createdAt),
    updatedAt: instantFrom(i.updatedAt),
    statusChangedAt: instantFrom(changed ?? null),
    parent: i.parent ? { remoteId: i.parent.id, key: i.parent.identifier } : null,
    ...(i.estimate != null ? { fields: { estimate: i.estimate } satisfies Record<string, JsonValue> } : {}),
  };
}

const toRemoteComment = (c: LinearComment): RemoteComment => ({
  id: c.id,
  // An integration's comment has no user, only a bot actor.
  author: c.user ? person(c.user) : { remoteId: `bot:${c.botActor?.id ?? c.botActor?.name ?? "linear"}`, name: c.botActor?.name ?? "Linear", avatarUrl: c.botActor?.avatarUrl ?? null },
  body: { kind: "text", format: "commonmark", text: c.body },
  createdAt: instantFrom(c.createdAt),
  updatedAt: instantFrom(c.updatedAt),
});

const ISSUE_BY_ID = `${ISSUE_FIELDS}
query Issue($id: String!) { issue(id: $id) { ...IssueFields } }`;

/** An issue by id or identifier (Linear resolves a moved issue's old identifier too: the new key comes back). */
async function issueBy(creds: LinearCreds, idOrKey: string): Promise<LinearIssue | null> {
  const r = await gqlRaw<{ issue: LinearIssue | null }>(creds, "Issue", ISSUE_BY_ID, { id: idOrKey }, { missingIsNull: true });
  const i = r.data?.issue ?? null;
  return i && !i.trashed ? i : null;
}

const ISSUES = `${ISSUE_FIELDS}
query Issues($filter: IssueFilter, $first: Int, $after: String, $includeArchived: Boolean) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, orderBy: updatedAt) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}`;

const SEARCH = `${ISSUE_FIELDS}
query SearchIssues($term: String!, $first: Int) {
  searchIssues(term: $term, first: $first) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATE_FIELDS = "id name type color position";
const TEAM_STATES = `query TeamStates($id: String!, $after: String) { team(id: $id) { id states(first: 100, after: $after) { nodes { ${STATE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;

async function teamStates(creds: LinearCreds, teamId: string): Promise<LinearState[]> {
  return allNodes((after) => gql<{ team: { states: Connection<LinearState> } }>(creds, "TeamStates", TEAM_STATES, { id: teamId, after }).then((d) => d.team.states));
}

const VIEWER_TEAMS = `query ViewerTeams($after: String) { viewer { id teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } } }`;

/** A mutation's `success`: false is an answer (HTTP 200), not an error. */
function succeeded<T extends { success: boolean }>(r: T | null | undefined, what: string): T {
  if (!r?.success) throw new ProviderError("invalid", `Linear refused ${what}`);
  return r;
}

export const linearProvider: TrackerProvider<"linear", LinearOptions> = {
  // Deliveries signed with the secret (Linear-Signature), refused past a minute old.
  webhook: {
    verify: (req, secret) => linearWebhook.verify({ secret, rawBody: req.body, headers: new Headers(req.headers) }),
    deliveryId: (req) => linearWebhook.deliveryId(new Headers(req.headers)),
    sentAt: (req) => linearWebhook.sentAt(req.body),
  },
  role: "tracker",
  type: "linear",
  capabilities: linearCapabilities,
  traits: linearTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Linear options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, text): IssueHandle | null {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      // https://linear.app/<workspace>/issue/ENG-123/<slug>: the slug follows the title, only the key counts.
      const url = new URL(text.trim());
      if (url.origin !== "https://linear.app") return null;
      const m = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]{0,6}-\d{1,9})(?:\/[^/]*)?\/?$/.exec(url.pathname);
      const k = m ? normalizeKey(m[1]) : null;
      return k ? { key: k } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const d = await gql<{ viewer: LinearUser }>(await credsOf(x), "Viewer", "query Viewer { viewer { id name displayName email avatarUrl } }");
    return { ...person(d.viewer), ...(d.viewer.displayName ? { login: d.viewer.displayName } : {}), ...(d.viewer.email ? { email: d.viewer.email } : {}) };
  },

  async probe(x) {
    const creds = await credsOf(x);
    const teams = await allNodes((after) => gql<{ viewer: { teams: Connection<LinearTeam> } }>(creds, "ViewerTeams", VIEWER_TEAMS, { after }).then((d) => d.viewer.teams));
    // One source per team (states are the team's); an account in no team still has the workflow kind.
    const activeSources: ActiveWorkflowSource[] = teams.length
      ? teams.map((t) => ({ kind: "itemState", transitions: "direct", ref: { kind: "itemState", containerRemoteId: t.id }, name: t.name }))
      : [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Linear workflow" }];
    // The documented budget of a personal key: 5,000 requests an hour (and a complexity budget beside it).
    const headers = (await gqlRaw<unknown>(creds, "Viewer", "query Viewer { viewer { id } }")).headers;
    const limit = Number(headers.get("x-ratelimit-requests-limit"));
    return {
      capabilities: linearCapabilities,
      activeSources,
      rateLimit: Number.isInteger(limit) && limit > 0 ? { perHour: limit, origin: "detected" } : { perHour: 5000, origin: "typical" },
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const at: PageAt = decodePageToken<PageAt>(x.conn, "issues", V, q.since, q.page) ?? { phase: "feed", after: null, at: Date.now() };
    const updated = since === null ? {} : { updatedAt: { gte: new Date(since).toISOString() } };
    const filter = at.phase === "feed" ? { assignee: { isMe: { eq: true } }, ...updated } : { subscribers: { some: { isMe: { eq: true } } }, ...updated };
    // Archived and trashed issues are only listed when asked; a first read has no use for them.
    const d = await gql<{ issues: Connection<LinearIssue> }>(creds, "Issues", ISSUES, { filter, first: PER_PAGE, after: at.after, includeArchived: since !== null });
    const nodes = d.issues.nodes;

    const items: RemoteIssue[] = [];
    const gone: ({ remoteId: string; reason: "deleted" } | { remoteId: string; reason: "movedOut" })[] = [];
    for (const i of nodes) {
      if (at.phase === "feed") {
        if (i.trashed) gone.push({ remoteId: i.id, reason: "deleted" });
        else if (!i.archivedAt) items.push(toRemoteIssue(i));
      } else if (i.assignee?.id !== x.conn.remoteAccountId) {
        // Followed by the user, held by someone else now (or in the trash).
        gone.push({ remoteId: i.id, reason: i.trashed ? "deleted" : "movedOut" });
      }
    }

    const next = (p: PageAt) => ({ last: false as const, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, p) });
    if (d.issues.pageInfo.hasNextPage) return next({ ...at, after: d.issues.pageInfo.endCursor });
    // Whoever lost an issue shows only in an incremental pass: a first read has nothing to take away.
    if (at.phase === "feed" && since !== null) return next({ phase: "gone", after: null, at: at.at });
    return { last: true as const, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const i = await issueBy(await credsOf(x), ref.remoteId || ref.key);
    return i ? toRemoteIssue(i) : null;
  },

  async findIssue(x, handle) {
    const i = await issueBy(await credsOf(x), handle.remoteId ?? handle.key ?? "");
    return i ? { kind: "found", issue: toRemoteIssue(i) } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    // A page of 100 weighs about 4,500 points of the 10,000 a query may carry.
    const first = Math.min(100, Math.max(1, limit));
    const d = await gql<{ searchIssues: Connection<LinearIssue> }>(await credsOf(x), "SearchIssues", SEARCH, { term: text.trim(), first });
    const items = d.searchIssues.nodes.filter((i) => !i.trashed).slice(0, limit).map(toRemoteIssue);
    return { items, complete: !d.searchIssues.pageInfo.hasNextPage };
  },

  async statuses(x, source) {
    const creds = await credsOf(x);
    const team = source.ref.kind === "itemState" ? source.ref.containerRemoteId : undefined;
    if (team) return (await teamStates(creds, team)).map((s) => statusOf(s, team));
    const teams = await allNodes((after) => gql<{ viewer: { teams: Connection<LinearTeam> } }>(creds, "ViewerTeams", VIEWER_TEAMS, { after }).then((d) => d.viewer.teams));
    return (await Promise.all(teams.map(async (t) => (await teamStates(creds, t.id)).map((s) => statusOf(s, t.id))))).flat();
  },

  async description(x, ref) {
    const d = await gqlRaw<{ issue: { description?: string | null } | null }>(await credsOf(x), "IssueDescription", "query IssueDescription($id: String!) { issue(id: $id) { id description } }", { id: ref.remoteId || ref.key }, { missingIsNull: true });
    const text = d.data?.issue?.description;
    return text ? { kind: "text", format: "commonmark", text } : null;
  },

  transitions: {
    async list(x, ref) {
      const creds = await credsOf(x);
      const i = await issueBy(creds, ref.remoteId || ref.key);
      if (!i) throw new ProviderError("notFound", `Linear: no issue ${ref.key}`);
      // Any state of the issue's team, from any state: Linear has no transition table.
      return (await teamStates(creds, i.team.id))
        .filter((s) => s.id !== i.state.id)
        .map<Transition>((s) => ({ id: s.id, name: s.name, to: statusOf(s, i.team.id), requirements: [], remoteUrl: i.url }));
    },
    async apply(x, ref, transitionId) {
      const d = await gql<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(
        await credsOf(x),
        "IssueUpdate",
        `${ISSUE_FIELDS}
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ...IssueFields } } }`,
        { id: ref.remoteId || ref.key, input: { stateId: transitionId } },
        { write: true },
      );
      const r = succeeded(d.issueUpdate, `moving ${ref.key}`);
      return r.issue ? toRemoteIssue(r.issue) : null;
    },
  },

  comments: {
    async list(x, ref) {
      const creds = await credsOf(x);
      const q = `query Comments($id: String!, $after: String) { issue(id: $id) { id comments(first: 100, after: $after) { nodes { id body createdAt updatedAt user { id name displayName email avatarUrl } botActor { id name avatarUrl } } pageInfo { hasNextPage endCursor } } } }`;
      const nodes = await allNodes((after) => gql<{ issue: { comments: Connection<LinearComment> } }>(creds, "Comments", q, { id: ref.remoteId || ref.key, after }).then((d) => d.issue.comments));
      return nodes.map(toRemoteComment);
    },
    async add(x, ref, body) {
      // Linear's comments are Markdown: CommonMark goes as is.
      const d = await gql<{ commentCreate: { success: boolean; comment: LinearComment | null } }>(
        await credsOf(x),
        "CommentCreate",
        `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt updatedAt user { id name displayName email avatarUrl } botActor { id name avatarUrl } } } }`,
        { input: { issueId: ref.remoteId || ref.key, body } },
        { write: true },
      );
      const r = succeeded(d.commentCreate, "the comment");
      return { comment: r.comment ? toRemoteComment(r.comment) : null, warnings: [] };
    },
  },

  async watch(x, ref, on) {
    const op = on ? "issueSubscribe" : "issueUnsubscribe";
    const name = on ? "IssueSubscribe" : "IssueUnsubscribe";
    const d = await gql<Record<string, { success: boolean }>>(await credsOf(x), name, `mutation ${name}($id: String!) { ${op}(id: $id) { success } }`, { id: ref.remoteId || ref.key }, { write: true });
    succeeded(d[op], on ? "subscribing" : "unsubscribing");
  },

  async statusHistory(x, ref) {

    return statusSteps(await linearProvider.history!(x, ref), (c) => c.field.id === "state");

  },


  async history(x, ref) {
    const creds = await credsOf(x);
    const q = `query IssueHistory($id: String!, $after: String) { issue(id: $id) { id history(first: 50, after: $after) { nodes { id createdAt
      actor { id name displayName avatarUrl }
      fromState { id name } toState { id name }
      fromAssignee { id name displayName } toAssignee { id name displayName }
      fromPriority toPriority fromTitle toTitle fromEstimate toEstimate fromDueDate toDueDate
      addedLabels { id name } removedLabels { id name }
    } pageInfo { hasNextPage endCursor } } } }`;
    const nodes = await allNodes((after) => gql<{ issue: { history: Connection<HistoryNode> } }>(creds, "IssueHistory", q, { id: ref.remoteId || ref.key, after }).then((d) => d.issue.history));
    return nodes.flatMap(toChanges).sort((a, b) => a.at - b.at);
  },
};

type Named = { id?: string; name: string; displayName?: string | null };
type HistoryNode = {
  id: string;
  createdAt: string;
  actor?: LinearUser | null;
  fromState?: Named | null;
  toState?: Named | null;
  fromAssignee?: Named | null;
  toAssignee?: Named | null;
  fromPriority?: number | null;
  toPriority?: number | null;
  fromTitle?: string | null;
  toTitle?: string | null;
  fromEstimate?: number | null;
  toEstimate?: number | null;
  fromDueDate?: string | null;
  toDueDate?: string | null;
  addedLabels?: Named[] | null;
  removedLabels?: Named[] | null;
};

const val = (n: Named | null | undefined): ChangeValue[] => (n ? [{ text: n.displayName || n.name, ...(n.id ? { id: n.id } : {}) }] : []);
const some = (v: string | number | null | undefined, text = String(v)): ChangeValue[] => (v === null || v === undefined || v === "" ? [] : [{ text, raw: v }]);

/** One history entry may change several fields at once: one change per field. */
export function toChanges(h: HistoryNode): RemoteChange[] {
  const at = instantFrom(h.createdAt);
  if (at === null) return [];
  const actor = h.actor ? person(h.actor) : null;
  const out: RemoteChange[] = [];
  const push = (field: RemoteChange["field"], from: ChangeValue[], to: ChangeValue[]) => out.push({ at, actor, field, from, to });
  if (h.fromState || h.toState) push({ id: "state", name: "Status" }, val(h.fromState), val(h.toState));
  if (h.fromAssignee || h.toAssignee) push({ id: "assignee", name: "Assignee" }, val(h.fromAssignee), val(h.toAssignee));
  if (h.fromPriority !== undefined && h.fromPriority !== null && h.toPriority !== undefined && h.toPriority !== null && h.fromPriority !== h.toPriority) {
    const label = (n: number) => PRIORITIES[n]?.name ?? "No priority";
    push({ id: "priority", name: "Priority" }, [{ text: label(h.fromPriority), id: String(h.fromPriority) }], [{ text: label(h.toPriority), id: String(h.toPriority) }]);
  }
  if (h.fromTitle != null || h.toTitle != null) push({ id: "title", name: "Title" }, some(h.fromTitle), some(h.toTitle));
  if (h.fromEstimate != null || h.toEstimate != null) push({ id: "estimate", name: "Estimate" }, some(h.fromEstimate), some(h.toEstimate));
  if (h.fromDueDate != null || h.toDueDate != null) push({ id: "dueDate", name: "Due date" }, some(h.fromDueDate), some(h.toDueDate));
  if (h.addedLabels?.length || h.removedLabels?.length) push({ id: "labels", name: "Labels" }, (h.removedLabels ?? []).flatMap((l) => val(l)), (h.addedLabels ?? []).flatMap((l) => val(l)));
  return out;
}

// ---------- Webhooks ----------

/** Linear refuses nothing itself: a delivery older than this is a replay and is refused here. */
export const WEBHOOK_MAX_AGE_MS = 60_000;

type HeaderSource = Headers | Record<string, string | string[] | undefined>;
const header = (h: HeaderSource, name: string): string | undefined => {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const hit = Object.entries(h).find(([k]) => k.toLowerCase() === name);
  return Array.isArray(hit?.[1]) ? hit[1][0] : hit?.[1];
};

/**
 * Linear's webhooks: `Linear-Signature` is the hex HMAC-SHA256 of the raw
 * body under the webhook's signing secret, `Linear-Delivery` the delivery id,
 * and the body's `webhookTimestamp` (epoch ms) is what makes a replay
 * detectable. The raw body, never a re-serialized one.
 */
export const linearWebhook = {
  verify(a: { secret: string; rawBody: string; headers: HeaderSource; now?: number }): boolean {
    const given = header(a.headers, "linear-signature");
    if (!given || !/^[0-9a-f]{64}$/i.test(given)) return false;
    const expected = createHmac("sha256", a.secret).update(a.rawBody).digest();
    const got = Buffer.from(given, "hex");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
    const sent = linearWebhook.sentAt(a.rawBody);
    return sent !== null && Math.abs((a.now ?? Date.now()) - sent) <= WEBHOOK_MAX_AGE_MS;
  },
  deliveryId(headers: HeaderSource): string | null {
    return header(headers, "linear-delivery") ?? null;
  },
  sentAt(rawBody: string): Instant | null {
    try {
      const t = (JSON.parse(rawBody) as { webhookTimestamp?: unknown }).webhookTimestamp;
      return typeof t === "number" && Number.isInteger(t) && t > 0 ? instant(t) : null;
    } catch {
      return null;
    }
  },
};
