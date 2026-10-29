// Jira (Cloud and Server/Data Center) as a tracker: the layer's contract on
// top of the Jira client (api/jira/client.ts), which keeps every detail of
// Jira's API. Nothing here changes how inkledger talks to Jira.
import { verifySha256Header } from "../core/webhooks";
import { toJql } from "./translate";
import { z } from "zod";
import type { MarkdownFeature, StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import type { JiraCredentials } from "@contracts/types";
import { toJiraStarted } from "@contracts/time";
import { instant, instantFrom, jsonPayload } from "@contracts/values";
import {
  createIssue,
  fetchCreateIssueTypes,
  fetchOtherFields,
  fetchIssueDescriptionRaw,
  fetchProjects,
  ISSUE_KEY_RE,
  JiraApiError,
  addComment,
  addWorklog,
  deleteWorklog,
  doTransition,
  fetchAssignedIssues,
  fetchComments,
  fetchDeletedWorklogIds,
  fetchIssueByKey,
  fetchChangelog,
  fetchIssueHistory,
  fetchRecentlyAssignedIssues,
  fetchTransitions,
  fetchUpdatedWorklogIds,
  fetchWorklog,
  fetchWorklogs,
  fetchWorklogsByIds,
  componentNames,
  getMyself,
  searchIssues,
  setWatching,
  textFromAdf,
  updateWorklog,
  type JiraComment,
  type JiraSearchedIssue,
  type JiraWorklog,
} from "../../jira/client";
import { decodeCheckpoint, encodeCheckpoint } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, ConversionWarning, FieldReq, FieldValue, RemoteBody, RemoteComment, RemoteIssue, RemoteStatus, RemoteWorklog, TrackerProvider, WorklogInput } from "../types";
import type { JiraTransitionField } from "../../jira/client";

export const jiraCapabilities: TrackerCapabilities = {
  workflow: { sources: [{ kind: "itemState", transitions: "workflow" }] },
  transitions: { read: true, write: true },
  statuses: false,
  searchText: true,
  query: "jql",
  // Cloud comments are ADF documents, Server ones wiki markup.
  comments: { mode: "readWrite", formats: ["adf", "jira-wiki"], writePreserves: ["paragraph"], idempotency: "local" },
  description: true,
  containers: true,
  // A new issue has a type, chosen among the project's.
  manage: { assign: false, labels: false, create: true, edit: false, types: true },
  watch: true,
  // Jira has no inbox of its own: news comes from what the sync sees change.
  inbox: false,
  // Custom fields by their names on the site.
  otherFields: true,
  history: true,
  statusHistory: true,
  time: {
    mode: "entries",
    entries: {
      model: "entries",
      shape: "session",
      write: { mode: "entry", update: "native", delete: true },
      feed: { kind: "incremental", removals: true },
      reconcile: { kind: "period" },
      // Billable time and activities belong to Tempo, a companion time sink.
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
    // Jira's searches only list what is still assigned: departures are found by reconciliation.
    gone: { deleted: false, lostAccess: false, movedOut: false, transfer: "none" },
    // Signals until a payload is shown to hold all the adapter needs (spikes: webhook payloads).
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
      { event: "worklogChanged", payload: "signal" },
      { event: "worklogRemoved", payload: "signal" },
    ],
  },
};

export const jiraTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  // Branches and pull requests only through an undocumented endpoint
  devLinks: false,
  attachments: { read: true, upload: true },
  timeboxes: ["sprint", "version"],
  fields: ["priority", "due", "start", "estimate", "points", "labels", "custom"],
};

const optionsSchema = z.strictObject({
  deployment: z.enum(["cloud", "server"]),
  authType: z.enum(["basic", "bearer"]),
  /** Login identifier: email (Cloud) or username (Server/DC) */
  username: z.string(),
  /** Which issues are mine here: assigned to me, or also the ones I reported */
  mine: z.enum(["assigned", "involved"]).default("assigned"),
});
export type JiraOptions = z.infer<typeof optionsSchema>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };

type X = CallContext<"jira", JiraOptions>;

/** The Jira client's credentials for a call. */
async function credsOf(x: X): Promise<JiraCredentials> {
  const cred = await x.conn.credential();
  const secret = cred.kind === "token" ? cred.token : cred.kind === "basic" ? cred.password : cred.accessToken;
  return { siteUrl: x.conn.baseUrl, deployment: x.conn.options.deployment, authType: x.conn.options.authType, username: x.conn.options.username, secret };
}

/** Jira's status category key, the same in every language. */
export function jiraCategory(key: string | undefined): StatusCategory {
  return key === "done" ? "done" : key === "indeterminate" ? "doing" : "todo";
}

function statusOf(s: { id?: string; name?: string; statusCategory?: { key?: string } } | undefined, resolution?: string | null): RemoteStatus {
  const name = s?.name ?? "Unknown";
  // The numeric id, as the changelog has it (the name is localized and can be renamed).
  return { id: s?.id ?? name, name, category: jiraCategory(s?.statusCategory?.key), categoryOrigin: { by: "native" }, source: { kind: "itemState" }, nativeReason: resolution ?? null };
}

const browse = (site: string, key: string) => `${site.replace(/\/+$/, "")}/browse/${key}`;

export function toRemoteIssue(siteUrl: string, i: JiraSearchedIssue): RemoteIssue {
  const f = i.fields;
  const project = f.project?.key ?? "";
  return {
    remoteId: i.id,
    key: i.key,
    url: browse(siteUrl, i.key),
    title: f.summary,
    type: { id: f.issuetype?.name ?? "", name: f.issuetype?.name ?? "" },
    status: statusOf(f.status),
    container: {
      remoteId: f.project?.id ?? project,
      key: project,
      name: f.project?.name ?? "",
      kind: "project",
      avatarUrl: f.project?.avatarUrls?.["48x48"] ?? f.project?.avatarUrls?.["32x32"] ?? null,
    },
    // The rank needs the site's priority order: computed where the catalogue is stored.
    priority: f.priority?.name ? { id: f.priority.name, name: f.priority.name, rank: null } : null,
    labels: f.labels ?? [],
    components: componentNames(f.components),
    assignees: f.assignee ? [{ remoteId: f.assignee.accountId ?? f.assignee.name ?? "", name: f.assignee.displayName ?? "" }] : [],
    reporter: f.reporter?.displayName ? { remoteId: "", name: f.reporter.displayName } : null,
    due: null,
    estimateSeconds: f.timeestimate ?? null,
    spentSeconds: f.timespent ?? null,
    createdAt: instantFrom(f.created),
    updatedAt: instantFrom(f.updated),
    statusChangedAt: instantFrom(f.statuscategorychangedate),
  };
}

export function toRemoteWorklog(w: JiraWorklog, me: string, issueKey?: string): RemoteWorklog {
  const mine = (w.author?.accountId ?? w.author?.name ?? w.author?.key ?? "") === me;
  return {
    remoteId: w.id,
    issue: w.issueId ? { remoteId: w.issueId, key: issueKey } : { key: issueKey ?? "" },
    span: { kind: "session", start: instantFrom(w.started) ?? instant(0), seconds: w.timeSpentSeconds },
    comment: textFromAdf(w.comment).trim(),
    authorRemoteId: w.author?.accountId ?? w.author?.name ?? w.author?.key ?? "",
    authorName: w.author?.displayName ?? null,
    createdAt: instantFrom(w.created),
    updatedAt: instantFrom(w.updated),
    // Someone else's entries: Jira's permissions decide, inkledger only offers its user's own.
    editable: { update: mine, delete: mine },
  };
}

function bodyOf(body: unknown): RemoteBody {
  if (typeof body === "string") return { kind: "text", format: "jira-wiki", text: body };
  const payload = jsonPayload(body);
  return payload === null ? { kind: "text", format: "jira-wiki", text: textFromAdf(body) } : { kind: "structured", format: "adf", payload, preview: textFromAdf(body) };
}

function toRemoteComment(c: JiraComment): RemoteComment {
  return {
    id: c.id,
    author: { remoteId: c.author?.accountId ?? c.author?.name ?? "", name: c.author?.displayName ?? "", avatarUrl: c.author?.avatarUrls?.["48x48"] ?? null },
    body: bodyOf(c.body),
    createdAt: instantFrom(c.created),
    updatedAt: instantFrom(c.updated),
  };
}

/** Markdown features Jira won't show as written (it gets the text as is until the RichText layer converts it). */
const MARKS: [MarkdownFeature, RegExp][] = [
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
  MARKS.filter(([, re]) => re.test(md)).map(([feature]) => ({ code: "approximated" as const, feature, serverDetail: `markdown ${feature} sent to Jira as plain text` }));

/** Jira keeps sessions: a start time and seconds. */
function jiraEntry(w: WorklogInput) {
  if (w.time.kind !== "session") throw new ProviderError("invalid", `Jira keeps time with a start time, not a ${w.time.kind}`);
  return { timeSpentSeconds: w.time.seconds, started: toJiraStarted(new Date(w.time.start)), comment: w.comment };
}

const normalizeKey = (raw: string) => {
  const key = raw.trim().toUpperCase();
  return ISSUE_KEY_RE.test(key) ? key : null;
};

/**
 * The fields a transition asks for: the required ones (on Server only
 * `required` says it: hasScreen is absent), and the resolution, which
 * workflows often expect without marking it.
 */
const asked = (id: string, f: JiraTransitionField) => f.required || id === "resolution";

/** A Jira field as the layer describes it; a type it doesn't know stays "unknown" (completed on Jira). */
function requirementOf(id: string, f: JiraTransitionField): FieldReq {
  const base = { id, name: f.name ?? id, required: f.required };
  const t = f.schema?.type;
  if (f.allowedValues?.length) {
    const options = f.allowedValues.map((v) => ({ id: v.id, name: v.name ?? v.value ?? v.id }));
    return t === "array" ? { ...base, type: "multiChoice", options } : { ...base, type: "choice", options };
  }
  if (t === "string") return { ...base, type: "text", multiline: f.schema?.system === "description" || f.schema?.system === "environment" || /textarea/.test(f.schema?.custom ?? "") };
  if (t === "number") return { ...base, type: "number" };
  if (t === "date" || t === "datetime") return { ...base, type: "date" };
  if (t === "user") return { ...base, type: "user" };
  return { ...base, type: "unknown", nativeType: f.schema?.custom ?? t ?? "unknown" };
}

/** A checked value (core/fields.ts) as Jira takes it for its field. */
function jiraValue(req: FieldReq | undefined, v: FieldValue, deployment: "cloud" | "server"): unknown {
  if (req?.type === "choice" && typeof v === "string") return { id: v };
  if (Array.isArray(v)) return v.map((id) => ({ id }));
  if (typeof v === "object") return "date" in v ? v.date : deployment === "cloud" ? { accountId: v.user } : { name: v.user };
  return v;
}

export const jiraProvider: TrackerProvider<"jira", JiraOptions> = {
  role: "tracker",
  type: "jira",
  capabilities: jiraCapabilities,
  traits: jiraTraits,
  settings: [{ key: "mine", choices: ["assigned", "involved"] }],

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw);
    if (!r.success) throw new ProviderError("invalid", `Jira options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(r, text) {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      const url = new URL(text.trim());
      const site = new URL(r.baseUrl);
      if (url.origin !== site.origin) return null;
      const m = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/.exec(url.pathname) ?? /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(url.search);
      const k = m ? normalizeKey(m[1]) : null;
      return k ? { key: k } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const me = await getMyself(await credsOf(x));
    return { remoteId: me.accountId ?? me.name ?? me.key ?? "", name: me.displayName, avatarUrl: me.avatarUrls?.["48x48"] ?? null, login: me.name, email: me.emailAddress };
  },

  async probe() {
    return {
      capabilities: jiraCapabilities,
      activeSources: [{ kind: "itemState", transitions: "workflow", ref: { kind: "itemState" }, name: "Jira workflow" }],
      verifiedAt: instant(Date.now()),
    };
  },

  async listChanged(x, q) {
    const creds = await credsOf(x);
    const startedAt = Date.now();
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    // The Jira client reads every page of a search itself: one page per pass.
    const found =
      since === null
        ? await fetchAssignedIssues(creds, x.conn.options.mine)
        : // A minute of margin: Jira's "updated" has minute precision in JQL.
          await fetchRecentlyAssignedIssues(creds, Math.ceil((startedAt - since) / 60_000) + 1, x.conn.options.mine);
    return { last: true, items: found.map((i) => toRemoteIssue(x.conn.baseUrl, i)), gone: [], checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: startedAt } satisfies Since) };
  },

  async getIssue(x, ref) {
    const i = await fetchIssueByKey(await credsOf(x), ref.key);
    // Moved since (a stale key): the issue answers to its id too.
    const found = i ?? (await searchIssues(await credsOf(x), `id = ${Number(ref.remoteId)}`, 1).catch(() => []))[0];
    return found && found.id === ref.remoteId ? toRemoteIssue(x.conn.baseUrl, found) : null;
  },

  async findIssue(x, handle) {
    const creds = await credsOf(x);
    const key = handle.key ? normalizeKey(handle.key) : null;
    const i = key ? await fetchIssueByKey(creds, key) : handle.remoteId ? (await searchIssues(creds, `id = ${Number(handle.remoteId)}`, 1).catch(() => []))[0] : null;
    // Jira keys are unique on a site: never ambiguous.
    return i ? { kind: "found", issue: toRemoteIssue(x.conn.baseUrl, i) } : { kind: "none" };
  },

  translate(expr, now) {
    return toJql(expr, now);
  },

  // Jira's webhooks: signed (X-Hub-Signature) when one is set on Jira; Server and
  // older Cloud sign nothing, so the connection's token in the URL is the check.
  webhook: {
    verify: (req, secret) => (req.headers["x-hub-signature"] ? verifySha256Header(req.headers["x-hub-signature"], secret, req.body) : true),
    deliveryId: (req) => req.headers["x-atlassian-webhook-identifier"] ?? null,
    sentAt: (req) => {
      try {
        const ts = (JSON.parse(req.body) as { timestamp?: unknown }).timestamp;
        return typeof ts === "number" ? ts : null;
      } catch {
        return null;
      }
    },
  },

  async searchText(x, text, limit) {
    const escaped = text.replace(/["\\]/g, "\\$&");
    const found = await searchIssues(await credsOf(x), `text ~ "${escaped}" ORDER BY updated DESC`, limit + 1);
    return { items: found.slice(0, limit).map((i) => toRemoteIssue(x.conn.baseUrl, i)), complete: found.length <= limit };
  },

  async query(x, jql, limit) {
    const found = await searchIssues(await credsOf(x), jql, limit + 1);
    return { items: found.slice(0, limit).map((i) => toRemoteIssue(x.conn.baseUrl, i)), complete: found.length <= limit };
  },

  async containers(x) {
    return (await fetchProjects(await credsOf(x))).map((p) => ({ remoteId: p.id, key: p.key, name: p.name, kind: "project" as const, avatarUrl: p.avatarUrl, group: p.category }));
  },

  async otherFields(x, ref) {
    return fetchOtherFields(await credsOf(x), ref.key);
  },

  manage: {
    async createTypes(x, container) {
      return (await fetchCreateIssueTypes(await credsOf(x), container.key)).filter((t) => !t.subtask).map((t) => ({ id: t.id, name: t.name }));
    },
    async create(x, container, draft) {
      const creds = await credsOf(x);
      // Jira asks for a type: the one chosen, else a task, else the first it offers.
      const offered = draft.type ? [] : (await fetchCreateIssueTypes(creds, container.key)).filter((t) => !t.subtask);
      const type = draft.type ?? (offered.find((t) => /^(task|attività)$/i.test(t.name)) ?? offered[0])?.id;
      if (!type) throw new ProviderError("invalid", `No issue type can be created in ${container.key}`);
      const created = await createIssue(creds, {
        projectKey: container.key,
        issueTypeId: type,
        summary: draft.title,
        description: draft.body ?? "",
        assignee: draft.assignees?.[0]?.remoteId ?? null,
      });
      const i = await fetchIssueByKey(creds, created.key);
      if (!i) throw new ProviderError("unavailable", `${created.key} was created but can't be read yet`);
      return toRemoteIssue(x.conn.baseUrl, i);
    },
  },

  async description(x, ref) {
    const raw = await fetchIssueDescriptionRaw(await credsOf(x), ref.key);
    return raw === null || raw === "" ? null : bodyOf(raw);
  },

  transitions: {
    async list(x, ref) {
      return (await fetchTransitions(await credsOf(x), ref.key, { fields: true })).map((tr) => ({
        id: tr.id,
        name: tr.name,
        to: statusOf(tr.to),
        requirements: Object.entries(tr.fields ?? {})
          .filter(([id, f]) => asked(id, f))
          .map(([id, f]) => requirementOf(id, f)),
        remoteUrl: browse(x.conn.baseUrl, ref.key),
      }));
    },
    async apply(x, ref, transitionId, fields) {
      const creds = await credsOf(x);
      // Values go out in each field's own form: the transition says which.
      let values: Record<string, unknown> = {};
      if (Object.keys(fields).length > 0) {
        const tr = (await fetchTransitions(creds, ref.key, { fields: true })).find((t) => t.id === transitionId);
        const reqs = new Map(Object.entries(tr?.fields ?? {}).map(([id, f]) => [id, requirementOf(id, f)]));
        values = Object.fromEntries(Object.entries(fields).map(([id, v]) => [id, jiraValue(reqs.get(id), v, x.conn.options.deployment)]));
      }
      await doTransition(creds, ref.key, transitionId, values);
      // Jira answers 204: the engine reads the issue again.
      return null;
    },
  },

  worklogs: {
    async list(x, ref) {
      return (await fetchWorklogs(await credsOf(x), ref.key)).map((w) => toRemoteWorklog(w, x.conn.remoteAccountId, ref.key));
    },
    async changed(x, q) {
      const creds = await credsOf(x);
      const since = decodeCheckpoint<Since>(x.conn, "worklogs", V, q.since)?.at ?? 0;
      const updated = await fetchUpdatedWorklogIds(creds, since);
      const deleted = await fetchDeletedWorklogIds(creds, since);
      const items = (await fetchWorklogsByIds(creds, updated.ids)).map((w) => toRemoteWorklog(w, x.conn.remoteAccountId));
      return {
        last: true,
        items,
        gone: deleted.ids.map((id) => ({ remoteId: id, reason: "deleted" as const })),
        checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: Math.max(updated.until, deleted.until) } satisfies Since),
      };
    },
    async get(x, ref, id) {
      const w = await fetchWorklog(await credsOf(x), ref.key, id);
      return w ? toRemoteWorklog(w, x.conn.remoteAccountId, ref.key) : null;
    },
    async create(x, ref, w) {
      return toRemoteWorklog(await addWorklog(await credsOf(x), ref.key, jiraEntry(w)), x.conn.remoteAccountId, ref.key);
    },
    async update(x, ref, id, w) {
      return toRemoteWorklog(await updateWorklog(await credsOf(x), ref.key, id, jiraEntry(w)), x.conn.remoteAccountId, ref.key);
    },
    async delete(x, ref, id) {
      try {
        await deleteWorklog(await credsOf(x), ref.key, id);
      } catch (e) {
        // Already gone is what was asked for.
        if (e instanceof JiraApiError && e.status === 404) return;
        throw e;
      }
    },
  },

  comments: {
    async list(x, ref) {
      return (await fetchComments(await credsOf(x), ref.key)).map(toRemoteComment);
    },
    async add(x, ref, body) {
      return { comment: toRemoteComment(await addComment(await credsOf(x), ref.key, body)), warnings: warningsFor(body) };
    },
  },

  async watch(x, ref, on) {
    // Watching what is watched (or not) is a success: Jira answers the same.
    await setWatching(await credsOf(x), ref.key, x.conn.remoteAccountId, on);
  },

  async statusHistory(x, ref) {
    const { histories } = await fetchChangelog(await credsOf(x), ref.key);
    // A status change is the system field "status" (never translated); its values are the statuses' ids.
    return histories.flatMap((entry) =>
      (entry.items ?? []).flatMap((item) =>
        item.field === "status" && item.fieldtype === "jira" && item.to && item.from !== item.to
          ? [{ at: instantFrom(entry.created) ?? instant(0), from: item.from ? { id: item.from, name: item.fromString ?? item.from } : null, to: { id: item.to, name: item.toString ?? item.to } }]
          : [],
      ),
    );
  },

  async history(x, ref) {
    const h = await fetchIssueHistory(await credsOf(x), ref.key);
    return h.histories.flatMap((entry) =>
      (entry.items ?? []).map((item) => ({
        at: instantFrom(entry.created) ?? instant(0),
        actor: entry.author ? { remoteId: entry.author.accountId ?? entry.author.name ?? "", name: entry.author.displayName ?? "" } : null,
        field: { id: item.field, name: item.field ?? "" },
        from: item.fromString ? [{ text: item.fromString }] : [],
        to: item.toString ? [{ text: item.toString }] : [],
      })),
    );
  },
};
