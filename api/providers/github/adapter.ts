// GitHub as a tracker, through the provider contract. Issues assigned to the
// user (pull requests left out), keyed owner/repo#12; their status is the
// service's own open/closed with its reason (completed, not planned): the
// project status of Projects v2 waits for its spike. GitHub keeps no time:
// the time stays in inkledger's own register.
import { secretOf } from "../core/context";
import { verifySha256Header } from "../core/webhooks";
import { toGitHubQuery } from "./translate";
import { z } from "zod";
import type { TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, instantFrom } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, RemoteComment, RemoteIssue, RemoteStatus, TrackerProvider } from "../types";
import { gh, ghOk, webBaseOf, type GitHubComment, type GitHubCreds, type GitHubIssue, type GitHubUser } from "./client";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

export const githubCapabilities: TrackerCapabilities = {
  // Open/closed with its reason; the Projects v2 status field after its spike (github-projects).
  workflow: { sources: [{ kind: "boolean", transitions: "direct", reasons: true }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: "github",
  comments: { mode: "readWrite", formats: ["gfm"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: true,
  manage: { assign: true, labels: true, create: true, edit: true, types: false },
  // Subscribing goes through notification threads: not yet.
  watch: false,
  // GitHub's notifications (spike github-notifications).
  inbox: true,
  // Milestone, author, lock: what an issue has besides the mapped fields.
  otherFields: true,
  history: false,
  time: { mode: "local", remoteTotals: false },
  sync: {
    issueCheckpoints: true,
    // Departures aren't reported by the assigned-issues feed: reconciliation finds them.
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const githubTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: true,
  devLinks: true,
  attachments: { read: false, upload: false },
  timeboxes: ["milestone", "iteration"],
  fields: ["priority", "start", "estimate", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({
  /** Repositories (owner/repo) left out of the sync, e.g. a busy org's repos the user doesn't work on. */
  excludeRepos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).max(500).default([]),
  /** Which issues are mine here: every issue of the repositories I follow, or only the ones assigned to me */
  mine: z.enum(["followed", "assigned"]).default("followed"),
});
export type GitHubOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"github", GitHubOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts); 2: every repository the user follows, not only assigned issues. */
const V = 2;
type Since = { at: number };
/**
 * Where a pass is: the feed of every issue in the repositories the user owns,
 * collaborates on or belongs to through an org ("feed"), then each watched
 * repository outside it, one by one ("watched", `repos` fixed at the pass's start).
 */
type PageAt = { phase: "feed"; page: number; at: number } | { phase: "watched"; repos: string[]; repo: number; page: number; at: number };

/** Overlap read again at each pass: GitHub's `since` is to the second, updates may land late. */
const OVERLAP_MS = 60_000;
const PER_PAGE = 50;

/** A notification thread, as /notifications lists it. */
type GitHubThread = { id: string; reason: string; unread: boolean; updated_at: string; subject: { title: string; url: string | null; type: string } };

/** GitHub's reasons in the inbox's words: an assignment the sync sees itself. */
const REASONS: Record<string, "mention" | "comment" | "review" | "change" | "assign" | "other"> = {
  mention: "mention",
  team_mention: "mention",
  comment: "comment",
  author: "comment",
  subscribed: "comment",
  manual: "comment",
  review_requested: "review",
  state_change: "change",
  assign: "assign",
};

async function credsOf(x: X): Promise<GitHubCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

/** owner/repo#12, as GitHub writes it. */
export const REPO_KEY = /^([A-Za-z0-9][\w.-]{0,99})\/([\w.-]{1,100})#(\d{1,9})$/;
const normalizeKey = (raw: string) => (REPO_KEY.test(raw.trim()) ? raw.trim() : null);
const parts = (key: string) => {
  const m = REPO_KEY.exec(key);
  if (!m) throw new ProviderError("invalid", `Not a GitHub issue key: ${key}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
};

/** The three statuses GitHub has, with their categories. */
const STATUSES: RemoteStatus[] = [
  { id: "open", name: "Open", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "boolean" } },
  { id: "closed", name: "Closed", category: "done", categoryOrigin: { by: "native" }, source: { kind: "boolean" }, nativeReason: "completed" },
  { id: "not_planned", name: "Not planned", category: "cancelled", categoryOrigin: { by: "native" }, source: { kind: "boolean" }, nativeReason: "not_planned" },
];
const statusOf = (i: GitHubIssue) => (i.state === "open" ? STATUSES[0] : i.state_reason === "not_planned" ? STATUSES[2] : STATUSES[1]);

const repoOf = (i: GitHubIssue) => {
  const full = i.repository?.full_name ?? i.repository_url.split("/repos/")[1] ?? "";
  return { full, name: full.split("/")[1] ?? full };
};

const person = (u: GitHubUser) => ({ remoteId: String(u.id), name: u.name || u.login, avatarUrl: u.avatar_url ?? null, handle: u.login });

export function toRemoteIssue(i: GitHubIssue): RemoteIssue {
  const repo = repoOf(i);
  return {
    remoteId: i.node_id,
    key: `${repo.full}#${i.number}`,
    url: i.html_url,
    title: i.title,
    type: { id: "issue", name: "Issue" },
    status: statusOf(i),
    // The repository by its full name: what every issue call names it by.
    container: { remoteId: repo.full, key: repo.full, name: repo.name, kind: "repository" },
    priority: null,
    labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    assignees: (i.assignees ?? []).map(person),
    reporter: i.user ? person(i.user) : null,
    due: null,
    createdAt: instantFrom(i.created_at),
    updatedAt: instantFrom(i.updated_at),
    statusChangedAt: instantFrom(i.closed_at ?? null),
  };
}

const toRemoteComment = (c: GitHubComment): RemoteComment => ({
  id: String(c.id),
  author: c.user ? person(c.user) : { remoteId: "", name: "" },
  body: { kind: "text", format: "gfm", text: c.body ?? "" },
  createdAt: instantFrom(c.created_at),
  updatedAt: instantFrom(c.updated_at),
});

const issuePath = (key: string) => {
  const p = parts(key);
  return `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/issues/${p.number}`;
};

/** An issue by its key (GitHub answers 301 for one moved: followed, the new key comes back). */
async function issueByKey(creds: GitHubCreds, key: string): Promise<GitHubIssue | null> {
  const r = await gh<GitHubIssue>(creds, issuePath(key), { missingIsNull: true });
  return r && !r.data.pull_request ? r.data : null;
}

async function search(creds: GitHubCreds, q: string, limit: number) {
  const per = Math.min(100, Math.max(1, limit));
  const r = await ghOk<{ items: GitHubIssue[]; total_count: number; incomplete_results: boolean }>(creds, `/search/issues?q=${encodeURIComponent(`${q} is:issue`)}&per_page=${per}`);
  const items = r.items.filter((i) => !i.pull_request).slice(0, limit).map(toRemoteIssue);
  return { items, complete: !r.incomplete_results && r.total_count <= limit };
}

type GitHubRepo = { id: number; node_id: string; full_name: string; name: string; has_issues?: boolean; owner?: { avatar_url?: string | null }; permissions?: { push?: boolean } };

/** A repository as a container: by its full name, what every issue call names it by. */
const repoContainer = (r: Pick<GitHubRepo, "full_name" | "name" | "owner">) => ({
  remoteId: r.full_name,
  key: r.full_name,
  name: r.name,
  kind: "repository" as const,
  avatarUrl: r.owner?.avatar_url ?? null,
  group: r.full_name.split("/")[0],
});

/** Every page of a list (bounded: 50 pages). */
async function allPages<T>(creds: GitHubCreds, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let n = 0; next && n < 50; n++) {
    const r: { data: T[]; next: string | null } | null = await gh<T[]>(creds, next);
    out.push(...(r?.data ?? []));
    next = r?.next ?? null;
  }
  return out;
}

/** Watched repositories the `filter=all` feed doesn't cover (not owned, collaborated on or org-member), with issues on. */
async function watchedOutsideFeed(creds: GitHubCreds): Promise<string[]> {
  const [mine, watched] = await Promise.all([allPages<GitHubRepo>(creds, "/user/repos?affiliation=owner,collaborator,organization_member&per_page=100"), allPages<GitHubRepo>(creds, "/user/subscriptions?per_page=100")]);
  const covered = new Set(mine.map((r) => r.full_name));
  return [...new Set(watched.filter((r) => r.has_issues !== false && !covered.has(r.full_name)).map((r) => r.full_name))].sort();
}

async function patchIssue(x: X, ref: { key: string }, body: Record<string, unknown>) {
  return toRemoteIssue(await ghOk<GitHubIssue>(await credsOf(x), issuePath(ref.key), { method: "PATCH", body: JSON.stringify(body) }));
}

export const githubProvider: TrackerProvider<"github", GitHubOptions> = {
  role: "tracker",
  type: "github",
  capabilities: githubCapabilities,
  traits: githubTraits,
  settings: [{ key: "mine", choices: ["followed", "assigned"] }],

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `GitHub options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text) {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      const url = new URL(text.trim());
      if (url.origin !== new URL(webBaseOf(r.baseUrl)).origin) return null;
      const m = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
      return m ? { key: `${m[1]}/${m[2]}#${m[3]}` } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await ghOk<GitHubUser>(await credsOf(x), "/user");
    return { ...person(me), login: me.login };
  },

  async probe(x) {
    const r = await ghOk<{ resources: { core: { limit: number } } }>(await credsOf(x), "/rate_limit");
    return {
      capabilities: githubCapabilities,
      activeSources: [{ kind: "boolean", transitions: "direct", reasons: true, ref: { kind: "boolean" }, name: "Open / closed" }],
      rateLimit: { perHour: r.resources.core.limit, origin: "detected" },
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const excluded = new Set(x.conn.options.excludeRepos.map((r) => r.toLowerCase()));
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap.
    const at: PageAt = decodePageToken<PageAt>(x.conn, "issues", V, q.since, q.page) ?? { phase: "feed", page: 1, at: Date.now() };
    const params = (page: number) => {
      const p = new URLSearchParams({ state: "all", sort: "updated", direction: "asc", per_page: String(PER_PAGE), page: String(page) });
      if (since !== null) p.set("since", new Date(since).toISOString());
      return p;
    };
    const keep = (list: GitHubIssue[] | undefined) =>
      (list ?? []).filter((i) => !i.pull_request && !excluded.has(repoOf(i).full.toLowerCase())).map(toRemoteIssue);
    const next = (p: PageAt) => ({ last: false as const, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, p) });
    const done = { last: true as const, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at.at - OVERLAP_MS } satisfies Since) };

    if (at.phase === "feed") {
      const p = params(at.page);
      p.set("filter", x.conn.options.mine === "assigned" ? "assigned" : "all");
      const r = await gh<GitHubIssue[]>(creds, `/issues?${p.toString()}`);
      const items = keep(r?.data);
      if (r?.next) return { ...next({ ...at, page: at.page + 1 }), items };
      // Only mine: the watched repositories bring nobody else's issues.
      if (x.conn.options.mine === "assigned") return { ...done, items };
      // Then the watched repositories the feed doesn't cover.
      const repos = (await watchedOutsideFeed(creds)).filter((full) => !excluded.has(full.toLowerCase()));
      return repos.length ? { ...next({ phase: "watched", repos, repo: 0, page: 1, at: at.at }), items } : { ...done, items };
    }
    const full = at.repos[at.repo];
    const r = await gh<GitHubIssue[]>(creds, `/repos/${full}/issues?${params(at.page).toString()}`, { missingIsNull: true });
    const items = keep(r?.data);
    if (r?.next) return { ...next({ ...at, page: at.page + 1 }), items };
    if (at.repo + 1 < at.repos.length) return { ...next({ ...at, repo: at.repo + 1, page: 1 }), items };
    return { ...done, items };
  },

  async inbox(x, cursor) {
    const creds = await credsOf(x);
    // Unread threads changed since the cursor; an unchanged list answers 304 (free).
    const since = cursor ? `&since=${encodeURIComponent(cursor)}` : "";
    const threads = await allPages<GitHubThread>(creds, `/notifications?all=false&per_page=50${since}`);
    const items = threads.flatMap((t) => {
      // Issues only: pull requests and the rest stay out, as everywhere.
      const m = t.subject.type === "Issue" ? /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(t.subject.url ?? "") : null;
      if (!m) return [];
      return [{ id: t.id, reason: REASONS[t.reason] ?? "other", issue: { key: `${m[1]}#${m[2]}` }, title: t.subject.title, at: instant(Date.parse(t.updated_at)), unread: t.unread }];
    });
    const latest = threads.reduce<string | null>((a, t) => (!a || t.updated_at > a ? t.updated_at : a), cursor);
    return { items, cursor: latest };
  },

  async otherFields(x, ref) {
    const i = await issueByKey(await credsOf(x), ref.key);
    if (!i) return [];
    const out = [
      { name: "Milestone", value: i.milestone?.title ?? "" },
      { name: "Author", value: i.user?.login ?? "" },
      { name: "Locked", value: i.locked ? "yes" : "" },
    ];
    return out.filter((f) => f.value !== "");
  },

  async markRead(x, id) {
    await gh(await credsOf(x), `/notifications/threads/${encodeURIComponent(id)}`, { method: "PATCH" });
  },

  async containers(x) {
    const creds = await credsOf(x);
    const excluded = new Set(x.conn.options.excludeRepos.map((r) => r.toLowerCase()));
    // The user's own (owned, collaborated on) and the org's ones they can write to: not every
    // repository of every org, nor the ones only watched (the repositories where the user
    // already has issues are added by the catalogue, see createTargets).
    const [own, org] = await Promise.all([allPages<GitHubRepo>(creds, "/user/repos?affiliation=owner,collaborator&per_page=100"), allPages<GitHubRepo>(creds, "/user/repos?affiliation=organization_member&per_page=100")]);
    const byName = new Map([...own, ...org.filter((r) => r.permissions?.push)].filter((r) => r.has_issues !== false).map((r) => [r.full_name, r]));
    return [...byName.values()].filter((r) => !excluded.has(r.full_name.toLowerCase())).map(repoContainer);
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
    return search(await credsOf(x), `${text.replace(/[^\p{L}\p{N}\s#/.-]/gu, " ").trim()} involves:@me`, limit);
  },

  translate(expr, now) {
    return toGitHubQuery(expr, now);
  },

  // Repository or organisation webhooks, signed with the secret (X-Hub-Signature-256).
  webhook: {
    verify: (req, secret) => verifySha256Header(req.headers["x-hub-signature-256"], secret, req.body),
    deliveryId: (req) => req.headers["x-github-delivery"] ?? null,
  },

  async query(x, query, limit) {
    return search(await credsOf(x), query, limit);
  },

  async statuses() {
    return STATUSES;
  },

  async description(x, ref) {
    const i = await issueByKey(await credsOf(x), ref.key);
    return i?.body ? { kind: "text", format: "gfm", text: i.body } : null;
  },

  manage: {
    async assignable(x, container) {
      return (await allPages<GitHubUser>(await credsOf(x), `/repos/${container.key}/assignees?per_page=100`)).map(person);
    },
    async assign(x, ref, people) {
      return patchIssue(x, ref, { assignees: people.map((p) => p.handle ?? p.name) });
    },
    async labelOptions(x, container) {
      return (await allPages<{ name: string }>(await credsOf(x), `/repos/${container.key}/labels?per_page=100`)).map((l) => l.name);
    },
    async setLabels(x, ref, labels) {
      return patchIssue(x, ref, { labels });
    },
    async create(x, container, draft) {
      // GFM takes CommonMark as is.
      const body = { title: draft.title, body: draft.body ?? "", labels: draft.labels ?? [], assignees: (draft.assignees ?? []).map((p) => p.handle ?? p.name) };
      return toRemoteIssue(await ghOk<GitHubIssue>(await credsOf(x), `/repos/${container.key}/issues`, { method: "POST", body: JSON.stringify(body) }));
    },
    async edit(x, ref, patch) {
      return patchIssue(x, ref, { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.body !== undefined ? { body: patch.body } : {}) });
    },
  },

  transitions: {
    async list(x, ref) {
      const i = await issueByKey(await credsOf(x), ref.key);
      if (!i) throw new ProviderError("notFound", `GitHub: no issue ${ref.key}`);
      const now = statusOf(i);
      return STATUSES.filter((s) => s.id !== now.id).map((to) => ({
        id: to.id,
        name: to.id === "open" ? "Reopen" : to.id === "closed" ? "Close as completed" : "Close as not planned",
        to,
        requirements: [],
        remoteUrl: i.html_url,
      }));
    },
    async apply(x, ref, transitionId) {
      const body = transitionId === "open" ? { state: "open", state_reason: "reopened" } : { state: "closed", state_reason: transitionId === "not_planned" ? "not_planned" : "completed" };
      const i = await ghOk<GitHubIssue>(await credsOf(x), issuePath(ref.key), { method: "PATCH", body: JSON.stringify(body) });
      return toRemoteIssue(i);
    },
  },

  comments: {
    async list(x, ref) {
      const creds = await credsOf(x);
      const out: RemoteComment[] = [];
      let next: string | null = `${issuePath(ref.key)}/comments?per_page=100`;
      for (let n = 0; next && n < 20; n++) {
        const r: { data: GitHubComment[]; next: string | null } | null = await gh<GitHubComment[]>(creds, next);
        out.push(...(r?.data ?? []).map(toRemoteComment));
        next = r?.next ?? null;
      }
      return out;
    },
    async add(x, ref, body) {
      // GFM takes CommonMark as is: nothing to approximate.
      const c = await ghOk<GitHubComment>(await credsOf(x), `${issuePath(ref.key)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
      return { comment: toRemoteComment(c), warnings: [] };
    },
  },
};
