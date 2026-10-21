// Tempo (Jira) as a time sink, through the provider contract. A time sink only
// receives time: every worklog of the user is also filed here, on the Jira
// issue named by its id (Tempo takes `issueId`, never the key), as a session
// (startDate + startTime in the user's own zone + timeSpentSeconds). A change
// replaces the whole worklog (PUT), so what inkledger doesn't say is carried
// over from the stored one. The note always starts with the issue's key and
// title. Tempo mirrors each worklog into Jira under another id: the Tempo id
// is the entry's identity, the Jira one is kept in the entry's version and read
// with jiraWorklogIdOf. Built from Tempo's documentation on a simulator, not
// yet on a real account: SPIKES.md.
import { z } from "zod";
import type { TimeSinkCapabilities, TimeSinkTraits } from "@contracts/providers";
import { instant, instantFrom, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, CatalogItem, ExternalRef, Limited, Page, RemoteWorklog, ReportedEntryGone, TimeSinkProvider, WorklogInput } from "../types";
import { instantOfWall, PER_PAGE, tp, tpOk, tpPages, wallOf, withQuery, type TempoApproval, type TempoCreds, type TempoList, type TempoWorkAttribute, type TempoWorklog } from "./client";

// The catalogue's entry for tempo, here where the adapter keeps to it (the
// registry holds the two together).
export const tempoSinkCapabilities: TimeSinkCapabilities = {
  entries: {
    model: "entries",
    shape: "session",
    // A change is a PUT of the whole worklog.
    write: { mode: "entry", update: "replace", delete: true },
    // updatedFrom filters by change; whether it can carry a checkpoint (incremental)
    // is open (verify: tempo-updated-from): until then a window by change
    feed: { kind: "window", by: "updatedAt", lookbackMs: 7 * 86_400_000, overlapMs: 3_600_000 },
    reconcile: { kind: "period" },
    billable: { read: true, write: true },
    activities: { read: true, write: true, required: "no" },
    onBehalf: { read: true, write: false },
    approvals: { read: true },
    idempotency: "local",
    concurrency: "none",
    limits: {},
  },
  references: ["issueId"],
  target: { use: "none" },
  // Published budget and its scope (verify: tempo-rate-limit): none declared until then
};
export const tempoSinkTraits: TimeSinkTraits = { invoices: false, rates: false };

const optionsSchema = z.strictObject({
  /** The Jira connection this Tempo account belongs to: its account id is the author of every worklog */
  jiraConnectionId: z.number().int().positive().nullish(),
  /** The user's Jira account id (the author); the connection's own remote account when absent */
  accountId: z.string().min(1).nullish(),
  /** The work attribute (a static list) that is the activity; the first static list when absent */
  workAttributeKey: z.string().min(1).nullish(),
});
export type TempoOptions = { jiraConnectionId: number | null; accountId: string | null; workAttributeKey: string | null };

type X = CallContext<"tempo", TempoOptions>;

const V = 1;
const DAY_MS = 86_400_000;
const LOOKBACK_MS = 7 * DAY_MS;
const OVERLAP_MS = 3_600_000;

async function credsOf(x: X): Promise<TempoCreds> {
  const cred = await x.conn.credential();
  const token = cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password;
  return { apiBase: x.conn.baseUrl, token };
}

/** The Jira account the worklogs are for. */
function accountOf(x: X): string {
  const id = x.conn.options.accountId ?? x.conn.remoteAccountId;
  if (!id) throw new ProviderError("invalid", "Tempo: the Jira account id of the user is missing");
  return id;
}

const enc = encodeURIComponent;

// ---------- The two ids of a worklog ----------

/**
 * A worklog carries its Jira mirror's id in `version` ("<updatedAt>#jira=<id>"),
 * which the sync stores with the entry: Tempo's calls take tempoWorklogId (the
 * entry's remoteId), Jira's own worklog list knows jiraWorklogId, and the two
 * are different numbers.
 */
export function jiraWorklogIdOf(remote: RemoteWorklog): string | null {
  return /(?:^|#)jira=(\d+)$/.exec(remote.version ?? "")?.[1] ?? null;
}

// ---------- The note ----------

const HEAD = /^([A-Z][A-Z0-9_]*-\d+): ([^\n]*)(?:\n([\s\S]*))?$/;

/** The note's first line says which issue it is, whatever the comment. */
function noteOf(ref: ExternalRef, comment: string): string {
  const head = `${ref.issue.key}: ${ref.snapshot.title.replace(/\s+/g, " ").trim()}`;
  return comment.trim() ? `${head}\n${comment}` : head;
}

/** The note as stored without its first line; a note not made here is a comment as it is. */
const commentOf = (description: string | null | undefined): string => {
  const text = description ?? "";
  const m = HEAD.exec(text);
  return m ? (m[3] ?? "") : text;
};

// ---------- Activities (work attributes) ----------

type ActivityAttribute = { key: string; names: Map<string, string>; values: string[] };
const ATTRIBUTES = new WeakMap<object, { at: number; found: Promise<ActivityAttribute | null> }>();
const ATTRIBUTES_LIFE_MS = 10 * 60_000;

async function attributes(c: TempoCreds): Promise<TempoWorkAttribute[]> {
  return (await tpPages<TempoWorkAttribute>(c, withQuery("/work-attributes", { limit: PER_PAGE }))) ?? [];
}

/** The work attribute that is the activity (kept for a few minutes: a worklog read needs it to name its activity). */
function activityAttribute(x: X, c: TempoCreds): Promise<ActivityAttribute | null> {
  const cached = ATTRIBUTES.get(x.conn);
  if (cached && Date.now() - cached.at < ATTRIBUTES_LIFE_MS) return cached.found;
  const found = attributes(c).then((all) => {
    const lists = all.filter((a) => a.type === "STATIC_LIST");
    const chosen = x.conn.options.workAttributeKey ? lists.find((a) => a.key === x.conn.options.workAttributeKey) : lists[0];
    return chosen ? { key: chosen.key, values: chosen.values ?? [], names: new Map(Object.entries(chosen.names ?? {})) } : null;
  });
  ATTRIBUTES.set(x.conn, { at: Date.now(), found });
  found.catch(() => ATTRIBUTES.delete(x.conn));
  return found;
}

// ---------- Worklogs ----------

type Approvals = TempoApproval[] | null;

const approvalState = (key: string) => (key === "APPROVED" ? ("approved" as const) : key === "IN_REVIEW" || key === "WAITING_FOR_APPROVAL" ? ("submitted" as const) : ("draft" as const));

/** The approval periods around some days; null when the plan has no timesheet approvals (403/404). */
async function approvalsFor(x: X, c: TempoCreds, days: string[]): Promise<Approvals> {
  if (days.length === 0) return [];
  const sorted = [...days].sort();
  return tpPages<TempoApproval>(c, withQuery(`/timesheet-approvals/user/${enc(accountOf(x))}`, { from: sorted[0], to: sorted[sorted.length - 1], limit: PER_PAGE }), { absentIsNull: true });
}

function toRemote(w: TempoWorklog, zone: TimeZone, act: ActivityAttribute | null, approvals: Approvals): RemoteWorklog | null {
  const start = instantOfWall(w.startDate, w.startTime || "00:00:00", zone);
  if (start === null) return null;
  const period = approvals?.find((a) => a.period.from <= w.startDate && w.startDate <= a.period.to);
  const state = approvals === null ? undefined : period ? approvalState(period.status.key) : ("none" as const);
  const locked = state === "approved" ? { cause: "approved" as const, message: "The timesheet of this period is approved" } : null;
  const value = act ? w.attributes?.values.find((v) => v.key === act.key)?.value : undefined;
  const updatedAt = instantFrom(w.updatedAt);
  return {
    remoteId: String(w.tempoWorklogId),
    issue: w.issue ? { remoteId: String(w.issue.id) } : null,
    span: { kind: "session", start: instant(start), seconds: w.timeSpentSeconds },
    comment: commentOf(w.description),
    authorRemoteId: w.author.accountId,
    createdAt: instantFrom(w.createdAt),
    updatedAt,
    // Billable seconds may be part of the time: any of it counts as billable.
    billable: w.billableSeconds == null ? null : w.billableSeconds > 0,
    activity: value === undefined ? null : { id: value, name: act?.names.get(value) ?? value },
    ...(state ? { approval: state } : {}),
    version: `${w.updatedAt ?? ""}${w.jiraWorklogId ? `#jira=${w.jiraWorklogId}` : ""}`,
    ...(locked ? { locked } : {}),
    editable: { update: !locked, delete: !locked },
  };
}

async function remotes(x: X, c: TempoCreds, rows: TempoWorklog[]): Promise<RemoteWorklog[]> {
  const [act, approvals] = await Promise.all([activityAttribute(x, c), approvalsFor(x, c, rows.map((r) => r.startDate))]);
  return rows.flatMap((r) => toRemote(r, x.conn.timeZone, act, approvals) ?? []);
}

/** The worklog as Tempo answers a write: no approval lookup (it was just accepted). */
async function written(x: X, c: TempoCreds, w: TempoWorklog): Promise<RemoteWorklog> {
  const r = toRemote(w, x.conn.timeZone, await activityAttribute(x, c), null);
  if (!r) throw new ProviderError("incompatible", "Tempo: a worklog with an unreadable start");
  return r;
}

/** Billable seconds for a worklog of `seconds`: said by the input, else what the stored one was (all, none, or its part). */
function billableFor(seconds: number, wanted: boolean | undefined, was?: TempoWorklog): number | undefined {
  if (wanted !== undefined) return wanted ? seconds : 0;
  if (!was || was.billableSeconds == null) return undefined;
  return was.billableSeconds >= was.timeSpentSeconds ? seconds : Math.min(was.billableSeconds, seconds);
}

function bodyOf(x: X, input: WorklogInput, note: string, seconds: number, extra: { issueId: number; billableSeconds?: number; attributes?: { key: string; value: string }[] }) {
  if (input.time.kind !== "session") throw new ProviderError("invalid", "Tempo keeps sessions: a start and a duration");
  const at = wallOf(input.time.start, x.conn.timeZone);
  return {
    issueId: extra.issueId,
    authorAccountId: accountOf(x),
    startDate: at.date,
    startTime: at.time,
    timeSpentSeconds: seconds,
    description: note,
    ...(extra.billableSeconds !== undefined ? { billableSeconds: extra.billableSeconds } : {}),
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
  };
}

/** The attribute pair for an activity chosen, checked against the list Tempo offers. */
async function activityPair(x: X, c: TempoCreds, id: string): Promise<{ key: string; value: string }> {
  const act = await activityAttribute(x, c);
  if (!act) throw new ProviderError("invalid", "Tempo: this account has no work attribute to use as an activity");
  if (act.values.length > 0 && !act.values.includes(id)) throw new ProviderError("invalid", `Tempo: "${id}" is not one of the values of ${act.key}`);
  return { key: act.key, value: id };
}

const issueIdOf = (ref: ExternalRef): number => {
  const id = Number(ref.issue.remoteId);
  if (!Number.isInteger(id) || id <= 0) throw new ProviderError("invalid", `Tempo needs the Jira issue's id, not its key (${ref.issue.key})`);
  return id;
};

// ---------- Feed ----------

type FeedPass = { offset: number; at: number };
type FeedSince = { at: number };

const isoSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export const tempoSink: TimeSinkProvider<"tempo", TempoOptions> = {
  role: "timeSink",
  type: "tempo",
  capabilities: tempoSinkCapabilities,
  traits: tempoSinkTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Tempo options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return { jiraConnectionId: r.data.jiraConnectionId ?? null, accountId: r.data.accountId ?? null, workAttributeKey: r.data.workAttributeKey ?? null };
  },

  async verify(x) {
    // Tempo has no "who am I": the worklogs of the account prove the token and the account id together.
    const id = accountOf(x);
    await tpOk<TempoList<TempoWorklog>>(await credsOf(x), withQuery(`/worklogs/user/${enc(id)}`, { limit: 1 }));
    return { remoteId: id, name: `Tempo account ${id}` };
  },

  async probe(x) {
    const c = await credsOf(x);
    await tpOk<TempoList<TempoWorklog>>(c, withQuery(`/worklogs/user/${enc(accountOf(x))}`, { limit: 1 }));
    return { capabilities: tempoSinkCapabilities, verifiedAt: instant(Date.now()) };
  },

  entries: {
    async list(x, range) {
      const c = await credsOf(x);
      const rows = await tpPages<TempoWorklog>(c, withQuery(`/worklogs/user/${enc(accountOf(x))}`, { from: range.from, to: range.to, limit: PER_PAGE }));
      return remotes(x, c, rows ?? []);
    },

    /** Worklogs changed since the checkpoint (a week back at the first pass): updatedFrom filters by change, to the second. */
    async changed(x, q): Promise<Page<RemoteWorklog, ReportedEntryGone>> {
      const c = await credsOf(x);
      const since = decodeCheckpoint<FeedSince>(x.conn, "worklogs", V, q.since)?.at ?? null;
      const pass = decodePageToken<FeedPass>(x.conn, "worklogs", V, q.since, q.page) ?? { offset: 0, at: Date.now() };
      const r = await tpOk<TempoList<TempoWorklog>>(c, withQuery(`/worklogs/user/${enc(accountOf(x))}`, { updatedFrom: isoSeconds(since ?? pass.at - LOOKBACK_MS), offset: pass.offset, limit: PER_PAGE }));
      const items = await remotes(x, c, r.results ?? []);
      if (r.metadata?.next) return { last: false, items, gone: [], next: encodePageToken(x.conn, "worklogs", V, q.since, { offset: pass.offset + PER_PAGE, at: pass.at } satisfies FeedPass) };
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "worklogs", V, { at: pass.at - OVERLAP_MS } satisfies FeedSince) };
    },

    async create(x, ref, _target, w) {
      const c = await credsOf(x);
      const pair = w.activityId ? await activityPair(x, c, w.activityId) : null;
      const body = bodyOf(x, w, noteOf(ref, w.comment), w.time.seconds, {
        issueId: issueIdOf(ref),
        billableSeconds: billableFor(w.time.seconds, w.billable),
        ...(pair ? { attributes: [pair] } : {}),
      });
      // Tempo has no idempotency key: a POST sent twice makes two worklogs (the engine only retries what a read shows didn't land).
      return written(x, c, await tpOk<TempoWorklog>(c, "/worklogs", { method: "POST", data: body }));
    },

    async update(x, id, w) {
      const c = await credsOf(x);
      const was = (await tp<TempoWorklog>(c, `/worklogs/${enc(id)}`, { missingIsNull: true }))?.data;
      if (!was) throw new ProviderError("notFound", `Tempo: no worklog ${id}`);
      if (!was.issue) throw new ProviderError("incompatible", "Tempo: a worklog with no issue");
      const pair = w.activityId ? await activityPair(x, c, w.activityId) : null;
      // A PUT replaces the worklog: what isn't sent is cleared, so the stored attributes and note head go along.
      const kept = (was.attributes?.values ?? []).filter((v) => v.key !== pair?.key);
      const head = HEAD.exec(was.description ?? "");
      const note = head ? `${head[1]}: ${head[2]}${w.comment.trim() ? `\n${w.comment}` : ""}` : w.comment;
      const body = bodyOf(x, w, note, w.time.seconds, {
        issueId: was.issue.id,
        billableSeconds: billableFor(w.time.seconds, w.billable, was),
        attributes: pair ? [...kept, pair] : kept,
      });
      return written(x, c, await tpOk<TempoWorklog>(c, `/worklogs/${enc(id)}`, { method: "PUT", data: body }));
    },

    async delete(x, id) {
      // Deleting what is already gone is a success. The id is the Tempo one: Jira's mirror id is a 404 here.
      await tp<undefined>(await credsOf(x), `/worklogs/${enc(id)}`, { method: "DELETE", missingIsNull: true });
    },

    async activities(x, _scope, limit): Promise<Limited<CatalogItem>> {
      const act = await activityAttribute(x, await credsOf(x));
      const items = (act?.values ?? []).map((v) => ({ id: v, name: act?.names.get(v) ?? v }));
      return { items: items.slice(0, limit), complete: items.length <= limit };
    },
  },
};
