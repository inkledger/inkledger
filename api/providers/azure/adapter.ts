// Azure DevOps (Services and Server) as a tracker, through the provider
// contract. Work items assigned to the user, keyed Project#12 (the id is
// unique across the organization: the project is part of the key, not of the
// identity, so a move or a rename changes the key and nothing else). The
// workflow is the work item's State with the category the service gives it
// (Proposed, InProgress, Resolved, Completed, Removed) and the transitions
// its work item type allows. Time is a counter: Completed Work, in hours,
// changed under a revision test. Comments are HTML. Built from the API's
// documentation on a simulator, not yet checked on a real account: see
// docs/dev/spikes.md ("Azure DevOps").
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits, WEBHOOK_EVENTS } from "@contracts/providers";
import { instant, instantFrom, localDateOf, type JsonValue } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, ConversionWarning, Instant, IssueRef, Limited, RemoteChange, RemoteComment, RemoteIssue, RemotePerson, RemoteStatus, ReportedIssueGone, TrackerProvider, Transition } from "../types";
import {
  COMMENTS_API_VERSION,
  CONNECTION_API_VERSION,
  ITEM_FIELDS,
  az,
  azOk,
  itemsByIds,
  patchItem,
  wiql,
  workItemUrl,
  type AzureComment,
  type AzureConnectionData,
  type AzureCreds,
  type AzureIdentityField,
  type AzureProject,
  type AzureUpdate,
  type AzureWorkItem,
} from "./client";
import { assignedChanged, titleSearch, toWiql } from "./translate";
import { statusSteps } from "../core/statusSteps";

export const azureCapabilities: TrackerCapabilities = {
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: "wiql",
  comments: { mode: "readWrite", formats: ["html"], writePreserves: ["paragraph", "emphasis", "strong", "link", "list"], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  inbox: false,
  otherFields: false,
  watch: false,
  history: true,
  statusHistory: true,
  // The state, moved along the transitions the work item type allows.
  workflow: { sources: [{ kind: "itemState", transitions: "allowedList" }] },
  // Completed Work: a counter inkledger adds to, under the work item's revision.
  time: { mode: "counter", read: true, increment: true, decrement: true, concurrency: "revision" },
  sync: {
    issueCheckpoints: true,
    // Deleted items are found in the reporting revisions; reassigned ones by reconciliation.
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    // Signals until a payload is shown to hold all the adapter needs (spikes: webhook payloads).
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const azureTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: true,
  attachments: { read: true, upload: true },
  timeboxes: ["iteration"],
  fields: ["priority", "due", "start", "estimate", "points", "labels", "custom"],
};

const optionsSchema = z.strictObject({
  /** Most ids one WIQL query may answer (the service's own ceiling is 20,000); lower only to test or to tame a huge backlog. */
  wiqlTop: z.number().int().min(1).max(20_000).default(20_000),
});
export type AzureOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"azure", AzureOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** Where a pass is: the server's clock when it began (every page asks the same window) and how many ids were already handed over. */
type PageAt = { asOf: number; offset: number };

/** Read again at each pass: the server's clock and a change's date can disagree by a little, and the reporting feed lags. */
const OVERLAP_MS = 5 * 60_000;
const PER_PAGE = 100;
/** How long what the adapter learned about projects and states is trusted. */
const CACHE_MS = 5 * 60_000;

async function credsOf(x: X): Promise<AzureCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

// ---------- Keys and links ----------

/** Project#12. A project name has none of \ / : * ? " < > | ; # $ * { } , + = [ ], may hold spaces, and starts with neither _ nor . */
const KEY = /^([^\\/:*?"<>|;#$*{},+=[\]]{1,64})#(\d{1,10})$/;
export const keyOf = (project: string, id: number | string) => `${project}#${id}`;
function normalizeKey(raw: string): string | null {
  const m = KEY.exec(raw.trim());
  const project = m?.[1].trim();
  if (!m || !project || /^[_.]/.test(project) || /[.]$/.test(project)) return null;
  return keyOf(project, Number(m[2]));
}
const projectOfKey = (key: string) => normalizeKey(key)?.split("#")[0] ?? null;
const idOfKey = (key: string) => {
  const k = normalizeKey(key);
  return k ? Number(k.split("#")[1]) : null;
};
/** The numeric id of a reference: its remoteId, else the number in its key. */
function idOf(ref: { remoteId?: string; key?: string }): number {
  const id = ref.remoteId !== undefined && /^\d+$/.test(ref.remoteId) ? Number(ref.remoteId) : ref.key ? idOfKey(ref.key) : null;
  if (id === null) throw new ProviderError("invalid", `Not an Azure DevOps work item: ${ref.key ?? ref.remoteId ?? ""}`);
  return id;
}

// ---------- Identities, states, projects ----------

/** A person as an identity field gives them: an object (7.x) or "Name <unique name>" (older servers). */
function person(i: AzureIdentityField | undefined): RemotePerson | null {
  if (!i) return null;
  if (typeof i === "string") {
    const m = /^(.*?)\s*<(.+)>$/.exec(i);
    return m ? { remoteId: m[2], name: m[1] || m[2], handle: m[2] } : { remoteId: i, name: i };
  }
  const remoteId = i.id ?? i.uniqueName ?? i.displayName ?? "";
  return remoteId ? { remoteId, name: i.displayName ?? i.uniqueName ?? remoteId, avatarUrl: i._links?.avatar?.href ?? i.imageUrl ?? null, ...(i.uniqueName ? { handle: i.uniqueName } : {}) } : null;
}

/** Azure's state categories, in the layer's: a resolved item is still the developer's until it is closed. */
function categoryOf(azure: string | undefined): StatusCategory {
  switch (azure) {
    case "InProgress":
    case "Resolved":
      return "doing";
    case "Completed":
      return "done";
    case "Removed":
      return "cancelled";
    default:
      return "todo";
  }
}

type StateInfo = { name: string; category: StatusCategory; color?: string; order: number };
type Cache = { projects: { at: number; list: AzureProject[] } | null; states: Map<string, { at: number; list: StateInfo[] }> };
const caches = new WeakMap<object, Cache>();
const cacheOf = (x: X): Cache => {
  let c = caches.get(x.conn);
  if (!c) caches.set(x.conn, (c = { projects: null, states: new Map() }));
  return c;
};

/** Every project the token sees (paged by $top/$skip); none when the token can't list them (the names are then used as ids). */
async function projectsOf(x: X, creds: AzureCreds, fresh = false): Promise<AzureProject[]> {
  const cache = cacheOf(x);
  if (!fresh && cache.projects && Date.now() - cache.projects.at < CACHE_MS) return cache.projects.list;
  const list: AzureProject[] = [];
  try {
    for (let skip = 0, n = 0; n < 50; n++, skip += 100) {
      const r = await azOk<{ value: AzureProject[] }>(creds, "/_apis/projects", { params: { $top: 100, $skip: skip } });
      list.push(...r.value);
      if (r.value.length < 100) break;
    }
  } catch (e) {
    if (!(e instanceof ProviderError) || !["auth", "forbidden", "notFound"].includes(e.kind)) throw e;
  }
  cache.projects = { at: Date.now(), list };
  return list;
}

/** A work item type's states with their categories (cached). */
async function statesOf(x: X, creds: AzureCreds, project: string, type: string): Promise<StateInfo[]> {
  const cache = cacheOf(x);
  const k = `${project.toLowerCase()}|${type.toLowerCase()}`;
  const hit = cache.states.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const r = await az<{ value: { name: string; color?: string; category?: string }[] }>(creds, `/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`, { missingIsNull: true }).catch((e: unknown) => {
    if (e instanceof ProviderError && e.kind === "forbidden") return null;
    throw e;
  });
  const list = (r?.data.value ?? []).map((s, order) => ({ name: s.name, category: categoryOf(s.category), ...(s.color && /^[0-9a-f]{6}$/i.test(s.color) ? { color: `#${s.color}` } : {}), order }));
  cache.states.set(k, { at: Date.now(), list });
  return list;
}

/** What turning work items into issues needs from the service, fetched ahead so the mapping itself stays plain. */
type Lookups = { apiBase: string; zone: Parameters<typeof localDateOf>[1]; project: (name: string) => AzureProject | undefined; state: (project: string, type: string, name: string) => StateInfo | undefined };

async function lookupsFor(x: X, creds: AzureCreds, items: AzureWorkItem[]): Promise<Lookups> {
  let projects = await projectsOf(x, creds);
  const names = [...new Set(items.map((w) => w.fields["System.TeamProject"] ?? ""))];
  // A project unknown to the list is new (or renamed): read the list once more.
  if (projects.length > 0 && names.some((n) => n && !projects.some((p) => p.name.toLowerCase() === n.toLowerCase()))) projects = await projectsOf(x, creds, true);
  const kinds = [...new Set(items.map((w) => `${w.fields["System.TeamProject"] ?? ""}\u0000${w.fields["System.WorkItemType"] ?? ""}`))];
  const states = new Map<string, StateInfo[]>();
  for (const k of kinds) {
    const [p, t] = k.split("\u0000");
    states.set(k.toLowerCase(), p && t ? await statesOf(x, creds, p, t) : []);
  }
  return {
    apiBase: creds.apiBase,
    zone: x.conn.timeZone,
    project: (name) => projects.find((p) => p.name.toLowerCase() === name.toLowerCase()),
    state: (project, type, name) => states.get(`${project}\u0000${type}`.toLowerCase())?.find((s) => s.name === name),
  };
}

// ---------- Work items as issues ----------

const secondsOf = (hours: unknown) => (typeof hours === "number" && Number.isFinite(hours) ? Math.round(hours * 3600) : null);

const LEVELS: Record<string, "epic" | "standard" | "sub"> = { epic: "epic", feature: "epic", task: "sub" };

/** Priority 1 (highest) to 4, on the layer's coarse 0-4 scale (the same rule as Jira's). */
const rankOf = (p: number) => Math.round(((Math.min(4, Math.max(1, p)) - 1) * 4) / 3);

export function toRemoteIssue(l: Lookups, w: AzureWorkItem): RemoteIssue {
  const f = w.fields;
  const projectName = f["System.TeamProject"] ?? "";
  const type = f["System.WorkItemType"] ?? "Work item";
  const stateName = f["System.State"] ?? "";
  const known = l.state(projectName, type, stateName);
  const project = l.project(projectName);
  const priority = f["Microsoft.VSTS.Common.Priority"];
  const assignee = person(f["System.AssignedTo"]);
  const due = instantFrom(f["Microsoft.VSTS.Scheduling.DueDate"]);
  const parent = f["System.Parent"];
  const status: RemoteStatus = {
    id: stateName,
    name: stateName,
    category: known?.category ?? "todo",
    categoryOrigin: { by: "native" },
    source: { kind: "itemState" },
    nativeReason: f["System.Reason"] ?? null,
    ...(known?.color ? { color: known.color } : {}),
    ...(known ? { order: known.order } : {}),
  };
  return {
    remoteId: String(w.id),
    key: keyOf(projectName, w.id),
    url: workItemUrl(l.apiBase, projectName, w.id),
    title: f["System.Title"] ?? "",
    type: { id: type, name: type, ...(LEVELS[type.toLowerCase()] ? { level: LEVELS[type.toLowerCase()] } : {}) },
    status,
    // The project by its id (a rename keeps it), its name as the key every call names it by.
    container: { remoteId: project?.id ?? projectName, key: projectName, name: projectName, kind: "project" },
    priority: typeof priority === "number" ? { id: String(priority), name: String(priority), rank: rankOf(priority) } : null,
    // Tags are one text, separated by "; ".
    labels: (f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
    assignees: assignee ? [assignee] : [],
    reporter: person(f["System.CreatedBy"]),
    // A date-time the service holds at midnight of the user's zone: read back in that zone, not in UTC.
    due: due ? localDateOf(due, l.zone) : null,
    estimateSeconds: secondsOf(f["Microsoft.VSTS.Scheduling.OriginalEstimate"]),
    spentSeconds: secondsOf(f["Microsoft.VSTS.Scheduling.CompletedWork"]),
    createdAt: instantFrom(f["System.CreatedDate"]),
    updatedAt: instantFrom(f["System.ChangedDate"]),
    statusChangedAt: instantFrom(f["System.StateChangeDate"]),
    ...(typeof parent === "number" ? { fields: { "System.Parent": parent } satisfies Record<string, JsonValue> } : {}),
  };
}

async function issuesOf(x: X, creds: AzureCreds, items: AzureWorkItem[]): Promise<RemoteIssue[]> {
  if (items.length === 0) return [];
  const l = await lookupsFor(x, creds, items);
  return items.map((w) => toRemoteIssue(l, w));
}

/** One work item by id (null: gone, or not one the token may read: the service answers 404 for both). */
async function itemById(creds: AzureCreds, id: number, fields: string[] = ITEM_FIELDS): Promise<AzureWorkItem | null> {
  const r = await az<AzureWorkItem>(creds, `/_apis/wit/workitems/${id}`, { missingIsNull: true, params: { fields: fields.join(",") } });
  return r?.data ?? null;
}

async function oneIssue(x: X, creds: AzureCreds, id: number): Promise<RemoteIssue | null> {
  const w = await itemById(creds, id);
  return w ? (await issuesOf(x, creds, [w]))[0] : null;
}

/**
 * Runs a project-scoped call (comments) in the project the reference says;
 * a project renamed since makes that a 404, so the item's current project is
 * read once and the call tried again.
 */
async function inProject<T>(creds: AzureCreds, ref: IssueRef, run: (project: string) => Promise<T>): Promise<T> {
  const hint = ref.container?.key ?? projectOfKey(ref.key);
  if (hint) {
    try {
      return await run(hint);
    } catch (e) {
      if (!(e instanceof ProviderError && e.kind === "notFound")) throw e;
    }
  }
  const w = await itemById(creds, idOf(ref), ["System.TeamProject"]);
  const project = w?.fields["System.TeamProject"];
  if (!project) throw new ProviderError("notFound", `Azure DevOps: no work item ${ref.key}`);
  return run(project);
}

// ---------- Comments (HTML) ----------

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Markdown the service won't show as written: it gets the text, as paragraphs, until the RichText layer converts it. */
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
const warningsFor = (md: string): ConversionWarning[] => MARKS.filter(([, re]) => re.test(md)).map(([feature]) => ({ code: "approximated" as const, feature, serverDetail: `markdown ${feature} sent to Azure DevOps as plain paragraphs` }));
const paragraphs = (md: string) =>
  md
    .split(/\n{2,}/)
    .map((p) => `<div>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</div>`)
    .join("");

function toRemoteComment(c: AzureComment): RemoteComment {
  return {
    id: String(c.id),
    author: person(c.createdBy) ?? { remoteId: "", name: "" },
    body: { kind: "text", format: "html", text: c.text ?? "" },
    createdAt: instantFrom(c.createdDate),
    updatedAt: instantFrom(c.modifiedDate ?? c.createdDate),
  };
}

// ---------- History ----------

/** Fields the service records on every revision without anyone having changed them. */
const BOOKKEEPING = new Set(["System.Rev", "System.AuthorizedDate", "System.RevisedDate", "System.ChangedDate", "System.Watermark", "System.AuthorizedAs", "System.PersonId", "System.ChangedBy"]);
const words = (referenceName: string) => (referenceName.split(".").pop() ?? referenceName).replace(/([a-z])([A-Z])/g, "$1 $2");
function valueOf(v: unknown): { text: string; id?: string }[] {
  if (v === undefined || v === null || v === "") return [];
  if (typeof v === "object") {
    const i = v as { displayName?: string; id?: string; uniqueName?: string };
    return [{ text: i.displayName ?? i.uniqueName ?? JSON.stringify(v), ...(i.id ? { id: i.id } : {}) }];
  }
  return [{ text: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v) }];
}

// ---------- Counter: Completed Work, in hours ----------

const COMPLETED = "Microsoft.VSTS.Scheduling.CompletedWork";

/** Moves the counter by `delta` seconds, held to the revision the caller read (or, with none, the one read now). */
async function moveCounter(x: X, ref: IssueRef, delta: number, expectedVersion: string | undefined) {
  const creds = await credsOf(x);
  const w = await itemById(creds, idOf(ref), ["System.TeamProject", COMPLETED]);
  if (!w) throw new ProviderError("notFound", `Azure DevOps: no work item ${ref.key}`);
  const held = expectedVersion === undefined ? w.rev : Number(expectedVersion);
  if (!Number.isInteger(held)) throw new ProviderError("invalid", `Not an Azure DevOps revision: ${expectedVersion}`);
  const seconds = Math.max(0, (secondsOf(w.fields[COMPLETED]) ?? 0) + delta);
  // The test op makes the write fail when anyone changed the item since (any field, not only this one).
  const after = await patchItem(creds, w.id, [
    { op: "test", path: "/rev", value: held },
    { op: "add", path: `/fields/${COMPLETED}`, value: seconds / 3600 },
  ]);
  return { seconds: secondsOf(after.fields[COMPLETED]) ?? 0, version: String(after.rev) };
}

// ---------- The provider ----------

async function search(x: X, query: string, limit: number): Promise<Limited<RemoteIssue>> {
  const creds = await credsOf(x);
  const { ids } = await wiql(creds, query, limit + 1);
  const items = await itemsByIds(creds, ids.slice(0, limit));
  return { items: await issuesOf(x, creds, items), complete: ids.length <= limit };
}

/** Items deleted since `since`, from the reporting revisions (latest revision of each; the recycle bin lists only ids). */
async function deletedSince(creds: AzureCreds, since: number): Promise<ReportedIssueGone[]> {
  const out: ReportedIssueGone[] = [];
  try {
    let token: string | undefined;
    for (let n = 0; n < 100; n++) {
      const r = await azOk<{ values: { id: number; isDeleted?: boolean }[]; continuationToken?: string; isLastBatch?: boolean }>(creds, "/_apis/wit/reporting/workitemrevisions", {
        params: { startDateTime: new Date(since).toISOString(), includeDeleted: true, includeLatestOnly: true, fields: "System.Id", $maxPageSize: 200, continuationToken: token },
      });
      for (const v of r.values) if (v.isDeleted) out.push({ remoteId: String(v.id), reason: "deleted" });
      token = r.continuationToken;
      if (r.isLastBatch !== false || !token) break;
    }
  } catch (e) {
    // The feed is an accelerator for departures (reconciliation finds them anyway): a token without its scope just goes without.
    if (!(e instanceof ProviderError) || !["forbidden", "notFound", "invalid"].includes(e.kind)) throw e;
    return [];
  }
  return out;
}

export const azureProvider: TrackerProvider<"azure", AzureOptions> = {
  translate: (expr, now) => toWiql(expr, now),

  // Service hooks sign in with Basic auth: user "inkledger", the connection's webhook secret as the password.
  webhook: {
    verify: (req, secret) => azureWebhook.verify(req.headers.authorization, { username: "inkledger", password: secret }),
    deliveryId: (req) => {
      try {
        return azureWebhook.deliveryId(JSON.parse(req.body) as unknown);
      } catch {
        return null;
      }
    },
  },
  role: "tracker",
  type: "azure",
  capabilities: azureCapabilities,
  traits: azureTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Azure DevOps options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text) {
    const t = text.trim();
    const key = normalizeKey(t);
    if (key) return { key };
    const bare = /^#?(\d{1,10})$/.exec(t);
    if (bare) return { remoteId: String(Number(bare[1])) };
    try {
      const url = new URL(t);
      const base = new URL(r.baseUrl);
      const prefix = base.pathname.replace(/\/+$/, "").toLowerCase();
      if (url.origin !== base.origin || !url.pathname.toLowerCase().startsWith(prefix)) return null;
      const segs = url.pathname
        .slice(prefix.length)
        .split("/")
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
      // …/{project}/_workitems/edit/12, a board or backlog card (?workitem=12), or the organization-level …/_workitems/edit/12
      const edit = segs.indexOf("_workitems");
      const id = edit >= 0 && segs[edit + 1] === "edit" && /^\d{1,10}$/.test(segs[edit + 2] ?? "") ? segs[edit + 2] : /^\d{1,10}$/.exec(url.searchParams.get("workitem") ?? "")?.[0];
      if (!id) return null;
      const project = segs[0] && !segs[0].startsWith("_") ? segs[0] : null;
      const k = project ? normalizeKey(keyOf(project, id)) : null;
      return { remoteId: String(Number(id)), ...(k ? { key: k } : {}) };
    } catch {
      return null;
    }
  },

  async verify(x) {
    const d = await azOk<AzureConnectionData>(await credsOf(x), "/_apis/connectionData", { version: CONNECTION_API_VERSION });
    const u = d.authenticatedUser;
    const email = u.properties?.Account?.$value;
    return { remoteId: u.id, name: u.providerDisplayName ?? email ?? u.id, ...(email ? { login: email, email } : {}) };
  },

  async probe(x) {
    // No call budget is published as a figure (the service delays calls it finds too many, and answers 429 past that): throttled from the errors.
    await azOk<AzureConnectionData>(await credsOf(x), "/_apis/connectionData", { version: CONNECTION_API_VERSION });
    return {
      capabilities: azureCapabilities,
      activeSources: [{ kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" }, name: "Work item state" }],
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const top = x.conn.options.wiqlTop;
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    const at = decodePageToken<PageAt>(x.conn, "issues", V, q.since, q.page);
    // Every page asks the same window (up to the server's clock when the pass began), so the ids hold their places.
    const found = await wiql(creds, assignedChanged(since, at?.asOf ?? null), top);
    const asOf = at?.asOf ?? found.asOf ?? Date.now();
    const offset = at?.offset ?? 0;
    const items = await itemsByIds(creds, found.ids.slice(offset, offset + PER_PAGE));
    const issues = await issuesOf(x, creds, items);
    if (offset + PER_PAGE < found.ids.length) {
      return { last: false, items: issues, gone: [], next: encodePageToken(x.conn, "issues", V, q.since, { asOf, offset: offset + PER_PAGE } satisfies PageAt) };
    }
    // An answer as long as the ceiling was cut: the pass reached only as far as its last change, the next one goes on from there.
    const lastChange = Math.max(0, ...items.map((w) => Date.parse(w.fields["System.ChangedDate"] ?? "") || 0));
    const reached = found.ids.length >= top && lastChange > 0 ? lastChange : asOf;
    return {
      last: true,
      items: issues,
      gone: since === null ? [] : await deletedSince(creds, since),
      checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: Math.max(0, reached - OVERLAP_MS) } satisfies Since),
    };
  },

  async getIssue(x, ref) {
    return oneIssue(x, await credsOf(x), idOf(ref));
  },

  async findIssue(x, handle) {
    const creds = await credsOf(x);
    // The id is the identity: a link or a stored reference finds an item wherever it moved to.
    if (handle.remoteId) {
      const i = await oneIssue(x, creds, idOf(handle));
      return i ? { kind: "found", issue: i } : { kind: "none" };
    }
    const key = handle.key ? normalizeKey(handle.key) : null;
    const i = key ? await oneIssue(x, creds, idOf({ key })) : null;
    // A typed key names its project too: the number alone belongs to whatever project holds it now.
    return i && key && i.container.key.toLowerCase() === key.split("#")[0].toLowerCase() ? { kind: "found", issue: i } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    return search(x, titleSearch(text), limit);
  },

  async query(x, query, limit) {
    return search(x, query, limit);
  },

  async statuses(x, source) {
    const creds = await credsOf(x);
    const wanted = (source.ref.kind === "itemState" ? source.ref.containerRemoteId : undefined)?.toLowerCase();
    const projects = (await projectsOf(x, creds)).filter((p) => !wanted || p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted).slice(0, 20);
    const byName = new Map<string, RemoteStatus>();
    for (const p of projects) {
      const types = await azOk<{ value: { name: string; isDisabled?: boolean }[] }>(creds, `/${encodeURIComponent(p.name)}/_apis/wit/workitemtypes`);
      for (const t of types.value.filter((t) => !t.isDisabled)) {
        for (const s of await statesOf(x, creds, p.name, t.name)) {
          if (!byName.has(s.name)) byName.set(s.name, { id: s.name, name: s.name, category: s.category, categoryOrigin: { by: "native" }, source: { kind: "itemState" }, ...(s.color ? { color: s.color } : {}), order: byName.size });
        }
      }
    }
    return [...byName.values()];
  },

  async description(x, ref) {
    const w = await itemById(await credsOf(x), idOf(ref), ["System.Description"]);
    const html = w?.fields["System.Description"];
    return html ? { kind: "text", format: "html", text: html } : null;
  },

  transitions: {
    async list(x, ref) {
      const creds = await credsOf(x);
      const w = await itemById(creds, idOf(ref));
      if (!w) throw new ProviderError("notFound", `Azure DevOps: no work item ${ref.key}`);
      const [issue] = await issuesOf(x, creds, [w]);
      const project = w.fields["System.TeamProject"] ?? "";
      const type = w.fields["System.WorkItemType"] ?? "";
      const states = await statesOf(x, creds, project, type);
      const def = await azOk<{ transitions?: Record<string, { to: string }[]> }>(creds, `/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}`);
      const matrix = def.transitions ?? {};
      // A type that lists no transitions at all (an inherited process) lets an item go to any other state.
      const to = Object.keys(matrix).length > 0 ? (matrix[issue.status.name] ?? []).map((t) => t.to) : states.map((s) => s.name);
      return [...new Set(to)]
        .filter((name) => name !== issue.status.name)
        .map((name): Transition => {
          const s = states.find((st) => st.name === name);
          const status: RemoteStatus = { id: name, name, category: s?.category ?? "todo", categoryOrigin: { by: "native" }, source: { kind: "itemState" }, ...(s?.color ? { color: s.color } : {}), ...(s ? { order: s.order } : {}) };
          return { id: name, name, to: status, requirements: [], remoteUrl: issue.url };
        });
    },
    async apply(x, ref, transitionId) {
      const creds = await credsOf(x);
      // A state the type doesn't allow from here, or one that asks for a field, is refused with a 400: "invalid".
      const w = await patchItem(creds, idOf(ref), [{ op: "add", path: "/fields/System.State", value: transitionId }]);
      return (await issuesOf(x, creds, [w]))[0];
    },
  },

  timeCounter: {
    async read(x, ref) {
      const w = await itemById(await credsOf(x), idOf(ref), [COMPLETED]);
      if (!w) throw new ProviderError("notFound", `Azure DevOps: no work item ${ref.key}`);
      return { seconds: secondsOf(w.fields[COMPLETED]) ?? 0, version: String(w.rev) };
    },
    async increment(x, ref, seconds, m) {
      return moveCounter(x, ref, seconds, m.expectedVersion);
    },
    async decrement(x, ref, seconds, m) {
      // Never below zero.
      return moveCounter(x, ref, -seconds, m.expectedVersion);
    },
  },

  comments: {
    async list(x, ref) {
      const creds = await credsOf(x);
      return inProject(creds, ref, async (project) => {
        const out: RemoteComment[] = [];
        let token: string | undefined;
        for (let n = 0; n < 50; n++) {
          const r = await azOk<{ comments: AzureComment[]; continuationToken?: string }>(creds, `/${encodeURIComponent(project)}/_apis/wit/workItems/${idOf(ref)}/comments`, {
            version: COMMENTS_API_VERSION,
            params: { $top: 200, order: "asc", continuationToken: token },
          });
          out.push(...r.comments.filter((c) => !c.isDeleted).map(toRemoteComment));
          token = r.continuationToken;
          if (!token) break;
        }
        return out;
      });
    },
    async add(x, ref, body) {
      const creds = await credsOf(x);
      const c = await inProject(creds, ref, (project) =>
        azOk<AzureComment>(creds, `/${encodeURIComponent(project)}/_apis/wit/workItems/${idOf(ref)}/comments`, { method: "POST", version: COMMENTS_API_VERSION, body: JSON.stringify({ text: paragraphs(body) }) }),
      );
      return { comment: toRemoteComment(c), warnings: warningsFor(body) };
    },
  },

  async statusHistory(x, ref) {
    // A state is never emptied: a change from no state is the creating revision, whose state the next change starts from.
    // The state's name is its id (statuses() and the item's status).
    return statusSteps(await azureProvider.history!(x, ref), (c) => c.field.id === "System.State" && c.from.length > 0, (v) => v.text);

  },


  async history(x, ref) {
    const creds = await credsOf(x);
    const out: RemoteChange[] = [];
    for (let skip = 0, n = 0; n < 50; n++, skip += 200) {
      const r = await azOk<{ value: AzureUpdate[] }>(creds, `/_apis/wit/workItems/${idOf(ref)}/updates`, { params: { $top: 200, $skip: skip } });
      for (const u of r.value) {
        const at = instantFrom((u.fields?.["System.ChangedDate"]?.newValue as string | undefined) ?? u.revisedDate) ?? instant(0);
        for (const [field, v] of Object.entries(u.fields ?? {})) {
          if (BOOKKEEPING.has(field)) continue;
          out.push({ at, actor: person(u.revisedBy), field: { id: field, name: words(field) }, from: valueOf(v.oldValue), to: valueOf(v.newValue) });
        }
      }
      if (r.value.length < 200) break;
    }
    return out;
  },
};

// ---------- Service hooks ----------

/**
 * The Web Hooks consumer of Azure DevOps' service hooks: the subscription
 * carries a user name and password the service sends as Basic auth on every
 * delivery (there is no signature over the body). The payload is a signal: it
 * names the item, the engine reads it again.
 */
type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const HOOK_EVENTS: Record<string, WebhookEvent> = {
  "workitem.created": "issueChanged",
  "workitem.updated": "issueChanged",
  "workitem.restored": "issueChanged",
  "workitem.deleted": "issueRemoved",
  "workitem.commented": "commentAdded",
};
const digest = (s: string) => createHash("sha256").update(s).digest();

export const azureWebhook = {
  /** Whether a delivery carries the subscription's own user name and password (compared in constant time). */
  verify(authorization: string | null | undefined, secret: { username: string; password: string }): boolean {
    const expected = `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString("base64")}`;
    return typeof authorization === "string" && timingSafeEqual(digest(authorization), digest(expected));
  },
  /** The event's own id: a redelivery of the same event carries the same one (notificationId counts deliveries of a subscription, not events). */
  deliveryId(body: unknown): string | null {
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? id : null;
  },
  /** When the service says it sent the event. */
  sentAt(body: unknown): Instant | null {
    const at = (body as { createdDate?: unknown } | null)?.createdDate;
    return typeof at === "string" ? instantFrom(at) : null;
  },
  /** The layer's event for a delivery, and the work item it is about. */
  event(body: unknown): { event: WebhookEvent; remoteId: string | null } | null {
    const b = body as { eventType?: unknown; resource?: { id?: unknown; workItemId?: unknown } } | null;
    const event = typeof b?.eventType === "string" ? HOOK_EVENTS[b.eventType] : undefined;
    if (!event) return null;
    // workitem.updated and .commented name it differently
    const id = b?.resource?.workItemId ?? b?.resource?.id;
    return { event, remoteId: typeof id === "number" || typeof id === "string" ? String(id) : null };
  },
};
