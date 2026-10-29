// YouTrack (Cloud and self-hosted) as a tracker, through the provider contract.
// Issues assigned to the user (`for: me`), keyed PROJ-12 (idReadable, upper
// case: lookups are case-insensitive); the status is the State custom field,
// found by its type (its name is localized), with the category derived from
// the bundle's `isResolved` and the state's name. Time is work items, kept by
// date in whole minutes. Built from the API's documentation on a simulator,
// not yet on a real account: docs/dev/spikes.md, section YouTrack.
import { secretOf } from "../core/context";
import { wholeMinutes } from "../core/time";
import { toYouTrackQuery } from "./translate";
import { verifyYouTrackWebhook } from "./webhook";
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, jsonPayload, localDate, type LocalDate, type Instant, type JsonValue } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { IncompatibleResultError } from "../core/results";
import type {
  CallContext,
  ChangeValue,
  Checkpoint,
  CatalogItem,
  IssueHandle,
  IssueRef,
  PageQuery,
  RemoteBody,
  RemoteChange,
  RemoteComment,
  RemoteIssue,
  RemotePerson,
  RemoteStatus,
  RemoteWorklog,
  Stream,
  TrackerProvider,
  Transition,
  WorklogInput,
} from "../types";
import {
  FIELDS,
  allPages,
  paged,
  webBaseOf,
  yt,
  ytOk,
  type YouTrackCreds,
  type YtActivity,
  type YtBundleValue,
  type YtComment,
  type YtCustomField,
  type YtFieldValue,
  type YtIssue,
  type YtUser,
  type YtWorkItem,
} from "./client";
import { assignedQuery, checkQuery, textQuery } from "./translate";
import { statusSteps } from "../core/statusSteps";

export { verifyYouTrackWebhook } from "./webhook";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

export const youtrackCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: "youtrack",
  comments: { mode: "readWrite", formats: ["commonmark"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: true,
  history: true,
  statusHistory: true,
  workflow: { sources: [{ kind: "itemState", transitions: "allowedList" }] },
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "native", delete: true },
      // Changed work items by a filter across issues; a deleted one just vanishes (reconciled by period).
      feed: { kind: "incremental", removals: false },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
      activities: { read: true, write: true, required: "no" },
      onBehalf: { read: true, write: true },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "none",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    // `for: me` only lists what is still assigned: departures are found by reconciliation.
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "none" },
    // Signals: the body only says which issue changed (webhook.ts, to verify).
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
      { event: "worklogChanged", payload: "signal" },
    ],
  },
};

export const youtrackTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: ["sprint", "version"],
  fields: ["priority", "due", "estimate", "points", "labels", "custom"],
};

const optionsSchema = z.strictObject({
  /** Project IDs (short names, PROJ) left out of the sync */
  excludeProjects: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(500).default([]),
});
export type YouTrackOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"youtrack", YouTrackOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/**
 * Where a pass is: `skip` is the position of the next unread item, `tail` the
 * ids of the last few read. YouTrack pages by offset, and an item changed
 * during the pass moves in the order (updated asc) and shifts the rest by one:
 * each page therefore starts TAIL positions back, and what it has already
 * given is left out.
 */
type PassAt = { skip: number; tail: string[]; at: number };

/** Overlap read again at each pass: query dates are days in the user's zone, `updated` may land late. */
const OVERLAP_MS = 5 * 60_000;
const PER_PAGE = 100;
const TAIL = 4;

async function credsOf(x: X): Promise<YouTrackCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

// ---------- Keys and links ----------

const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d{1,9}$/;
/** An internal id: `<project number>-<sequence>` (stable across moves, unlike the readable key). */
const DB_ID = /^\d+-\d+$/;
const normalizeKey = (raw: string) => (KEY.test(raw.trim()) ? raw.trim().toUpperCase() : null);

const enc = encodeURIComponent;
/** An issue by its stable id, else its key: both answer on `/issues/{id}` (an old key too, after a move). */
const issueId = (ref: { remoteId: string; key: string }) => enc(ref.remoteId || ref.key);

// ---------- Values ----------

const at = (ms: unknown): Instant | null => (typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? instant(Math.trunc(ms)) : null);

/** A work date: a timestamp at 00:00 UTC of the day. */
const dateOfMs = (ms: number): LocalDate => localDate(new Date(ms).toISOString().slice(0, 10));
const msOfDate = (d: LocalDate) => Date.parse(`${d}T00:00:00Z`);

/** Relative avatar paths (/hub/api/rest/avatar/...) are made absolute on the site. */
const absolute = (web: string, url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url, `${web}/`).toString();
  } catch {
    return null;
  }
};

const person = (web: string, u: Pick<YtUser, "id" | "login" | "name" | "fullName" | "avatarUrl">): RemotePerson => ({
  remoteId: u.id,
  name: u.fullName || u.name || u.login || "",
  avatarUrl: absolute(web, u.avatarUrl),
  ...(u.login ? { handle: u.login } : {}),
});

const CANCELLED = /won'?t|will not|obsolete|duplicate|declined|reject|cancel|can'?t reproduce|annull|non (si )?risolv/i;
const DOING = /progress|doing|started|working|review|testing|in corso|lavorazione/i;
/**
 * A State's category. YouTrack says only resolved or not (`isResolved`): the
 * rest comes from the usual names, English and Italian (spike youtrack-state-categories).
 */
export function categoryOf(name: string, resolved: boolean): StatusCategory {
  if (resolved) return CANCELLED.test(name) ? "cancelled" : "done";
  return DOING.test(name) ? "doing" : "todo";
}

const statusOfName = (name: string, resolved: boolean): RemoteStatus => ({
  id: name,
  name,
  category: categoryOf(name, resolved),
  categoryOrigin: { by: "native" },
  source: { kind: "itemState" },
  nativeReason: resolved ? name : null,
});

/** The State field is found by its type: its name is localized (Stato, Zustand...). */
const isState = (f: YtCustomField) => /^State(Machine)?IssueCustomField$/.test(f.$type);
const one = (v: YtCustomField["value"]): YtFieldValue | null => {
  const first = Array.isArray(v) ? v[0] : v;
  return first && typeof first === "object" ? first : null;
};
const many = (v: YtCustomField["value"]): YtFieldValue[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const field = (i: YtIssue, re: RegExp) => i.customFields?.find((f) => re.test(f.name) && !isState(f));

function statusOf(i: YtIssue): RemoteStatus {
  const f = i.customFields?.find(isState);
  const v = one(f?.value);
  const resolved = v?.isResolved ?? (i.resolved != null);
  return statusOfName(v?.name ?? (resolved ? "Resolved" : "Unknown"), resolved);
}

export function toRemoteIssue(web: string, i: YtIssue): RemoteIssue {
  const p = i.project;
  const priority = one(field(i, /^priority$/i)?.value);
  const type = one(field(i, /^type$/i)?.value);
  const due = field(i, /^due date$/i)?.value;
  const estimate = one(field(i, /^estimation$/i)?.value)?.minutes;
  const spent = one(field(i, /^spent time$/i)?.value)?.minutes;
  const assignees = (i.customFields ?? []).filter((f) => /UserIssueCustomField$/.test(f.$type) && /^assignees?$/i.test(f.name)).flatMap((f) => many(f.value));
  const key = i.idReadable.toUpperCase();
  return {
    remoteId: i.id,
    key,
    url: `${web}/issue/${key}`,
    title: i.summary ?? "",
    type: type?.name ? { id: type.id ?? type.name, name: type.name } : { id: "issue", name: "Issue" },
    status: statusOf(i),
    container: { remoteId: p?.id ?? key.split("-")[0], key: p?.shortName ?? key.split("-")[0], name: p?.name ?? p?.shortName ?? "", kind: "project" },
    priority: priority?.name ? { id: priority.id ?? priority.name, name: priority.name, rank: null } : null,
    labels: (i.tags ?? []).map((t) => t.name),
    assignees: assignees.filter((u): u is YtFieldValue & { id: string } => !!u.id).map((u) => person(web, u)),
    reporter: i.reporter ? person(web, i.reporter) : null,
    due: typeof due === "number" ? dateOfMs(due) : null,
    estimateSeconds: typeof estimate === "number" ? estimate * 60 : null,
    spentSeconds: typeof spent === "number" ? spent * 60 : null,
    createdAt: at(i.created),
    updatedAt: at(i.updated),
    statusChangedAt: at(i.resolved),
  };
}

const webOf = (x: X) => webBaseOf(x.conn.baseUrl);
const issueOf = (x: X, i: YtIssue) => toRemoteIssue(webOf(x), i);
const excluded = (x: X) => new Set(x.conn.options.excludeProjects.map((p) => p.toUpperCase()));
const kept = (x: X, list: YtIssue[]) => {
  const out = excluded(x);
  return list.filter((i) => !out.has((i.project?.shortName ?? i.idReadable.split("-")[0]).toUpperCase())).map((i) => issueOf(x, i));
};

// ---------- Passes ----------

/** One page of an offset-paged, change-ordered read (see PassAt). */
async function pass<T extends { id: string }>(
  x: X,
  stream: Stream,
  q: PageQuery,
  read: (top: number, skip: number, since: number | null) => Promise<T[]>,
): Promise<{ fresh: T[]; last: Checkpoint | null; next: ReturnType<typeof encodePageToken> | null }> {
  const since = decodeCheckpoint<Since>(x.conn, stream, V, q.since)?.at ?? null;
  const here = decodePageToken<PassAt>(x.conn, stream, V, q.since, q.page) ?? { skip: 0, tail: [], at: Date.now() };
  const from = Math.max(0, here.skip - TAIL);
  const got = await read(PER_PAGE, from, since);
  const seen = new Set(here.tail);
  const fresh = got.filter((i) => !seen.has(i.id));
  if (fresh.length === 0) return { fresh, last: encodeCheckpoint(x.conn, stream, V, { at: here.at - OVERLAP_MS } satisfies Since), next: null };
  const skip = from + got.length;
  if (here.skip > 0 && skip <= here.skip) throw new IncompatibleResultError("YouTrack cut pages below the overlap: no progress");
  return { fresh, last: null, next: encodePageToken(x.conn, stream, V, q.since, { skip, tail: got.slice(-TAIL).map((i) => i.id), at: here.at } satisfies PassAt) };
}

async function issuesPage(creds: YouTrackCreds, query: string, limit: number, skip = 0): Promise<YtIssue[]> {
  return ytOk<YtIssue[]>(creds, paged(`/issues?query=${enc(query)}&fields=${enc(FIELDS.issue)}`, limit, skip));
}

async function search(x: X, query: string, limit: number) {
  const found = await issuesPage(await credsOf(x), query, limit + 1);
  return { items: kept(x, found).slice(0, limit), complete: found.length <= limit };
}

// ---------- Work items ----------

const MINUTE = 60;

/** YouTrack keeps durations in whole minutes: seconds are rounded to the nearest, at least one. */
const minutesOf = wholeMinutes;

export function toRemoteWorklog(w: YtWorkItem, me: string, issue?: { id: string; key: string }): RemoteWorklog {
  const mine = (w.author?.id ?? "") === me;
  const date = typeof w.date === "number" ? dateOfMs(w.date) : localDate("1970-01-01");
  return {
    remoteId: w.id,
    issue: w.issue ? { remoteId: w.issue.id, ...(w.issue.idReadable ? { key: w.issue.idReadable.toUpperCase() } : {}) } : issue ? { remoteId: issue.id, key: issue.key } : null,
    span: { kind: "date", date, seconds: (w.duration?.minutes ?? 0) * MINUTE },
    comment: w.text ?? "",
    authorRemoteId: w.author?.id ?? "",
    createdAt: at(w.created),
    updatedAt: at(w.updated),
    activity: w.type?.name ? { id: w.type.id, name: w.type.name } : null,
    // Someone else's entries: YouTrack's permissions decide; inkledger only offers the user's own.
    editable: { update: mine, delete: mine },
  };
}

function workItemBody(w: WorklogInput) {
  if (w.time.kind !== "date") throw new ProviderError("invalid", `YouTrack keeps work items by date, not a ${w.time.kind}`);
  return {
    date: msOfDate(w.time.date),
    duration: { minutes: minutesOf(w.time.seconds) },
    text: w.comment,
    ...(w.activityId ? { type: { id: w.activityId } } : {}),
    ...(w.onBehalfOfRemoteId ? { author: { id: w.onBehalfOfRemoteId } } : {}),
  };
}

// ---------- Comments, history ----------

const toRemoteComment = (web: string, c: YtComment): RemoteComment => ({
  id: c.id,
  author: c.author ? person(web, c.author) : { remoteId: "", name: "" },
  body: { kind: "text", format: "commonmark", text: c.text ?? "" },
  createdAt: at(c.created),
  updatedAt: at(c.updated),
});

const CATEGORIES = ["CustomFieldCategory", "SummaryCategory", "DescriptionCategory", "TagsCategory", "ProjectCategory", "LinksCategory"].join(",");

function changeValues(v: unknown): ChangeValue[] {
  return (Array.isArray(v) ? v : v == null ? [] : [v])
    .map((item): ChangeValue => {
      if (item !== null && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const text = [o.name, o.fullName, o.login, o.presentation, o.text].find((s): s is string => typeof s === "string") ?? "";
        const raw: JsonValue | null = jsonPayload(item);
        return { text, ...(typeof o.id === "string" ? { id: o.id } : {}), ...(raw !== null ? { raw } : {}) };
      }
      return { text: String(item) };
    })
    .filter((c) => c.text !== "");
}

/** An issue's activities, every page. */
async function activitiesOf(x: X, ref: IssueRef): Promise<YtActivity[]> {
  // `categories` is required: without it the activities endpoint refuses.
  const list = await allPages<YtActivity>(await credsOf(x), `/issues/${issueId(ref)}/activities?categories=${enc(CATEGORIES)}&fields=${enc(FIELDS.activity)}`, { missingIsNull: true });
  if (list === null) throw new ProviderError("notFound", `YouTrack: no issue ${ref.key}`);
  return list;
}

const toRemoteChange = (web: string, a: YtActivity): RemoteChange => ({
  at: at(a.timestamp) ?? instant(0),
  actor: a.author ? person(web, a.author) : null,
  field: { ...(a.field?.id ? { id: a.field.id } : {}), name: a.field?.name ?? a.category?.id.replace(/Category$/, "") ?? "" },
  from: changeValues(a.removed),
  to: changeValues(a.added),
});

// ---------- Workflow ----------

/** The State field of an issue read with FIELDS.issue, and what it can move to. */
function stateOf(i: YtIssue) {
  const f = i.customFields?.find(isState);
  if (!f) return null;
  const values: YtBundleValue[] = [...(f.projectCustomField?.bundle?.values ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  return { f, values, current: one(f.value)?.name ?? null, machine: f.$type === "StateMachineIssueCustomField" };
}

async function issueByRef(creds: YouTrackCreds, ref: { remoteId: string; key: string }, fields: string = FIELDS.issue): Promise<YtIssue | null> {
  const get = (id: string) => yt<YtIssue>(creds, `/issues/${enc(id)}?fields=${enc(fields)}`, { missingIsNull: true });
  // The stable id first; the key only when the id is unknown (never decides which issue it is).
  const byId = ref.remoteId ? await get(ref.remoteId) : null;
  if (byId) return byId;
  const byKey = ref.key ? await get(ref.key) : null;
  return byKey && (!ref.remoteId || byKey.id === ref.remoteId) ? byKey : null;
}

export const youtrackProvider: TrackerProvider<"youtrack", YouTrackOptions> = {
  translate: (expr, now) => toYouTrackQuery(expr, now),

  // A workflow posts deliveries with the connection's secret in a header (spike: youtrack-webhook).
  webhook: {
    verify: (req, secret) => verifyYouTrackWebhook(req.headers, req.body, secret).ok,
    deliveryId: (req) => {
      const c = verifyYouTrackWebhook(req.headers, req.body, "");
      return c.ok ? c.deliveryId : (req.headers["x-inkledger-delivery"] ?? null);
    },
  },
  role: "tracker",
  type: "youtrack",
  capabilities: youtrackCapabilities,
  traits: youtrackTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `YouTrack options: ${r.error.issues.map((i) => i.message).join("; ")}`);
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
      // https://x.youtrack.cloud/issue/PROJ-12, .../issue/PROJ-12/Title, a self-hosted context path before /issue, or the internal id.
      const prefix = site.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith(`${prefix}/issue/`)) return null;
      const id = decodeURIComponent(url.pathname.slice(prefix.length + "/issue/".length).split("/")[0] ?? "");
      const k = normalizeKey(id);
      if (k) return { key: k };
      return DB_ID.test(id) ? { remoteId: id } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await ytOk<YtUser>(await credsOf(x), `/users/me?fields=${enc(FIELDS.user)}`);
    // A request without a valid token may be answered as the guest account: never a connection.
    if (me.guest || me.login === "guest") throw new ProviderError("auth", "YouTrack: the token is anonymous (guest)");
    return { ...person(webOf(x), me), ...(me.login ? { login: me.login } : {}), ...(me.email ? { email: me.email } : {}) };
  },

  async probe() {
    return {
      capabilities: youtrackCapabilities,
      // Every project's State field as one source (its bundle is read per project by `statuses`).
      activeSources: [{ kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" }, name: "State" }],
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const p = await pass<YtIssue>(x, "issues", q, (top, skip, since) => issuesPage(creds, assignedQuery(since === null ? null : since - OVERLAP_MS), top, skip));
    // The query's date is a day in the user's zone, cut wider than needed: the exact cut is on `updated`.
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    const items = kept(x, since === null ? p.fresh : p.fresh.filter((i) => (i.updated ?? Infinity) >= since - OVERLAP_MS));
    return p.last ? { last: true, items, gone: [], checkpoint: p.last } : { last: false, items, gone: [], next: p.next! };
  },

  async getIssue(x, ref) {
    const i = await issueByRef(await credsOf(x), ref);
    return i ? issueOf(x, i) : null;
  },

  async findIssue(x, handle) {
    const creds = await credsOf(x);
    const key = handle.key ? normalizeKey(handle.key) : null;
    if (handle.key && !key && !handle.remoteId) return { kind: "none" };
    const i = await issueByRef(creds, { remoteId: handle.remoteId ?? "", key: key ?? "" });
    // Keys are unique on an instance: never ambiguous.
    return i ? { kind: "found", issue: issueOf(x, i) } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    const q = textQuery(text);
    return q ? search(x, `${q} sort by: updated desc`, limit) : { items: [], complete: true };
  },

  async query(x, query, limit) {
    return search(x, checkQuery(query), limit);
  },

  async statuses(x, source) {
    const creds = await credsOf(x);
    const only = source.ref.kind === "itemState" ? source.ref.containerRemoteId : undefined;
    const projects = only ? [{ id: only }] : ((await allPages<{ id: string }>(creds, `/admin/projects?fields=${enc("id")}`)) ?? []).slice(0, 50);
    const byName = new Map<string, { v: YtBundleValue; order: number }>();
    for (const pr of projects) {
      const fieldsOfProject = await yt<{ $type: string; bundle?: { values?: YtBundleValue[] } }[]>(creds, `/admin/projects/${enc(pr.id)}/customFields?fields=${enc("$type,bundle(values(id,name,isResolved,ordinal))")}`, { missingIsNull: true });
      for (const f of fieldsOfProject ?? []) {
        if (!/^State/.test(f.$type)) continue;
        for (const v of f.bundle?.values ?? []) if (!byName.has(v.name)) byName.set(v.name, { v, order: v.ordinal ?? 0 });
      }
    }
    return [...byName.values()].sort((a, b) => a.order - b.order).map(({ v, order }) => ({ ...statusOfName(v.name, v.isResolved === true), order }));
  },

  async description(x, ref) {
    const i = await issueByRef(await credsOf(x), ref, FIELDS.description);
    const text = i?.description;
    return text ? ({ kind: "text", format: "commonmark", text } satisfies RemoteBody) : null;
  },

  transitions: {
    async list(x, ref): Promise<Transition[]> {
      const i = await issueByRef(await credsOf(x), ref);
      if (!i) throw new ProviderError("notFound", `YouTrack: no issue ${ref.key}`);
      const s = stateOf(i);
      if (!s) return [];
      const url = `${webOf(x)}/issue/${i.idReadable.toUpperCase()}`;
      // A state machine offers events, not values: sent as such; where they lead is not said (the name stands for it).
      if (s.machine) {
        return (s.f.possibleEvents ?? []).map((e) => ({ id: `event:${e.id}`, name: e.presentation ?? e.id, to: statusOfName(e.presentation ?? e.id, false), requirements: [], remoteUrl: url }));
      }
      return s.values
        .filter((v) => v.name !== s.current)
        .map((v) => ({ id: `state:${v.name}`, name: v.name, to: statusOfName(v.name, v.isResolved === true), requirements: [], remoteUrl: url }));
    },
    async apply(x, ref, transitionId) {
      const creds = await credsOf(x);
      const i = await issueByRef(creds, ref);
      const s = i ? stateOf(i) : null;
      if (!i || !s) throw new ProviderError("notFound", `YouTrack: no State on ${ref.key}`);
      const [kind, ...rest] = transitionId.split(":");
      const value = rest.join(":");
      const body =
        kind === "event"
          ? { name: s.f.name, $type: s.f.$type, event: { id: value } }
          : kind === "state"
            ? { name: s.f.name, $type: s.f.$type, value: { name: value } }
            : null;
      if (!body) throw new ProviderError("invalid", `YouTrack: not a transition: ${transitionId}`);
      // A workflow that refuses answers 400 with its message: invalid.
      const done = await ytOk<YtIssue>(creds, `/issues/${enc(i.id)}?fields=${enc(FIELDS.issue)}`, { method: "POST", body: JSON.stringify({ customFields: [body] }) });
      return issueOf(x, done);
    },
  },

  worklogs: {
    async list(x, ref) {
      const creds = await credsOf(x);
      const id = ref.remoteId || ref.key;
      const list = (await allPages<YtWorkItem>(creds, `/issues/${enc(id)}/timeTracking/workItems?fields=${enc(FIELDS.workItem)}`, { missingIsNull: true })) ?? [];
      return list.map((w) => toRemoteWorklog(w, x.conn.remoteAccountId, { id: ref.remoteId, key: ref.key }));
    },
    async changed(x, q) {
      const creds = await credsOf(x);
      const me = x.conn.remoteAccountId;
      const p = await pass<YtWorkItem>(x, "worklogs", q, async (top, skip, since) => {
        const filter = `author=${enc(me)}${since !== null ? `&updatedStart=${since - OVERLAP_MS}` : ""}`;
        return ytOk<YtWorkItem[]>(creds, paged(`/workItems?${filter}&fields=${enc(FIELDS.workItem)}`, top, skip));
      });
      const items = p.fresh.map((w) => toRemoteWorklog(w, me));
      // Removals aren't in this feed (declared): a deleted work item is found by reconciliation.
      return p.last ? { last: true, items, gone: [], checkpoint: p.last } : { last: false, items, gone: [], next: p.next! };
    },
    async create(x, ref, w) {
      const made = await ytOk<YtWorkItem>(await credsOf(x), `/issues/${issueId(ref)}/timeTracking/workItems?fields=${enc(FIELDS.workItem)}`, { method: "POST", body: JSON.stringify(workItemBody(w)) });
      return toRemoteWorklog(made, x.conn.remoteAccountId, { id: ref.remoteId, key: ref.key });
    },
    async update(x, ref, id, w) {
      const made = await ytOk<YtWorkItem>(await credsOf(x), `/issues/${issueId(ref)}/timeTracking/workItems/${enc(id)}?fields=${enc(FIELDS.workItem)}`, { method: "POST", body: JSON.stringify(workItemBody(w)) });
      return toRemoteWorklog(made, x.conn.remoteAccountId, { id: ref.remoteId, key: ref.key });
    },
    async delete(x, ref, id) {
      // Already gone is what was asked for.
      await yt(await credsOf(x), `/issues/${issueId(ref)}/timeTracking/workItems/${enc(id)}`, { method: "DELETE", missingIsNull: true });
    },
    async activities(x, scope, limit) {
      const creds = await credsOf(x);
      let types: CatalogItem[];
      if (scope.issue) {
        // Work types are set per project.
        const project = scope.issue.container?.remoteId ?? (await issueByRef(creds, scope.issue, "id,project(id)"))?.project?.id;
        if (!project) throw new ProviderError("notFound", `YouTrack: no issue ${scope.issue.key}`);
        const s = await ytOk<{ workItemTypes?: { id: string; name: string }[] }>(creds, `/admin/projects/${enc(project)}/timeTrackingSettings?fields=${enc("workItemTypes(id,name)")}`);
        types = s.workItemTypes ?? [];
      } else {
        types = await ytOk<CatalogItem[]>(creds, paged(`/admin/timeTrackingSettings/workItemTypes?fields=${enc("id,name")}`, limit + 1, 0));
      }
      return { items: types.slice(0, limit).map((t) => ({ id: t.id, name: t.name })), complete: types.length <= limit };
    },
  },

  comments: {
    async list(x, ref) {
      const list = await allPages<YtComment>(await credsOf(x), `/issues/${issueId(ref)}/comments?fields=${enc(FIELDS.comment)}`, { missingIsNull: true });
      if (list === null) throw new ProviderError("notFound", `YouTrack: no issue ${ref.key}`);
      // A deleted comment is still listed, flagged.
      return list.filter((c) => !c.deleted).map((c) => toRemoteComment(webOf(x), c));
    },
    async add(x, ref, body) {
      // YouTrack's comments are Markdown: CommonMark goes as is.
      const c = await ytOk<YtComment>(await credsOf(x), `/issues/${issueId(ref)}/comments?fields=${enc(FIELDS.comment)}`, { method: "POST", body: JSON.stringify({ text: body }) });
      return { comment: toRemoteComment(webOf(x), c), warnings: [] };
    },
  },

  async watch(x, ref, on) {
    // Starring an issue is watching it; setting what is set is a success.
    await ytOk(await credsOf(x), `/issues/${issueId(ref)}?fields=id`, { method: "POST", body: JSON.stringify({ watchers: { hasStar: on } }) });
  },

  async statusHistory(x, ref) {
    // The State is told by its field's kind, its name being localized; a state's name is its id.
    const state = (await activitiesOf(x, ref)).filter((a) => a.field?.customField?.fieldType?.id?.startsWith("state[") === true);
    return statusSteps(state.map((a) => toRemoteChange(webOf(x), a)), () => true, (v) => v.text);
  },

  async history(x, ref) {
    return (await activitiesOf(x, ref)).map((a) => toRemoteChange(webOf(x), a));
  },
};
