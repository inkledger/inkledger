// Redmine (self-hosted) as a tracker, through the provider contract. Issues
// assigned to the user, keyed #123 (the issue's id is unique on the whole
// server, so a move to another project changes its container, never its
// identity); the status is the issue's own, with the category taken from the
// status list's is_closed and the usual names. Time entries are by date, in
// hours to two places. Built from the API's documentation on a simulator, not
// yet on a real server: SPIKES.md.
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { DAY_MS } from "@contracts/time";
import { instant, instantFrom, localDate, type LocalDate } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { IncompatibleResultError } from "../core/results";
import type {
  CallContext,
  CatalogItem,
  ChangeValue,
  ConversionWarning,
  IssueHandle,
  IssueRef,
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
  paged,
  rd,
  rdOk,
  rdPages,
  webBaseOf,
  type Listed,
  type RedmineCreds,
  type RmIssue,
  type RmJournal,
  type RmProject,
  type RmRef,
  type RmStatus,
  type RmTimeEntry,
  type RmUser,
} from "./client";
import { redmineDeliveryId, redmineSentAt, verifyRedmineWebhook } from "./webhook";
import { statusSteps } from "../core/statusSteps";

export { redmineDeliveryId, redmineSentAt, verifyRedmineWebhook };

// The catalogue's entry for redmine, here where the adapter keeps to it (the
// registry holds the two together).
export const redmineCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  // Textile (or, by the server's setting, Markdown): read as textile; written as paragraphs.
  comments: { mode: "readWrite", formats: ["textile"], writePreserves: ["paragraph"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: true,
  inbox: false,
  otherFields: false,
  history: true,
  statusHistory: true,
  // The issue's status, and (Redmine 5.0+) the statuses its workflow allows next.
  workflow: { sources: [{ kind: "itemState", transitions: "allowedList" }] },
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "date",
      write: { mode: "entry", update: "native", delete: true },
      // A change filter on time entries (verify: redmine-time-feed): until then re-read by entry day
      feed: { kind: "window", by: "entryDate", days: 30, overlapDays: 2 },
      reconcile: { kind: "period" },
      billable: { read: false, write: false },
      // The server's default activity is used when none is given (an entry always has one).
      activities: { read: true, write: true, required: "serviceDefault" },
      onBehalf: { read: true, write: true },
      approvals: { read: false },
      idempotency: "local",
      concurrency: "none",
      limits: {},
    },
  },
  sync: {
    issueCheckpoints: true,
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "none" },
    // A plugin's signal (SPIKES.md, redmine-webhook): the body only says which issue changed.
    webhooks: [{ event: "issueChanged", payload: "signal" }],
  },
};

export const redmineTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: true,
  attachments: { read: true, upload: true },
  timeboxes: ["version"],
  fields: ["priority", "due", "start", "estimate", "custom"],
};

const optionsSchema = z.strictObject({});
export type RedmineOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"redmine", RedmineOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/**
 * Where an issue pass is: `skip` is the position of the next unread item,
 * `tail` the ids of the last few read, `max` the latest `updated_on` seen,
 * `now` the server's clock when the pass began. Redmine pages by offset, and an
 * item changed during the pass moves in the order (updated_on asc) and shifts
 * the rest by one: each page therefore starts TAIL positions back, and what
 * it has already given is left out.
 */
type PassAt = { skip: number; tail: number[]; max: number | null; now: number };
type EntriesAt = { offset: number; from: string; to: string; at: number };

/** Overlap read again at each pass: updated_on is to the second, and a write may land after the clock that stamps it. */
const OVERLAP_MS = 60_000;
/** limit tops out at 100 whatever is asked. */
const PER_PAGE = 100;
const TAIL = 4;
/** The feed window the capabilities declare: 30 days and 2 of overlap. */
const WINDOW_DAYS = 32;

async function credsOf(x: X): Promise<RedmineCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

// ---------- Keys and links ----------

/** #123, as people write an issue in Redmine. */
const KEY = /^#(\d{1,9})$/;
const normalizeKey = (raw: string) => {
  const m = KEY.exec(raw.trim());
  return m ? `#${Number(m[1])}` : null;
};
const keyOfId = (id: number | string) => `#${id}`;

/** The numeric id an issue reference points at: its id, else its key. */
function idOf(ref: { remoteId?: string; key?: string }): number | null {
  if (ref.remoteId && /^\d+$/.test(ref.remoteId)) return Number(ref.remoteId);
  const key = ref.key ? normalizeKey(ref.key) : null;
  return key ? Number(key.slice(1)) : null;
}

// ---------- Values ----------

const day = (text: string | null | undefined): LocalDate | null => {
  if (!text || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  try {
    return localDate(text.slice(0, 10));
  } catch {
    return null;
  }
};

const secondsOf = (hours: number | null | undefined) => (typeof hours === "number" && Number.isFinite(hours) ? Math.round(hours * 3600) : null);

/** Redmine keeps hours to two places: 36-second steps, nearest. */
function hoursOf(seconds: number): number {
  const hours = Math.round(seconds / 36) / 100;
  if (hours <= 0) throw new ProviderError("invalid", "Redmine keeps hours to two places: an entry shorter than 18 seconds would be stored as nothing");
  return hours;
}

const person = (u: RmRef | RmUser | null | undefined): RemotePerson => {
  if (!u) return { remoteId: "", name: "" };
  const full = "firstname" in u || "lastname" in u ? `${(u).firstname ?? ""} ${(u).lastname ?? ""}`.trim() : "";
  const login = (u as RmUser).login;
  return { remoteId: String(u.id), name: full || (u).name || login || "", ...(login ? { handle: login } : {}) };
};

// ---------- Statuses ----------

const CANCELLED = /reject|won'?t|wont|invalid|duplicate|cancel|abandon|obsolete|declin|rifiut|annull|respint|scartat|non (si )?risolv/i;
const DOING = /progress|doing|started|working|review|testing|feedback|resolved|assigned|in corso|lavorazione|risolt|assegnat|verifica|revisione/i;
/**
 * A status's category. Redmine says only whether a status closes the issue
 * (`is_closed`); the rest comes from the usual names, English and Italian
 * (SPIKES.md, redmine-status-categories). A Resolved status stays open by
 * default in Redmine: it is not done until it is closed.
 */
export function categoryOf(name: string, closed: boolean): StatusCategory {
  if (closed) return CANCELLED.test(name) ? "cancelled" : "done";
  return DOING.test(name) ? "doing" : "todo";
}

const statusOf = (id: number, name: string, closed: boolean): RemoteStatus => ({
  id: String(id),
  name,
  category: categoryOf(name, closed),
  categoryOrigin: { by: "native" },
  source: { kind: "itemState" },
  nativeReason: closed ? name : null,
});

/** What a server's statuses and projects look like, read at most every so often and when an issue names one not in it. */
type Catalog = { statuses: Map<number, RmStatus>; projects: Map<number, RmProject>; at: number };
const catalogs = new WeakMap<object, Catalog>();
const RELOAD_MS = 30_000;

/**
 * The server's statuses (the issue's own status has no is_closed) and projects
 * (the issue names its project by id and name, not by identifier). Cached per
 * connection; read again, at most every 30 s, when an issue names a status or
 * project it doesn't have (an archived or invisible project stays unknown).
 */
async function catalogFor(x: X, c: RedmineCreds, issues: RmIssue[]): Promise<Catalog> {
  const known = catalogs.get(x.conn);
  const lacks = (cat: Catalog) => issues.some((i) => !cat.statuses.has(i.status.id) || !cat.projects.has(i.project.id));
  if (known && (!lacks(known) || Date.now() - known.at < RELOAD_MS)) return known;
  const [list, projects] = await Promise.all([rdOk<{ issue_statuses?: RmStatus[] }>(c, "/issue_statuses.json"), rdPages<RmProject>(c, "/projects.json", "projects")]);
  const fresh: Catalog = {
    statuses: new Map((list.issue_statuses ?? []).map((s) => [s.id, s])),
    projects: new Map((projects ?? []).map((p) => [p.id, p])),
    at: Date.now(),
  };
  catalogs.set(x.conn, fresh);
  return fresh;
}

// ---------- Shaping ----------

export function toRemoteIssue(web: string, cat: Catalog, i: RmIssue): RemoteIssue {
  const known = cat.statuses.get(i.status.id);
  const closed = i.status.is_closed ?? known?.is_closed ?? i.closed_on != null;
  const p = cat.projects.get(i.project.id);
  const fields = Object.fromEntries((i.custom_fields ?? []).map((f) => [String(f.id), f.value ?? null]));
  return {
    remoteId: String(i.id),
    key: keyOfId(i.id),
    url: `${web}/issues/${i.id}`,
    title: i.subject,
    type: i.tracker ? { id: String(i.tracker.id), name: i.tracker.name ?? "", level: i.parent ? "sub" : "standard" } : { id: "issue", name: "Issue", level: i.parent ? "sub" : "standard" },
    status: statusOf(i.status.id, i.status.name || known?.name || "", closed),
    // The project by id; its identifier from the project list (unknown for an archived one: the id stands for it).
    container: {
      remoteId: String(i.project.id),
      key: p?.identifier ?? String(i.project.id),
      name: i.project.name ?? p?.name ?? "",
      kind: "project",
      group: p?.parent?.name ?? null,
    },
    priority: i.priority ? { id: String(i.priority.id), name: i.priority.name ?? "", rank: null } : null,
    labels: [],
    assignees: i.assigned_to ? [person(i.assigned_to)] : [],
    reporter: i.author ? person(i.author) : null,
    due: day(i.due_date),
    estimateSeconds: secondsOf(i.estimated_hours),
    spentSeconds: secondsOf(i.spent_hours),
    createdAt: instantFrom(i.created_on),
    updatedAt: instantFrom(i.updated_on),
    statusChangedAt: instantFrom(i.closed_on),
    parent: i.parent ? { remoteId: String(i.parent.id), key: keyOfId(i.parent.id) } : null,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

const webOf = (x: X) => webBaseOf(x.conn.baseUrl);

async function shapeAll(x: X, c: RedmineCreds, list: RmIssue[]): Promise<RemoteIssue[]> {
  if (list.length === 0) return [];
  const cat = await catalogFor(x, c, list);
  const web = webOf(x);
  return list.map((i) => toRemoteIssue(web, cat, i));
}

// ---------- Finding an issue ----------

const issuePath = (id: number, include?: string) => `/issues/${id}.json${include ? `?include=${include}` : ""}`;

/** An issue as it is now; null when there is none, or when Redmine says 403 (it exists but isn't the user's to see). */
async function fetchIssue(c: RedmineCreds, id: number, include?: string): Promise<RmIssue | null> {
  const r = await rd<{ issue: RmIssue }>(c, issuePath(id, include), { missingIsNull: true, hiddenIsNull: true });
  return r?.data.issue ?? null;
}

/** For an operation: a missing issue is notFound, and a hidden one is forbidden (Redmine's 403 reaches the caller). */
async function mustIssue(c: RedmineCreds, ref: IssueRef, include?: string): Promise<RmIssue> {
  const id = idOf(ref);
  const r = id === null ? null : await rd<{ issue: RmIssue }>(c, issuePath(id, include), { missingIsNull: true });
  if (!r) throw new ProviderError("notFound", `Redmine: no issue ${ref.key}`);
  return r.data.issue;
}

const meId = (x: X) => {
  const id = Number(x.conn.remoteAccountId);
  if (!Number.isInteger(id) || id <= 0) throw new ProviderError("invalid", "Redmine: the connection does not know its user id");
  return id;
};

// ---------- Passes and search ----------

const issuesQuery = (params: Record<string, string>) => new URLSearchParams({ status_id: "*", ...params }).toString();

async function search(x: X, text: string, limit: number) {
  const c = await credsOf(x);
  const needle = text.trim();
  if (!needle) return { items: [], complete: true };
  const per = Math.min(100, limit + 1);
  // Only the user's own: assigned to them or written by them, in the subject or the description (Redmine's filters take one field at a time).
  const lists = await Promise.all(
    (["assigned_to_id", "author_id"] as const).flatMap((who) =>
      (["subject", "description"] as const).map((field) =>
        rdOk<Listed<RmIssue>>(c, `/issues.json?${issuesQuery({ [who]: "me", [field]: `~${needle}`, sort: "updated_on:desc", limit: String(per) })}`).then((r) => (r.issues as RmIssue[] | undefined) ?? []),
      ),
    ),
  );
  const byId = new Map(lists.flat().map((i) => [i.id, i]));
  const all = [...byId.values()].sort((a, b) => (b.updated_on ?? "").localeCompare(a.updated_on ?? "") || b.id - a.id);
  return { items: await shapeAll(x, c, all.slice(0, limit)), complete: all.length <= limit && lists.every((l) => l.length < per) };
}

// ---------- Time entries ----------

export function toRemoteWorklog(e: RmTimeEntry, me: string): RemoteWorklog {
  const mine = String(e.user.id) === me;
  return {
    remoteId: String(e.id),
    // Time logged on the project itself has no issue.
    issue: e.issue ? { remoteId: String(e.issue.id), key: keyOfId(e.issue.id) } : null,
    span: { kind: "date", date: day(e.spent_on) ?? localDate("1970-01-01"), seconds: secondsOf(e.hours) ?? 0 },
    comment: e.comments ?? "",
    authorRemoteId: String(e.user.id),
    authorName: e.user.name ?? null,
    createdAt: instantFrom(e.created_on),
    updatedAt: instantFrom(e.updated_on),
    activity: e.activity ? { id: String(e.activity.id), name: e.activity.name ?? "" } : null,
    // Someone else's entries: Redmine's permissions decide; inkledger only offers the user's own.
    editable: { update: mine, delete: mine },
  };
}

function entryBody(w: WorklogInput, creating: { issueId: number } | null) {
  if (w.time.kind !== "date") throw new ProviderError("invalid", `Redmine keeps time entries by date, not a ${w.time.kind}`);
  return {
    time_entry: {
      ...(creating ? { issue_id: creating.issueId } : {}),
      spent_on: w.time.date,
      hours: hoursOf(w.time.seconds),
      comments: w.comment,
      // Left out, the server's default activity is used.
      ...(w.activityId ? { activity_id: Number(w.activityId) } : {}),
      ...(w.onBehalfOfRemoteId ? { user_id: Number(w.onBehalfOfRemoteId) } : {}),
    },
  };
}

const entryPath = (id: string) => `/time_entries/${encodeURIComponent(id)}.json`;

async function readEntry(c: RedmineCreds, id: string): Promise<RmTimeEntry | null> {
  return (await rd<{ time_entry: RmTimeEntry }>(c, entryPath(id), { missingIsNull: true, hiddenIsNull: true }))?.data.time_entry ?? null;
}

// ---------- Comments (journals) ----------

/** Markdown the server's textile won't show as written; the text goes as paragraphs, and what was lost is said. */
const MARKS: [ConversionWarning["feature"], RegExp][] = [
  ["strong", /\*\*[^*]+\*\*/],
  ["emphasis", /(^|[^*])\*[^*\s][^*]*\*/],
  ["code", /`[^`]+`/],
  ["codeBlock", /^```/m],
  ["link", /\[[^\]]+\]\([^)]+\)/],
  ["heading", /^#{1,6} /m],
  ["list", /^\s*([-*+]|\d+\.) /m],
  ["quote", /^> /m],
  ["table", /^\|.*\|$/m],
  ["image", /!\[[^\]]*\]\([^)]+\)/],
];
const warningsFor = (md: string): ConversionWarning[] =>
  MARKS.filter(([, re]) => re.test(md)).map(([feature]) => ({ code: "approximated" as const, feature, serverDetail: `markdown ${feature} sent to Redmine as plain paragraphs` }));

/** A journal with no notes is only history. */
const toRemoteComment = (j: RmJournal): RemoteComment => ({
  id: String(j.id),
  author: person(j.user),
  body: { kind: "text", format: "textile", text: j.notes ?? "" },
  createdAt: instantFrom(j.created_on),
  // Redmine's API gives no edit time for a journal.
  updatedAt: null,
});

// ---------- History (journals' details) ----------

const FIELD_NAMES: Record<string, string> = {
  status_id: "Status",
  priority_id: "Priority",
  tracker_id: "Tracker",
  assigned_to_id: "Assignee",
  project_id: "Project",
  subject: "Subject",
  description: "Description",
  start_date: "Start date",
  due_date: "Due date",
  done_ratio: "% Done",
  estimated_hours: "Estimated time",
  parent_id: "Parent task",
  fixed_version_id: "Target version",
  category_id: "Category",
  is_private: "Private",
};
const titled = (name: string) => FIELD_NAMES[name] ?? name.replace(/_id$/, "").replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());

/** A detail's values are ids, as text: names for the ones Redmine lets a user read, the id for the rest. */
function resolver(c: RedmineCreds, cat: Catalog) {
  const lists = new Map<string, Promise<Map<number, string>>>();
  const list = (key: "issue_priorities" | "trackers", path: string) => {
    let p = lists.get(key);
    if (!p) {
      p = rdOk<Record<string, { id: number; name: string }[]>>(c, path).then((r) => new Map((r[key] ?? []).map((v) => [v.id, v.name])));
      lists.set(key, p);
    }
    return p;
  };
  const users = new Map<number, Promise<string | null>>();
  return async (name: string, v: string): Promise<string> => {
    const n = Number(v);
    switch (name) {
      case "status_id":
        return cat.statuses.get(n)?.name ?? `#${v}`;
      case "project_id":
        return cat.projects.get(n)?.name ?? `#${v}`;
      case "priority_id":
        return (await list("issue_priorities", "/enumerations/issue_priorities.json")).get(n) ?? `#${v}`;
      case "tracker_id":
        return (await list("trackers", "/trackers.json")).get(n) ?? `#${v}`;
      case "assigned_to_id": {
        let p = users.get(n);
        if (!p) {
          p = rd<{ user: RmUser }>(c, `/users/${n}.json`, { missingIsNull: true, hiddenIsNull: true }).then((r) => (r ? person(r.data.user).name : null));
          users.set(n, p);
        }
        return (await p) ?? `#${v}`;
      }
      case "parent_id":
        return `#${v}`;
      case "done_ratio":
        return `${v}%`;
      default:
        return v;
    }
  };
}

const ID_VALUED = new Set(["status_id", "project_id", "priority_id", "tracker_id", "assigned_to_id", "parent_id", "fixed_version_id", "category_id"]);

// ---------- The adapter ----------

export const redmineProvider: TrackerProvider<"redmine", RedmineOptions> = {
  // A plugin posts deliveries with the connection's secret in a header (SPIKES.md, redmine-webhook).
  webhook: {
    verify: (req, secret) => verifyRedmineWebhook(req, secret),
    deliveryId: (req) => redmineDeliveryId(req),
    sentAt: (req) => redmineSentAt(req),
  },
  role: "tracker",
  type: "redmine",
  capabilities: redmineCapabilities,
  traits: redmineTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Redmine options: ${r.error.issues.map((i) => i.message).join("; ")}`);
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
      // …/issues/12, …/issues/12.json, …/issues/12/time_entries/new: under the site's sub-URI when it has one.
      const prefix = site.pathname.replace(/\/+$/, "");
      if (!url.pathname.startsWith(`${prefix}/`)) return null;
      const m = /^\/issues\/(\d{1,9})(?:\.(?:json|xml))?(?:\/.*)?$/.exec(url.pathname.slice(prefix.length));
      return m ? { key: keyOfId(Number(m[1])) } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const { user } = await rdOk<{ user: RmUser }>(await credsOf(x), "/users/current.json");
    return { ...person(user), ...(user.login ? { login: user.login } : {}), ...(user.mail ? { email: user.mail } : {}) };
  },

  async probe(x) {
    await rdOk<{ user: RmUser }>(await credsOf(x), "/users/current.json");
    return {
      capabilities: redmineCapabilities,
      activeSources: [{ kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" }, name: "Status" }],
      // Redmine has no rate limit of its own: no figure (a proxy's 429 is a wait).
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    const here = decodePageToken<PassAt>(x.conn, "issues", V, q.since, q.page);
    const from = Math.max(0, (here?.skip ?? 0) - TAIL);
    // status_id=* (closed ones too; the default is open only), assigned_to_id=me, oldest change first.
    const params: Record<string, string> = { assigned_to_id: "me", sort: "updated_on,id", limit: String(PER_PAGE), offset: String(from) };
    if (since !== null) params.updated_on = `>=${new Date(since - OVERLAP_MS).toISOString().replace(".000Z", "Z")}`;
    const r = await rd<Listed<RmIssue>>(c, `/issues.json?${issuesQuery(params)}`);
    const got = (r?.data.issues as RmIssue[] | undefined) ?? [];
    const total = typeof r?.data.total_count === "number" ? r.data.total_count : from + got.length;
    const seen = new Set(here?.tail ?? []);
    const fresh = got.filter((i) => !seen.has(i.id));
    // The server's own clock, to the second, when nothing has been read to go by (the connection's clock may be off).
    const server = Date.parse(r?.headers.get("date") ?? "");
    const now = here?.now ?? (Number.isFinite(server) ? server : Date.now());
    const latest = got.reduce<number | null>((m, i) => Math.max(m ?? 0, instantFrom(i.updated_on) ?? 0) || m, here?.max ?? null);
    const skip = from + got.length;
    const items = await shapeAll(x, c, fresh);
    if (got.length === 0 || skip >= total) {
      // The next pass starts from the latest change seen (or from where this one began when none): no clock of ours in the way.
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: latest ?? since ?? now } satisfies Since) };
    }
    if (here && skip <= here.skip) throw new IncompatibleResultError("Redmine cut pages below the overlap: no progress");
    return {
      last: false,
      items,
      gone: [],
      next: encodePageToken(x.conn, "issues", V, q.since, { skip, tail: got.slice(-TAIL).map((i) => i.id), max: latest, now } satisfies PassAt),
    };
  },

  async getIssue(x, ref) {
    const c = await credsOf(x);
    const id = idOf(ref);
    const i = id === null ? null : await fetchIssue(c, id);
    return i ? (await shapeAll(x, c, [i]))[0] : null;
  },

  async findIssue(x, handle) {
    const c = await credsOf(x);
    const fromKey = handle.key ? idOf({ key: handle.key }) : null;
    const fromId = handle.remoteId ? idOf({ remoteId: handle.remoteId }) : null;
    // An id is unique on the server: a key and an id that disagree name nothing.
    if ((handle.key && fromKey === null && fromId === null) || (fromKey !== null && fromId !== null && fromKey !== fromId)) return { kind: "none" };
    const id = fromId ?? fromKey;
    const i = id === null ? null : await fetchIssue(c, id);
    return i ? { kind: "found", issue: (await shapeAll(x, c, [i]))[0] } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    return search(x, text, limit);
  },

  async statuses(x) {
    const r = await rdOk<{ issue_statuses?: RmStatus[] }>(await credsOf(x), "/issue_statuses.json");
    return (r.issue_statuses ?? []).map((s, order) => ({ ...statusOf(s.id, s.name, s.is_closed === true), order }));
  },

  async description(x, ref) {
    const i = await fetchIssue(await credsOf(x), idOf(ref) ?? -1);
    return i?.description ? { kind: "text", format: "textile", text: i.description } : null;
  },

  transitions: {
    async list(x, ref): Promise<Transition[]> {
      const i = await mustIssue(await credsOf(x), ref, "allowed_statuses");
      // Before Redmine 5.0 the allowed statuses aren't given: nothing is offered rather than a guess.
      if (!i.allowed_statuses) return [];
      const url = `${webOf(x)}/issues/${i.id}`;
      return i.allowed_statuses
        .filter((s) => s.id !== i.status.id)
        .map((s) => ({ id: `status:${s.id}`, name: s.name, to: statusOf(s.id, s.name, s.is_closed === true), requirements: [], remoteUrl: url }));
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      const m = /^status:(\d+)$/.exec(transitionId);
      if (!m) throw new ProviderError("invalid", `Redmine: no transition ${transitionId}`);
      const i = await mustIssue(c, ref);
      // A workflow that demands a field, or doesn't allow the move, answers 422 with its message. 204 and no body: read again.
      await rd(c, issuePath(i.id), { method: "PUT", body: JSON.stringify({ issue: { status_id: Number(m[1]) } }) });
      const after = await fetchIssue(c, i.id);
      return after ? (await shapeAll(x, c, [after]))[0] : null;
    },
  },

  worklogs: {
    async list(x, ref) {
      const c = await credsOf(x);
      const id = idOf(ref);
      if (id === null) return [];
      const rows = (await rdPages<RmTimeEntry>(c, `/time_entries.json?issue_id=${id}`, "time_entries")) ?? [];
      // The issue filter also returns the entries of its subtasks: only this issue's own.
      return rows.filter((e) => e.issue?.id === id).map((e) => toRemoteWorklog(e, x.conn.remoteAccountId));
    },
    async get(x, ref, id) {
      const e = await readEntry(await credsOf(x), id);
      return e && e.issue?.id === idOf(ref) ? toRemoteWorklog(e, x.conn.remoteAccountId) : null;
    },
    async changed(x, q) {
      const c = await credsOf(x);
      // Only validated: a window is always read whole (an entry can be dated before it was logged).
      decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since);
      const pageAt =
        decodePageToken<EntriesAt>(x.conn, "worklogs", V, q.since, q.page) ??
        ((now: number): EntriesAt => ({
          offset: 0,
          // Whole days a day wider than the window at the far end: spent_on is the user's day, not UTC's.
          from: new Date(now - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
          to: new Date(now + DAY_MS).toISOString().slice(0, 10),
          at: now,
        }))(Date.now());
      const me = meId(x);
      const r = await rd<Listed<RmTimeEntry>>(c, paged(`/time_entries.json?${new URLSearchParams({ user_id: String(me), from: pageAt.from, to: pageAt.to }).toString()}`, PER_PAGE, pageAt.offset));
      const rows = (r?.data.time_entries as RmTimeEntry[] | undefined) ?? [];
      const total = typeof r?.data.total_count === "number" ? r.data.total_count : pageAt.offset + rows.length;
      // Time logged on a project (no issue) has nowhere to go here.
      const items = rows.filter((e) => e.issue).map((e) => toRemoteWorklog(e, x.conn.remoteAccountId));
      const offset = pageAt.offset + rows.length;
      if (rows.length === 0 || offset >= total) return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: pageAt.at } satisfies Since) };
      return { last: false, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { ...pageAt, offset } satisfies EntriesAt) };
    },
    async create(x, ref, w) {
      const c = await credsOf(x);
      const id = idOf(ref);
      if (id === null) throw new ProviderError("notFound", `Redmine: no issue ${ref.key}`);
      const made = (await rdOk<{ time_entry: RmTimeEntry }>(c, "/time_entries.json", { method: "POST", body: JSON.stringify(entryBody(w, { issueId: id })) })).time_entry;
      // A user_id the account may not log for is ignored without a word: the time is the caller's. Taken back, never left as a wrong entry.
      if (w.onBehalfOfRemoteId && String(made.user.id) !== w.onBehalfOfRemoteId) {
        await rd(c, entryPath(String(made.id)), { method: "DELETE", missingIsNull: true }).catch(() => undefined);
        throw new ProviderError("forbidden", "Redmine: not allowed to log time for other users (the entry was not kept)");
      }
      return toRemoteWorklog(made, x.conn.remoteAccountId);
    },
    async update(x, _ref, id, w) {
      const c = await credsOf(x);
      // 204 and no body: read again.
      await rd(c, entryPath(id), { method: "PUT", body: JSON.stringify(entryBody(w, null)) });
      const e = await readEntry(c, id);
      if (!e) throw new ProviderError("notFound", `Redmine: no time entry ${id}`);
      return toRemoteWorklog(e, x.conn.remoteAccountId);
    },
    async delete(x, _ref, id) {
      // Already gone is what was asked for.
      await rd(await credsOf(x), entryPath(id), { method: "DELETE", missingIsNull: true });
    },
    async activities(x, scope, limit) {
      const c = await credsOf(x);
      let list: (RmRef & { active?: boolean })[] | undefined;
      if (scope.issue) {
        // A project may offer fewer activities than the server has.
        const hint = scope.issue.container?.remoteId;
        const project = hint ?? String((await mustIssue(c, scope.issue)).project.id);
        const r = await rdOk<{ project?: { time_entry_activities?: (RmRef & { active?: boolean })[] } }>(c, `/projects/${encodeURIComponent(project)}.json?include=time_entry_activities`);
        list = r.project?.time_entry_activities;
      }
      // The whole catalogue (or a server that doesn't say a project's own).
      list ??= (await rdOk<{ time_entry_activities?: (RmRef & { active?: boolean })[] }>(c, "/enumerations/time_entry_activities.json")).time_entry_activities ?? [];
      const items: CatalogItem[] = list.filter((a) => a.active !== false).map((a) => ({ id: String(a.id), name: a.name ?? "" }));
      return { items: items.slice(0, limit), complete: items.length <= limit };
    },
  },

  comments: {
    async list(x, ref) {
      const i = await mustIssue(await credsOf(x), ref, "journals");
      return (i.journals ?? []).filter((j) => (j.notes ?? "").trim() !== "").map(toRemoteComment);
    },
    async add(x, ref, body) {
      const c = await credsOf(x);
      const i = await mustIssue(c, ref);
      // 204 and no journal back: read again later (null), not invented.
      await rd(c, issuePath(i.id), { method: "PUT", body: JSON.stringify({ issue: { notes: body } }) });
      return { comment: null, warnings: warningsFor(body) };
    },
  },

  async watch(x, ref, on) {
    const c = await credsOf(x);
    const id = idOf(ref);
    if (id === null) throw new ProviderError("notFound", `Redmine: no issue ${ref.key}`);
    const me = meId(x);
    // Adding or removing what is (not) there answers 204 all the same.
    if (on) await rd(c, `/issues/${id}/watchers.json`, { method: "POST", body: JSON.stringify({ user_id: me }) });
    else await rd(c, `/issues/${id}/watchers/${me}.json`, { method: "DELETE" });
  },

  async statusHistory(x, ref) {

    return statusSteps(await redmineProvider.history!(x, ref), (c) => c.field.id === "status_id");

  },


  async history(x, ref) {
    const c = await credsOf(x);
    const i = await mustIssue(c, ref, "journals");
    const cat = await catalogFor(x, c, [i]);
    const resolve = resolver(c, cat);
    const customNames = new Map((i.custom_fields ?? []).map((f) => [String(f.id), f.name]));
    const out: RemoteChange[] = [];
    for (const j of i.journals ?? []) {
      for (const d of j.details ?? []) {
        const values = async (v: string | null | undefined): Promise<ChangeValue[]> => {
          if (v == null || v === "") return [];
          if (d.property === "relation") return [{ text: keyOfId(v), id: v }];
          if (d.property !== "attr") return [{ text: v }];
          return [{ text: await resolve(d.name, v), ...(ID_VALUED.has(d.name) ? { id: v } : {}) }];
        };
        const field =
          d.property === "cf"
            ? { id: `cf_${d.name}`, name: customNames.get(d.name) ?? `Custom field ${d.name}` }
            : d.property === "attachment"
              ? { id: "attachment", name: "Attachment" }
              : d.property === "relation"
                ? { id: `relation_${d.name}`, name: `Relation (${d.name})` }
                : { id: d.name, name: titled(d.name) };
        out.push({ at: instantFrom(j.created_on) ?? instant(0), actor: j.user ? person(j.user) : null, field, from: await values(d.old_value), to: await values(d.new_value) });
      }
    }
    return out;
  },
};
