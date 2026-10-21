// OpenProject (Community, Enterprise and Cloud) as a tracker, through the
// provider contract. Work packages assigned to the user (`assignee = me`),
// keyed `#123` (the id is global to the instance and survives a move between
// projects, so the key never changes); the status is the work package's own,
// with its category from `isClosed` and the usual names; the ways out of a
// status are the form's allowed statuses, applied under the work package's
// `lockVersion`. Time is time entries, kept by date as ISO durations. Built
// from the API's documentation on a simulator, not yet on a real server:
// SPIKES.md, section OpenProject.
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, type Instant, type LocalDate } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type {
  CallContext,
  CatalogItem,
  ChangeValue,
  IssueHandle,
  PageQuery,
  RemoteBody,
  RemoteChange,
  RemoteComment,
  RemoteIssue,
  RemotePerson,
  RemoteStatus,
  RemoteWorklog,
  TrackerProvider,
  Transition,
  WorklogInput,
} from "../types";
import {
  allPages,
  allowedValues,
  filtersQuery,
  hrefOf,
  idOfHref,
  lastPage,
  op,
  opOk,
  pageOf,
  sortQuery,
  webBaseOf,
  type Filter,
  type Formatted,
  type Link,
  type OpActivity,
  type OpActivityType,
  type OpStatus,
  type OpTimeEntry,
  type OpUser,
  type OpWorkPackage,
  type OpenProjectCreds,
} from "./client";
import { openProjectDeliveryId, openProjectSentAt, verifyOpenProjectWebhook } from "./webhook";

export { openProjectEvent, verifyOpenProjectWebhook } from "./webhook";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

export const openprojectCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["commonmark"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: true,
  inbox: false,
  otherFields: false,
  history: true,
  workflow: { sources: [{ kind: "itemState", transitions: "allowedList" }] },
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "native", delete: true },
      // Entries changed since a time, across work packages; a deleted one just vanishes (reconciled by period).
      feed: { kind: "incremental", removals: false },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
      activities: { read: true, write: true, required: "no" },
      onBehalf: { read: true, write: true },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "revision",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    // `assignee = me` only lists what is still assigned: departures are found by reconciliation.
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
      { event: "worklogChanged", payload: "signal" },
    ],
  },
};

export const openprojectTraits: TrackerTraits = {
  create: true,
  inbox: true,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: ["version"],
  fields: ["priority", "due", "start", "estimate", "points", "custom"],
};

const optionsSchema = z.strictObject({
  /** Project identifiers (the slug in a project's address) left out of the sync */
  excludeProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i)).max(500).default([]),
});
export type OpenProjectOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"openproject", OpenProjectOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** Where a pass is: the page (counted from 1) of the next read, and when the pass began. */
type PassAt = { page: number; at: number };

/** Overlap read again at each pass: the server's clock is not ours, and `updatedAt` may land late. */
const OVERLAP_MS = 5 * 60_000;
const PER_PAGE = 100;

async function credsOf(x: X): Promise<OpenProjectCreds> {
  const cred = await x.conn.credential();
  const token = cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password;
  return { apiBase: x.conn.baseUrl, token };
}

// ---------- Keys and links ----------

/** `#123`, also written WP#123: the number is the work package's id. */
const KEY = /^(?:WP)?#([1-9]\d{0,8})$/i;
const normalizeKey = (raw: string) => {
  const m = KEY.exec(raw.trim());
  return m ? `#${m[1]}` : null;
};
const keyOf = (id: number | string) => `#${id}`;

const enc = encodeURIComponent;
/** The work package's number: its id, else its key. */
function wpId(ref: { remoteId: string; key: string }): string {
  const id = ref.remoteId || ref.key.replace(/^#/, "");
  if (!/^\d+$/.test(id)) throw new ProviderError("invalid", `OpenProject: not a work package: ${ref.key || ref.remoteId}`);
  return id;
}

// ---------- Values ----------

const at = (text: unknown): Instant | null => (typeof text === "string" ? instantFrom(text) : null);

/** A plain date (no time, no zone): the day it says, in any user's zone. */
const dayOf = (text: unknown): LocalDate | null => {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  try {
    return localDate(text);
  } catch {
    return null;
  }
};

const DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
/** ISO 8601 duration ("PT1H30M") in whole seconds, null when it isn't one. A day is 24 hours. */
export function secondsOf(iso: unknown): number | null {
  if (typeof iso !== "string" || iso === "P" || iso === "PT") return null;
  const m = DURATION.exec(iso);
  if (!m) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((v) => (v === undefined ? 0 : Number(v)));
  return Math.round(d * 86_400 + h * 3600 + min * 60 + s);
}
/** Whole seconds as an ISO 8601 duration. */
export function durationOf(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

/** Relative avatar paths are made absolute on the site. */
const absolute = (web: string, url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url, `${web}/`).toString();
  } catch {
    return null;
  }
};

const person = (web: string, u: OpUser): RemotePerson => ({
  remoteId: String(u.id),
  name: u.name || u.login || "",
  avatarUrl: absolute(web, u.avatar),
  ...(u.login ? { handle: u.login } : {}),
});

/** Someone named by a link, with what was embedded of them when it was; null for an empty link. */
function personOf(web: string, link: Link | undefined, embedded?: OpUser | null): RemotePerson | null {
  if (embedded) return person(web, embedded);
  const id = idOfHref(link?.href);
  return id ? { remoteId: id, name: link?.title ?? "" } : null;
}

const CANCELLED = /reject|won'?t|will not|obsolete|duplicate|declined|cancel|can'?t reproduce|invalid|annull|scartat|respint|non (si )?risolv/i;
const DOING = /progress|developed|testing|tested|test failed|review|started|working|in corso|lavorazione|esecuzione/i;
/**
 * A status's category. OpenProject says only whether it closes the work
 * package (`isClosed`): the rest comes from the usual names, English and
 * Italian (spike openproject-status-categories).
 */
export function categoryOf(name: string, closed: boolean): StatusCategory {
  if (closed) return CANCELLED.test(name) ? "cancelled" : "done";
  return DOING.test(name) ? "doing" : "todo";
}

const statusOf = (s: OpStatus): RemoteStatus => ({
  id: String(s.id),
  name: s.name,
  category: categoryOf(s.name, s.isClosed === true),
  categoryOrigin: { by: "native" },
  source: { kind: "itemState" },
  nativeReason: s.isClosed ? s.name : null,
  ...(s.color ? { color: s.color } : {}),
  ...(typeof s.position === "number" ? { order: s.position } : {}),
});

/** A description or comment in the service's format: Markdown (CommonMark) since 8.0, Textile before. */
const bodyOf = (f: Formatted | null | undefined): RemoteBody => ({ kind: "text", format: f?.format === "textile" ? "textile" : "commonmark", text: f?.raw ?? "" });

export function toRemoteIssue(web: string, wp: OpWorkPackage): RemoteIssue {
  const l = wp._links;
  const e = wp._embedded ?? {};
  const projectId = String(e.project?.id ?? idOfHref(l.project?.href) ?? "");
  const status = e.status ?? { id: Number(idOfHref(l.status?.href) ?? 0), name: l.status?.title ?? "", isClosed: false };
  const typeName = e.type?.name ?? l.type?.title ?? "";
  const typeId = String(e.type?.id ?? idOfHref(l.type?.href) ?? typeName);
  const priorityId = e.priority?.id ?? idOfHref(l.priority?.href);
  const priorityName = e.priority?.name ?? l.priority?.title;
  const assignee = personOf(web, l.assignee, e.assignee);
  const parent = idOfHref(l.parent?.href);
  const estimate = secondsOf(wp.estimatedTime);
  const spent = secondsOf(wp.spentTime);
  return {
    remoteId: String(wp.id),
    key: keyOf(wp.id),
    url: `${web}/work_packages/${wp.id}`,
    title: wp.subject ?? "",
    type: { id: typeId, name: typeName, level: parent ? "sub" : /epic/i.test(typeName) ? "epic" : "standard" },
    status: statusOf(status),
    container: { remoteId: projectId, key: e.project?.identifier ?? projectId, name: e.project?.name ?? l.project?.title ?? "", kind: "project" },
    priority: priorityId && priorityName ? { id: String(priorityId), name: priorityName, rank: null } : null,
    labels: [],
    assignees: assignee ? [assignee] : [],
    reporter: personOf(web, l.author, e.author),
    due: dayOf(wp.dueDate),
    estimateSeconds: estimate,
    spentSeconds: spent,
    createdAt: at(wp.createdAt),
    updatedAt: at(wp.updatedAt),
    statusChangedAt: null,
    parent: parent ? { remoteId: parent, key: keyOf(parent) } : null,
  };
}

const webOf = (x: X) => webBaseOf(x.conn.baseUrl);
const excluded = (x: X) => new Set(x.conn.options.excludeProjects.map((p) => p.toLowerCase()));

/** A list read as the layer's issues: statuses filled in, excluded projects left out. */
async function issuesOf(x: X, creds: OpenProjectCreds, list: OpWorkPackage[]): Promise<RemoteIssue[]> {
  // A list that embeds no status can't tell whether one is closed: the statuses are read once.
  let filled = list;
  if (list.some((w) => !w._embedded?.status)) {
    const by = new Map(((await allPages<OpStatus>(creds, "/statuses")) ?? []).map((s) => [String(s.id), s]));
    filled = list.map((w) => {
      const s = by.get(idOfHref(w._links.status?.href) ?? "");
      return w._embedded?.status || !s ? w : { ...w, _embedded: { ...w._embedded, status: s } };
    });
  }
  const out = excluded(x);
  return filled.map((w) => toRemoteIssue(webOf(x), w)).filter((i) => !out.has(i.container.key.toLowerCase()));
}

async function workPackage(creds: OpenProjectCreds, ref: { remoteId: string; key: string }): Promise<OpWorkPackage | null> {
  return op<OpWorkPackage>(creds, `/work_packages/${enc(wpId(ref))}`, { missingIsNull: true });
}

// ---------- Time entries ----------

const versionOf = (e: OpTimeEntry): string | null => (e.lockVersion !== undefined ? String(e.lockVersion) : (e.updatedAt ?? null));

export function toRemoteWorklog(e: OpTimeEntry, issue?: { remoteId: string; key: string }): RemoteWorklog {
  const l = e._links;
  const wp = idOfHref(l.workPackage?.href);
  const activity = idOfHref(l.activity?.href);
  return {
    remoteId: String(e.id),
    issue: wp ? { remoteId: wp, key: keyOf(wp) } : issue ? { remoteId: issue.remoteId, key: issue.key } : null,
    span: { kind: "date", date: dayOf(e.spentOn) ?? localDate("1970-01-01"), seconds: secondsOf(e.hours) ?? 0 },
    comment: e.comment?.raw ?? "",
    authorRemoteId: idOfHref(l.user?.href) ?? "",
    createdAt: at(e.createdAt),
    updatedAt: at(e.updatedAt),
    activity: activity ? { id: activity, name: l.activity?.title ?? "" } : null,
    version: versionOf(e),
    // The links are what the server lets this user do to this entry now (their own, or anyone's with the right).
    editable: { update: !!(l.update?.href || l.updateImmediately?.href), delete: !!l.delete?.href },
  };
}

function entryBody(w: WorklogInput, extra: { workPackage?: string; lockVersion?: number } = {}) {
  if (w.time.kind !== "date") throw new ProviderError("invalid", `OpenProject keeps time entries by date, not a ${w.time.kind}`);
  return {
    spentOn: w.time.date,
    hours: durationOf(w.time.seconds),
    comment: { raw: w.comment },
    ...(extra.lockVersion !== undefined ? { lockVersion: extra.lockVersion } : {}),
    _links: {
      ...(extra.workPackage ? { workPackage: { href: hrefOf(`/work_packages/${extra.workPackage}`) } } : {}),
      ...(w.activityId ? { activity: { href: hrefOf(`/time_entries/activities/${w.activityId}`) } } : {}),
      ...(w.onBehalfOfRemoteId ? { user: { href: hrefOf(`/users/${w.onBehalfOfRemoteId}`) } } : {}),
    },
  };
}

/** Time entries of a filter, a page at a time in id order (stable under edits). */
async function entriesPass(x: X, q: PageQuery) {
  const creds = await credsOf(x);
  const since = decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since)?.at ?? null;
  const here = decodePageToken<PassAt>(x.conn, "worklogs", V, q.since, q.page) ?? { page: 1, at: Date.now() };
  const filters: Filter[] = [{ user: { operator: "=", values: ["me"] } }];
  if (since !== null) filters.push({ updatedAt: { operator: "<>d", values: [new Date(since).toISOString(), ""] } });
  const p = (await pageOf<OpTimeEntry>(creds, `/time_entries?${filtersQuery(filters)}&${sortQuery([["id", "asc"]])}`, here.page, PER_PAGE))!;
  // Entries on no work package are project time: not about an issue.
  const items = p.elements.filter((e) => e._links.workPackage?.href).map((e) => toRemoteWorklog(e));
  return lastPage(p, here.page)
    ? { last: true as const, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: here.at - OVERLAP_MS } satisfies Since) }
    : { last: false as const, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { page: here.page + 1, at: here.at } satisfies PassAt) };
}

// ---------- Comments, history ----------

const toRemoteComment = (web: string, a: OpActivity): RemoteComment => ({
  id: String(a.id),
  author: personOf(web, a._links.user, a._embedded?.user) ?? { remoteId: "", name: "" },
  body: bodyOf(a.comment),
  createdAt: at(a.createdAt),
  updatedAt: at(a.updatedAt),
});

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };
/** Journal details come as rendered text ("Status changed from New to In progress"), in the user's language. */
const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();

const value = (text: string): ChangeValue[] => (text ? [{ text }] : []);

/** One journal detail as a change: the English wordings are read apart, any other keeps the whole sentence. */
function toRemoteChange(web: string, a: OpActivity, d: Formatted): RemoteChange {
  const text = plain(d.html ?? d.raw ?? "");
  const changed = /^(.+?) changed from (.*) to (.*)$/.exec(text);
  const set = /^(.+?) set to (.*)$/.exec(text);
  const removed = /^(.+?) deleted \((.*)\)$/.exec(text);
  const parts = changed ? { name: changed[1], from: changed[2], to: changed[3] } : set ? { name: set[1], from: "", to: set[2] } : removed ? { name: removed[1], from: removed[2], to: "" } : null;
  return {
    at: at(a.createdAt) ?? instant(0),
    actor: personOf(web, a._links.user, a._embedded?.user),
    field: { name: parts?.name ?? "Change" },
    from: value(parts?.from ?? ""),
    to: parts ? value(parts.to) : value(text),
  };
}

export const openprojectProvider: TrackerProvider<"openproject", OpenProjectOptions> = {
  // Deliveries are signed with the webhook's secret (X-OP-Signature, HMAC-SHA1); they carry no id or send time of their own.
  webhook: {
    verify: (req, secret) => verifyOpenProjectWebhook(req.headers, req.body, secret),
    deliveryId: (req) => openProjectDeliveryId(req.body),
    sentAt: (req) => openProjectSentAt(req.body),
  },
  role: "tracker",
  type: "openproject",
  capabilities: openprojectCapabilities,
  traits: openprojectTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `OpenProject options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text): IssueHandle | null {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      const url = new URL(text.trim());
      const site = new URL(webBaseOf(r.baseUrl));
      if (url.origin !== site.origin) return null;
      // https://host/work_packages/12, /projects/p/work_packages/12/activity, /work_packages/details/12/overview, /wp/12, /notifications/details/12, the API's own link; a context path may come first.
      const prefix = site.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith(`${prefix}/`)) return null;
      const path = url.pathname.slice(prefix.length);
      const m =
        /^\/(?:projects\/[^/]+\/)?work_packages\/(?:details\/)?(\d+)(?:\/|$)/.exec(path) ??
        /^\/wp\/(\d+)\/?$/.exec(path) ??
        /^\/notifications\/details\/(\d+)(?:\/|$)/.exec(path) ??
        /^\/api\/v3\/work_packages\/(\d+)\/?$/.exec(path);
      const k = m ? normalizeKey(`#${m[1]}`) : null;
      return k ? { key: k } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await opOk<OpUser>(await credsOf(x), "/users/me");
    // Without a user the server answers as the anonymous account (a public instance): never a connection.
    if (me._type === "AnonymousUser" || (!me.login && me.name?.toLowerCase() === "anonymous")) throw new ProviderError("auth", "OpenProject: the token is anonymous");
    return { ...person(webOf(x), me), ...(me.login ? { login: me.login } : {}), ...(me.email ? { email: me.email } : {}) };
  },

  async probe() {
    return {
      capabilities: openprojectCapabilities,
      // The statuses are global to the instance: one source (the workflow that links them is per type and role, read per work package).
      activeSources: [{ kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" }, name: "Status" }],
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    const here = decodePageToken<PassAt>(x.conn, "issues", V, q.since, q.page) ?? { page: 1, at: Date.now() };
    // Explicit filters: without any, the list keeps only the open work packages.
    const filters: Filter[] = [{ assignee: { operator: "=", values: ["me"] } }];
    if (since !== null) filters.push({ updatedAt: { operator: "<>d", values: [new Date(since).toISOString(), ""] } });
    // Id order: stable while work packages change under the pass (an edit never moves one past the page being read).
    const p = (await pageOf<OpWorkPackage>(creds, `/work_packages?${filtersQuery(filters)}&${sortQuery([["id", "asc"]])}`, here.page, PER_PAGE))!;
    const items = await issuesOf(x, creds, p.elements);
    if (lastPage(p, here.page)) return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: here.at - OVERLAP_MS } satisfies Since) };
    return { last: false, items, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, { page: here.page + 1, at: here.at } satisfies PassAt) };
  },

  async getIssue(x, ref) {
    const creds = await credsOf(x);
    if (!/^\d+$/.test(ref.remoteId || ref.key.replace(/^#/, ""))) return null;
    const wp = await workPackage(creds, ref);
    return wp ? ((await issuesOf(x, creds, [wp]))[0] ?? null) : null;
  },

  async findIssue(x, handle) {
    const key = handle.key ? normalizeKey(handle.key) : null;
    if (handle.key && !key && !handle.remoteId) return { kind: "none" };
    const id = handle.remoteId ?? key!.slice(1);
    const found = await this.getIssue(x, { remoteId: id, key: keyOf(id) });
    // Ids are unique on an instance: never ambiguous. A work package the token can't see is a 404, the same as none.
    return found ? { kind: "found", issue: found } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    const term = text.replace(/\s+/g, " ").trim();
    if (!term) return { items: [], complete: true };
    const creds = await credsOf(x);
    const filters: Filter[] = [{ subjectOrId: { operator: "**", values: [term] } }];
    const p = (await pageOf<OpWorkPackage>(creds, `/work_packages?${filtersQuery(filters)}&${sortQuery([["updatedAt", "desc"]])}`, 1, Math.min(limit + 1, 100)))!;
    return { items: (await issuesOf(x, creds, p.elements)).slice(0, limit), complete: p.total <= limit };
  },

  async statuses(x) {
    const list = (await allPages<OpStatus>(await credsOf(x), "/statuses")) ?? [];
    return [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(statusOf);
  },

  async description(x, ref) {
    const wp = await workPackage(await credsOf(x), ref);
    return wp?.description?.raw ? bodyOf(wp.description) : null;
  },

  transitions: {
    async list(x, ref): Promise<Transition[]> {
      const creds = await credsOf(x);
      const id = wpId(ref);
      const wp = await workPackage(creds, ref);
      if (!wp) throw new ProviderError("notFound", `OpenProject: no work package ${ref.key}`);
      // The form shows what this user may do now: the statuses the workflow of the type and their roles allow from here (the current one among them). Asking changes nothing.
      const form = await opOk<{ _embedded?: { schema?: { status?: Parameters<typeof allowedValues>[1] } } }>(creds, `/work_packages/${enc(id)}/form`, { method: "POST", body: "{}", intent: "read" });
      const allowed = await allowedValues<OpStatus>(creds, form._embedded?.schema?.status);
      // A form that names its statuses by link gives no `isClosed`: the instance's statuses say it.
      const all = allowed.some((a) => !a.value) ? new Map(((await allPages<OpStatus>(creds, "/statuses")) ?? []).map((s) => [String(s.id), s])) : new Map<string, OpStatus>();
      const current = idOfHref(wp._links.status?.href);
      const url = `${webOf(x)}/work_packages/${id}`;
      return allowed
        .filter((a) => a.id !== current)
        .map((a) => ({ id: `status:${a.id}`, name: a.name, to: statusOf(a.value ?? all.get(a.id) ?? { id: Number(a.id), name: a.name }), requirements: [], remoteUrl: url }));
    },
    async apply(x, ref, transitionId) {
      const creds = await credsOf(x);
      const m = /^status:(\d+)$/.exec(transitionId);
      if (!m) throw new ProviderError("invalid", `OpenProject: not a transition: ${transitionId}`);
      // The change is made at the revision just read: someone changing it meanwhile is a conflict (409), read again by the core.
      const wp = await workPackage(creds, ref);
      if (!wp) throw new ProviderError("notFound", `OpenProject: no work package ${ref.key}`);
      const done = await opOk<OpWorkPackage>(creds, `/work_packages/${enc(wpId(ref))}`, {
        method: "PATCH",
        body: JSON.stringify({ lockVersion: wp.lockVersion, _links: { status: { href: hrefOf(`/statuses/${m[1]}`) } } }),
      });
      return (await issuesOf(x, creds, [done]))[0] ?? null;
    },
  },

  worklogs: {
    async list(x, ref) {
      const creds = await credsOf(x);
      const filters: Filter[] = [{ workPackage: { operator: "=", values: [wpId(ref)] } }];
      const list = (await allPages<OpTimeEntry>(creds, `/time_entries?${filtersQuery(filters)}&${sortQuery([["id", "asc"]])}`)) ?? [];
      return list.map((e) => toRemoteWorklog(e, ref));
    },
    async get(x, ref, id) {
      const e = await op<OpTimeEntry>(await credsOf(x), `/time_entries/${enc(id)}`, { missingIsNull: true });
      return e ? toRemoteWorklog(e, ref) : null;
    },
    changed: (x, q) => entriesPass(x, q),
    async create(x, ref, w) {
      const made = await opOk<OpTimeEntry>(await credsOf(x), "/time_entries", { method: "POST", body: JSON.stringify(entryBody(w, { workPackage: wpId(ref) })) });
      return toRemoteWorklog(made, ref);
    },
    async update(x, ref, id, w, m) {
      const creds = await credsOf(x);
      const entry = await opOk<OpTimeEntry>(creds, `/time_entries/${enc(id)}`);
      if (m.expectedVersion !== undefined && versionOf(entry) !== m.expectedVersion) throw new ProviderError("conflict", `OpenProject: time entry ${id} changed meanwhile`);
      // Who logged an entry is fixed: moving it to someone else is not a change OpenProject takes.
      if (w.onBehalfOfRemoteId && w.onBehalfOfRemoteId !== idOfHref(entry._links.user?.href)) throw new ProviderError("invalid", "OpenProject keeps who logged an entry: it can't be changed");
      const made = await opOk<OpTimeEntry>(creds, `/time_entries/${enc(id)}`, {
        method: "PATCH",
        body: JSON.stringify(entryBody({ ...w, onBehalfOfRemoteId: undefined }, entry.lockVersion !== undefined ? { lockVersion: entry.lockVersion } : {})),
      });
      return toRemoteWorklog(made, ref);
    },
    async delete(x, _ref, id, m) {
      const creds = await credsOf(x);
      if (m.expectedVersion !== undefined) {
        const entry = await op<OpTimeEntry>(creds, `/time_entries/${enc(id)}`, { missingIsNull: true });
        if (!entry) return;
        if (versionOf(entry) !== m.expectedVersion) throw new ProviderError("conflict", `OpenProject: time entry ${id} changed meanwhile`);
      }
      // Already gone is what was asked for.
      await op(creds, `/time_entries/${enc(id)}`, { method: "DELETE", missingIsNull: true });
    },
    async activities(x, scope, limit) {
      const creds = await credsOf(x);
      // The activities are the form's allowed values for the entry: they depend on the project (a project may switch some off).
      const payload = scope.issue ? { _links: { workPackage: { href: hrefOf(`/work_packages/${wpId(scope.issue)}`) } } } : {};
      const form = await opOk<{ _embedded?: { schema?: { activity?: Parameters<typeof allowedValues>[1] } } }>(creds, "/time_entries/form", { method: "POST", body: JSON.stringify(payload), intent: "read" });
      const types = await allowedValues<OpActivityType>(creds, form._embedded?.schema?.activity);
      const items: CatalogItem[] = types.slice(0, limit).map((t) => ({ id: t.id, name: t.name }));
      return { items, complete: types.length <= limit };
    },
  },

  comments: {
    async list(x, ref) {
      const list = await allPages<OpActivity>(await credsOf(x), `/work_packages/${enc(wpId(ref))}/activities`, { missingIsNull: true });
      if (list === null) throw new ProviderError("notFound", `OpenProject: no work package ${ref.key}`);
      // Changes and comments share one list; a revision (a commit) is not a comment.
      return list.filter((a) => a._type !== "Activity::Revision" && !!a.comment?.raw).map((a) => toRemoteComment(webOf(x), a));
    },
    async add(x, ref, body) {
      // Comments are Markdown: CommonMark goes as is.
      const a = await opOk<OpActivity>(await credsOf(x), `/work_packages/${enc(wpId(ref))}/activities`, { method: "POST", body: JSON.stringify({ comment: { raw: body } }) });
      return { comment: toRemoteComment(webOf(x), a), warnings: [] };
    },
  },

  async watch(x, ref, on) {
    const creds = await credsOf(x);
    const id = enc(wpId(ref));
    const me = x.conn.remoteAccountId;
    // Adding a watcher twice answers 200, removing one who isn't there 404: both are what was asked for.
    if (on) await opOk(creds, `/work_packages/${id}/watchers`, { method: "POST", body: JSON.stringify({ user: { href: hrefOf(`/users/${me}`) } }) });
    else await op(creds, `/work_packages/${id}/watchers/${enc(me)}`, { method: "DELETE", missingIsNull: true });
  },

  async history(x, ref) {
    const list = await allPages<OpActivity>(await credsOf(x), `/work_packages/${enc(wpId(ref))}/activities`, { missingIsNull: true });
    if (list === null) throw new ProviderError("notFound", `OpenProject: no work package ${ref.key}`);
    return list.flatMap((a) => (a.details ?? []).map((d) => toRemoteChange(webOf(x), a, d)));
  },
};
