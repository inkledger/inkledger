// Gitea and Forgejo as a tracker, through the provider contract. Issues
// assigned to the user (pull requests left out: the issues API lists them
// too), keyed owner/repo#12; their status is the service's open/closed. The
// time is Gitea's own tracked time: entries with a start and seconds, created
// and deleted (never changed: a new one replaces it), read back through the
// user's times over a window. Built on a simulator (docs/dev/spikes.md).
import { giteaWebhook } from "./webhook";
import { z } from "zod";
import type { TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, instantFrom } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, ChangeValue, RemoteChange, RemoteComment, RemoteIssue, RemotePerson, RemoteStatus, RemoteWorklog, TrackerProvider } from "../types";
import { allPages, apiRootOf, gt, gtOk, webBaseOf, type GiteaComment, type GiteaCreds, type GiteaIssue, type GiteaTimelineEntry, type GiteaTrackedTime, type GiteaUser } from "./client";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

// Declared in the catalogue's own order and values (the registry compares them).
export const giteaCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: false,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["gfm"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: true,
  history: true,
  // Open/closed is what the REST API gives. Scoped labels need a connection's mapping for their categories, and project boards have no REST endpoint: both wait for their spikes.
  workflow: { sources: [{ kind: "boolean", transitions: "direct", reasons: false }, { kind: "labelSet", transitions: "direct" }, { kind: "column", transitions: "move" }] },
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "session",
      // Tracked time has no update: a changed entry is deleted and logged again.
      write: { mode: "entry", update: "recreate", delete: true },
      // The user's times since a date: the window is read again each pass.
      feed: { kind: "window", by: "entryDate", days: 30, overlapDays: 2 },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
      activities: { read: false, write: false, required: "no" },
      onBehalf: { read: false, write: false },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "none",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const giteaTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: ["milestone"],
  fields: ["due", "estimate", "labels", "multiAssignee"],
};

const optionsSchema = z.strictObject({
  /** Repositories (owner/repo) left out of the sync, e.g. a busy organisation's the user doesn't work on. */
  excludeRepos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).max(500).default([]),
});
export type GiteaOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"gitea", GiteaOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
type PageAt = { page: number; at: number };

/** Overlap read again at each pass: `since` is to the second, updates may land late. */
const OVERLAP_MS = 60_000;
/** Gitea's usual ceiling per page (MAX_RESPONSE_ITEMS): a bigger ask is cut to it, so pages follow the Link header, never counts. */
const PER_PAGE = 50;
const DAY_MS = 86_400_000;
/** The feed window, as declared, plus a day for the user's zone against the server's. */
const WINDOW_MS = (30 + 1) * DAY_MS;

async function credsOf(x: X): Promise<GiteaCreds> {
  const cred = await x.conn.credential();
  const token = cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password;
  return { apiBase: apiRootOf(x.conn.baseUrl), token };
}

/** owner/repo#12, as the service writes it in references. */
export const REPO_KEY = /^([A-Za-z0-9][\w.-]{0,99})\/([\w.-]{1,100})#(\d{1,9})$/;
const normalizeKey = (raw: string) => (REPO_KEY.test(raw.trim()) ? raw.trim() : null);
const parts = (key: string) => {
  const m = REPO_KEY.exec(key);
  if (!m) throw new ProviderError("invalid", `Not a Gitea issue key: ${key}`);
  return { owner: m[1], repo: m[2], index: Number(m[3]) };
};

/** open/closed with the categories Gitea's two states sit in. */
const STATUSES: RemoteStatus[] = [
  { id: "open", name: "Open", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "boolean" } },
  { id: "closed", name: "Closed", category: "done", categoryOrigin: { by: "native" }, source: { kind: "boolean" } },
];
const statusOf = (i: GiteaIssue) => (i.state === "open" ? STATUSES[0] : STATUSES[1]);

const person = (u: GiteaUser): RemotePerson => ({ remoteId: String(u.id), name: u.full_name || u.login, avatarUrl: u.avatar_url ?? null, handle: u.login });

/** The repository an issue is in: from its metadata, else from its web link (<web>/owner/repo/issues/n). */
function repoOf(i: GiteaIssue) {
  if (i.repository) return { id: String(i.repository.id), full: i.repository.full_name, name: i.repository.name };
  const m = /\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/\d+\/?$/.exec(new URL(i.html_url).pathname);
  const full = m ? `${m[1]}/${m[2]}` : "";
  return { id: full, full, name: m?.[2] ?? full };
}

export function toRemoteIssue(i: GiteaIssue): RemoteIssue {
  const repo = repoOf(i);
  return {
    // The global id: the index (number) is per repository and goes with the repository's name, which can change.
    remoteId: String(i.id),
    key: `${repo.full}#${i.number}`,
    url: i.html_url,
    title: i.title,
    type: { id: "issue", name: "Issue" },
    status: statusOf(i),
    container: { remoteId: repo.id, key: repo.full, name: repo.name, kind: "repository" },
    priority: null,
    labels: (i.labels ?? []).map((l) => l.name).filter(Boolean),
    // Nobody assigned comes as null, not [].
    assignees: (i.assignees ?? (i.assignee ? [i.assignee] : [])).map(person),
    reporter: i.user ? person(i.user) : null,
    due: null,
    createdAt: instantFrom(i.created_at),
    updatedAt: instantFrom(i.updated_at),
    statusChangedAt: instantFrom(i.closed_at ?? null),
  };
}

const toRemoteComment = (c: GiteaComment): RemoteComment => ({
  id: String(c.id),
  author: c.user ? person(c.user) : { remoteId: "", name: "" },
  body: { kind: "text", format: "gfm", text: c.body ?? "" },
  createdAt: instantFrom(c.created_at),
  updatedAt: instantFrom(c.updated_at),
});

const issuePath = (key: string) => {
  const p = parts(key);
  return `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/issues/${p.index}`;
};

/** An issue by its key (a renamed repository answers with a redirect: followed, the new key comes back). Pull requests are not issues here. */
async function issueByKey(creds: GiteaCreds, key: string): Promise<GiteaIssue | null> {
  const r = await gt<GiteaIssue>(creds, issuePath(key), { missingIsNull: true });
  return r && !r.data.pull_request ? r.data : null;
}

/** A RFC 3339 instant, always in UTC ("Z"): a "+02:00" in a query string turns into a space and is refused. */
const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function search(creds: GiteaCreds, q: string, limit: number) {
  const per = Math.min(PER_PAGE, Math.max(1, limit));
  const p = new URLSearchParams({ q, type: "issues", state: "all", limit: String(per) });
  const r = await gt<GiteaIssue[]>(creds, `/repos/issues/search?${p.toString()}`);
  const items = (r?.data ?? []).filter((i) => !i.pull_request).slice(0, limit).map(toRemoteIssue);
  return { items, complete: r !== null && r.next === null && (r.total === null || r.total <= items.length) };
}

/** An entry of the user's tracked time. */
function toRemoteWorklog(t: GiteaTrackedTime, me: X["conn"], ref?: { key: string; container?: { remoteId: string; key: string } }): RemoteWorklog {
  const mine = [String(t.user_id), t.user_name].includes(me.remoteAccountId);
  const embedded = t.issue ? toRemoteIssue(t.issue) : null;
  const key = ref?.key ?? embedded?.key;
  const container = ref?.container ?? (embedded ? { remoteId: embedded.container.remoteId, key: embedded.container.key } : undefined);
  const created = instantFrom(t.created) ?? instant(0);
  return {
    remoteId: String(t.id),
    issue: { remoteId: String(t.issue_id), ...(key ? { key } : {}), ...(container ? { container } : {}) },
    // `created` is when it was logged, with the server's own UTC offset: the instant is the same.
    span: { kind: "session", start: created, seconds: t.time },
    // Tracked time has no note.
    comment: "",
    authorRemoteId: String(t.user_id),
    createdAt: created,
    updatedAt: created,
    // Only one's own entries are offered for deletion; an entry is never changed, only replaced.
    editable: { update: false, delete: mine },
  };
}

const value = (text: string): ChangeValue[] => (text ? [{ text }] : []);

/** The timeline entry types that change something an issue has, as history. */
function toChanges(e: GiteaTimelineEntry): RemoteChange[] {
  const at = instantFrom(e.created_at) ?? instant(0);
  const actor = e.user ? person(e.user) : null;
  const one = (id: string, name: string, from: ChangeValue[], to: ChangeValue[]): RemoteChange[] => [{ at, actor, field: { id, name }, from, to }];
  switch (e.type) {
    case "close":
      return one("state", "State", value("Open"), value("Closed"));
    case "reopen":
      return one("state", "State", value("Closed"), value("Open"));
    case "change_title":
      return one("title", "Title", value(e.old_title ?? ""), value(e.new_title ?? ""));
    case "label": {
      // The label comment's body is "1" when it was added, empty when removed.
      const name = e.label?.name ?? "";
      return e.body === "1" ? one("labels", "Labels", [], value(name)) : one("labels", "Labels", value(name), []);
    }
    case "milestone":
      return one("milestone", "Milestone", value(e.old_milestone?.title ?? ""), value(e.milestone?.title ?? ""));
    case "assignees": {
      const who = e.assignee ? (e.assignee.full_name || e.assignee.login) : "";
      return e.removed_assignee ? one("assignees", "Assignees", value(who), []) : one("assignees", "Assignees", [], value(who));
    }
    default:
      return [];
  }
}

export const giteaProvider: TrackerProvider<"gitea", GiteaOptions> = {
  // Deliveries signed with the secret (X-Gitea-Signature / X-Forgejo-Signature): core/webhooks via gitea/webhook.ts.
  webhook: {
    verify: (req, secret) => giteaWebhook.verify(secret, req.body, new Headers(req.headers)),
    deliveryId: (req) => giteaWebhook.deliveryId(new Headers(req.headers)),
  },
  role: "tracker",
  type: "gitea",
  capabilities: giteaCapabilities,
  traits: giteaTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Gitea options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text) {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      const url = new URL(text.trim());
      const web = new URL(webBaseOf(r.baseUrl));
      if (url.origin !== web.origin) return null;
      const prefix = web.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith(`${prefix}/`)) return null;
      const m = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname.slice(prefix.length));
      return m ? { key: `${m[1]}/${m[2]}#${m[3]}` } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await gtOk<GiteaUser>(await credsOf(x), "/user");
    return { ...person(me), login: me.login, ...(me.email ? { email: me.email } : {}) };
  },

  async probe(x) {
    // The version also tells Forgejo (7.0.0+gitea-1.22.0) from Gitea: nothing differs for the layer yet. No rate limit of its own, so no figure.
    await gtOk<{ version: string }>(await credsOf(x), "/version");
    return {
      capabilities: giteaCapabilities,
      activeSources: [{ kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / closed" }],
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const at: PageAt = decodePageToken<PageAt>(x.conn, "issues", V, q.since, q.page) ?? { page: 1, at: Date.now() };
    // Issues assigned to the user, in every repository they can see; type=issues leaves pull requests out.
    const p = new URLSearchParams({ assigned: "true", type: "issues", state: "all", limit: String(PER_PAGE), page: String(at.page) });
    if (since !== null) p.set("since", rfc3339(since));
    const r = await gt<GiteaIssue[]>(creds, `/repos/issues/search?${p.toString()}`);
    const excluded = new Set(x.conn.options.excludeRepos.map((full) => full.toLowerCase()));
    const items = (r?.data ?? []).filter((i) => !i.pull_request && !excluded.has(repoOf(i).full.toLowerCase())).map(toRemoteIssue);
    if (r?.next) return { last: false as const, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, { page: at.page + 1, at: at.at } satisfies PageAt) };
    return { last: true as const, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const i = await issueByKey(await credsOf(x), ref.key);
    return i ? toRemoteIssue(i) : null;
  },

  async findIssue(x, handle) {
    if (!handle.key) return { kind: "none" };
    const i = await issueByKey(await credsOf(x), handle.key);
    return i ? { kind: "found", issue: toRemoteIssue(i) } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    return search(await credsOf(x), text.replace(/[^\p{L}\p{N}\s#/.-]/gu, " ").trim(), limit);
  },

  async description(x, ref) {
    const i = await issueByKey(await credsOf(x), ref.key);
    return i?.body ? { kind: "text", format: "gfm", text: i.body } : null;
  },

  transitions: {
    async list(x, ref) {
      const i = await issueByKey(await credsOf(x), ref.key);
      if (!i) throw new ProviderError("notFound", `Gitea: no issue ${ref.key}`);
      const now = statusOf(i);
      return STATUSES.filter((s) => s.id !== now.id).map((to) => ({ id: to.id, name: to.id === "open" ? "Reopen" : "Close", to, requirements: [], remoteUrl: i.html_url }));
    },
    async apply(x, ref, transitionId) {
      if (!STATUSES.some((s) => s.id === transitionId)) throw new ProviderError("invalid", `Gitea: no transition ${transitionId}`);
      // The edit answers 201 (an old quirk kept): any 2xx is a success.
      const i = await gtOk<GiteaIssue>(await credsOf(x), issuePath(ref.key), { method: "PATCH", body: JSON.stringify({ state: transitionId }) });
      return toRemoteIssue(i);
    },
  },

  worklogs: {
    async list(x, ref) {
      const times = await allPages<GiteaTrackedTime>(await credsOf(x), `${issuePath(ref.key)}/times?limit=${PER_PAGE}`);
      return times.map((t) => toRemoteWorklog(t, x.conn, ref));
    },
    async changed(x, q) {
      const creds = await credsOf(x);
      // A window, not a delta: the checkpoint only has to be this stream's own (it is checked, and unused).
      decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since);
      const at: PageAt = decodePageToken<PageAt>(x.conn, "worklogs", V, q.since, q.page) ?? { page: 1, at: Date.now() };
      const p = new URLSearchParams({ since: rfc3339(at.at - WINDOW_MS), limit: String(PER_PAGE), page: String(at.page) });
      const r = await gt<GiteaTrackedTime[]>(creds, `/user/times?${p.toString()}`);
      const items = (r?.data ?? []).map((t) => toRemoteWorklog(t, x.conn));
      if (r?.next) return { last: false as const, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { page: at.page + 1, at: at.at } satisfies PageAt) };
      return { last: true as const, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: at.at } satisfies Since) };
    },
    async create(x, ref, w) {
      if (w.time.kind !== "session") throw new ProviderError("invalid", `Gitea keeps time with a start time, not a ${w.time.kind}`);
      // The note is not kept: tracked time has none.
      const body = { time: w.time.seconds, created: rfc3339(w.time.start) };
      const t = await gtOk<GiteaTrackedTime>(await credsOf(x), `${issuePath(ref.key)}/times`, { method: "POST", body: JSON.stringify(body) });
      return toRemoteWorklog(t, x.conn, ref);
    },
    async delete(x, ref, id) {
      // Already gone is what was asked for.
      await gt<unknown>(await credsOf(x), `${issuePath(ref.key)}/times/${encodeURIComponent(id)}`, { method: "DELETE", missingIsNull: true });
    },
  },

  comments: {
    async list(x, ref) {
      return (await allPages<GiteaComment>(await credsOf(x), `${issuePath(ref.key)}/comments?limit=${PER_PAGE}`)).map(toRemoteComment);
    },
    async add(x, ref, body) {
      // GFM takes CommonMark as is: nothing to approximate.
      const c = await gtOk<GiteaComment>(await credsOf(x), `${issuePath(ref.key)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      return { comment: toRemoteComment(c), warnings: [] };
    },
  },

  async watch(x, ref, on) {
    const creds = await credsOf(x);
    const me = await gtOk<GiteaUser>(creds, "/user");
    // Subscribing when subscribed (200) or newly (201), and the same for leaving: all successes.
    await gt<unknown>(creds, `${issuePath(ref.key)}/subscriptions/${encodeURIComponent(me.login)}`, { method: on ? "PUT" : "DELETE" });
  },

  async history(x, ref) {
    const entries = await allPages<GiteaTimelineEntry>(await credsOf(x), `${issuePath(ref.key)}/timeline?limit=${PER_PAGE}`);
    return entries.flatMap(toChanges);
  },
};
