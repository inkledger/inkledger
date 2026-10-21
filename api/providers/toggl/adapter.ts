// Toggl Track as a time sink: every worklog of the user is also filed there, as
// a time entry (a start and a duration in whole seconds) under the project the
// issue's container is mapped to. Toggl knows no issues: the entry's
// description says which one it is for ("[KEY] Title — note"), and it is read
// back from there. Written from the API v9 documentation and tested on a
// simulator; its traps are in simulator.ts, its open questions in SPIKES.md.
import { z } from "zod";
import type { TimeSinkCapabilities, TimeSinkTraits } from "@contracts/providers";
import { instant, instantFrom, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, encodeCheckpoint } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, ExternalRef, IssueHandle, Limited, RemoteWorklog, SinkTarget, TimeSinkProvider, WorklogInput } from "../types";
import { toggl, togglOk, withQuery, type TogglCreds, type TogglEntry, type TogglMe, type TogglPatchResult, type TogglProject, type TogglWorkspace } from "./client";

// The catalogue's entry for toggl, here where the adapter keeps to it (the
// registry holds the two together).
export const togglSinkCapabilities: TimeSinkCapabilities = {
  entries: {
    model: "entries",
    shape: "session",
    write: { mode: "entry", update: "native", delete: true },
    // /me/time_entries?since= lists what changed, deleted entries marked; no removals are reported (a window is read again)
    feed: { kind: "window", by: "updatedAt", lookbackMs: 7 * 86_400_000, overlapMs: 3_600_000 },
    reconcile: { kind: "period" },
    billable: { read: true, write: true },
    activities: { read: false, write: false, required: "no" },
    onBehalf: { read: false, write: false },
    approvals: { read: false },
    // No idempotency key: a retried POST makes a second entry
    idempotency: "local",
    concurrency: "none",
    limits: {},
  },
  references: ["projectTask", "description"],
  target: { use: "optional", lookup: "search" },
  // The free plan: 30 requests per hour; over it, 402
  typicalRateLimit: { perHour: 30 },
};
export const togglSinkTraits: TimeSinkTraits = { invoices: true, rates: true };

const optionsSchema = z.object({
  /** The workspace entries are filed in (its id, as in the URL of Track) */
  workspaceId: z.coerce.number().int().positive(),
});
export type TogglOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"toggl", TogglOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };

const DAY_MS = 86_400_000;
/** The feed window the capabilities declare. */
const LOOKBACK_MS = 7 * DAY_MS;
/** Overlap read again at each pass: an entry may land after the clock that stamps it. */
const OVERLAP_MS = 60_000;
/** /me/time_entries answers at most this many entries, with no sign of more. */
export const ENTRIES_CAP = 1000;
/** A date range wider than this is refused by /me/time_entries: ranges are read in pieces. */
export const MAX_RANGE_DAYS = 90;
/** Projects come this many a page (the maximum). */
const PROJECTS_PER_PAGE = 200;
const MAX_PROJECT_PAGES = 5;
/** A description is cut at this many characters. */
export const MAX_DESCRIPTION = 3000;
/** Shown by Toggl as the app that made an entry (required on creation). */
const CREATED_WITH = "inkledger";

async function credsOf(x: X): Promise<TogglCreds> {
  const cred = await x.conn.credential();
  if (cred.kind !== "token") throw new ProviderError("auth", "Toggl needs a personal API token");
  return { apiBase: x.conn.baseUrl, token: cred.token };
}

// ---------- Days and instants ----------

const nextDay = (date: LocalDate): string => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** The first instant of a calendar day in a zone (the day's start, whatever the offset or a clock change that day). */
export function dayStart(date: string, zone: TimeZone): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const utc = Date.parse(`${date}T00:00:00Z`);
  const STEP = 15 * 60_000;
  // Offsets run from -12 to +14 hours, in quarter hours: the first instant whose day is this one.
  for (let t = utc - 14 * 3_600_000; t <= utc + 12 * 3_600_000; t += STEP) {
    if (day.format(t) === date && day.format(t - STEP) !== date) return t;
  }
  return utc;
}

/** RFC 3339 in UTC, whole seconds (the form Toggl documents). */
const rfc3339 = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------- The note: which issue an entry is for ----------

const HEAD = /^\[([^\]]+)\] /;
const SEP = " — ";

/** "[KEY] Title": the issue as the note names it (a separator or bracket inside is replaced, so the note reads back exactly). */
export function noteHead(ref: ExternalRef): string {
  const key = ref.issue.key.replaceAll("]", ")");
  const title = (ref.snapshot.title || ref.issue.key).replaceAll(SEP, " – ").replace(/\s+/g, " ").trim();
  return `[${key}] ${title}`;
}

/** The note: the head, then the worklog's own comment; held to Toggl's length (the comment is cut first). */
export function noteOf(head: string, comment: string): string {
  const text = comment.replace(/\s+/g, " ").trim();
  const h = head.slice(0, MAX_DESCRIPTION);
  if (!text) return h;
  const room = MAX_DESCRIPTION - h.length - SEP.length;
  if (!h) return text.slice(0, MAX_DESCRIPTION);
  return room > 0 ? `${h}${SEP}${text.slice(0, room)}` : h;
}

/** An entry's description as the head it starts with (kept on a change) and the comment after it. */
export function readNote(description: string | null): { head: string; issue: IssueHandle | null; comment: string } {
  const d = description ?? "";
  const m = HEAD.exec(d);
  if (!m) return { head: "", issue: null, comment: d };
  const at = d.indexOf(SEP, m[0].length);
  return { head: at < 0 ? d : d.slice(0, at), issue: { key: m[1] }, comment: at < 0 ? "" : d.slice(at + SEP.length) };
}

// ---------- Shaping ----------

/** An entry as a worklog; null for a running timer (not a span yet) and for one that was deleted. */
export function toRemoteWorklog(e: TogglEntry): RemoteWorklog | null {
  const start = instantFrom(e.start);
  if (e.duration < 0 || e.stop === null || !start || e.server_deleted_at) return null;
  const note = readNote(e.description);
  return {
    remoteId: String(e.id),
    issue: note.issue,
    span: { kind: "session", start, seconds: e.duration },
    comment: note.comment,
    authorRemoteId: String(e.user_id ?? e.uid ?? 0),
    updatedAt: instantFrom(e.at),
    billable: e.billable,
    editable: { update: true, delete: true },
  };
}

const toTarget = (p: TogglProject): SinkTarget => ({ remoteId: String(p.id), name: p.name, path: [] });

const idOf = (value: string, what: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ProviderError("invalid", `Toggl: ${what} ${value} is not an id`);
  return n;
};

/** A refusal in a bulk PATCH's answer, as the error of its kind. */
function patchFailure(message: string): ProviderError {
  const kind = /lock/i.test(message) ? "conflict" : /not found|does not exist/i.test(message) ? "notFound" : "invalid";
  return new ProviderError(kind, `Toggl: ${message}`);
}

/** The entries of a span of time, in pieces: ranges wider than the API takes are cut, and an answer at the cap is cut in halves. */
async function readSpan(c: TogglCreds, from: number, to: number, into: Map<number, TogglEntry>): Promise<void> {
  // A piece a day shorter than the maximum: the span asked for is a second wider on each side.
  if (to - from > (MAX_RANGE_DAYS - 1) * DAY_MS) {
    const mid = from + (MAX_RANGE_DAYS - 1) * DAY_MS;
    await readSpan(c, from, mid, into);
    return readSpan(c, mid, to, into);
  }
  // A bare date is read as UTC: instants, a second wider on each side, are asked for and the answer is cut to the span after.
  const rows = (await togglOk<TogglEntry[] | null>(c, withQuery("/me/time_entries", { start_date: rfc3339(from - 1000), end_date: rfc3339(to + 1000) }))) ?? [];
  if (rows.length >= ENTRIES_CAP && to - from > 120_000) {
    const mid = from + Math.floor((to - from) / 2);
    await readSpan(c, from, mid, into);
    return readSpan(c, mid, to, into);
  }
  for (const e of rows) into.set(e.id, e);
}

export const togglSink: TimeSinkProvider<"toggl", TogglOptions> = {
  role: "timeSink",
  type: "toggl",
  capabilities: togglSinkCapabilities,
  traits: togglSinkTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Toggl options: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return r.data;
  },

  async verify(x) {
    const me = await togglOk<TogglMe>(await credsOf(x), "/me");
    return { remoteId: String(me.id), name: me.fullname || me.email || String(me.id), ...(me.email ? { email: me.email } : {}), ...(me.image_url ? { avatarUrl: me.image_url } : {}) };
  },

  async probe(x) {
    // The workspace: reachable by this user, and its plan says what is allowed and how many calls an hour.
    const ws = await togglOk<TogglWorkspace>(await credsOf(x), `/workspaces/${x.conn.options.workspaceId}`);
    const paid = ws.premium === true;
    const e = togglSinkCapabilities.entries;
    return {
      // The free plan has no billable rates: billable is read, never written.
      capabilities: paid || e.model !== "entries" ? togglSinkCapabilities : { ...togglSinkCapabilities, entries: { ...e, billable: { read: true, write: false } } },
      // The lowest paid plan's budget, as published (the plan itself is not told apart).
      rateLimit: { perHour: paid ? 240 : 30, origin: "typical" },
      verifiedAt: instant(Date.now()),
    };
  },

  async targets(x, query, limit): Promise<Limited<SinkTarget>> {
    const c = await credsOf(x);
    const q = query.trim().toLowerCase();
    const found: SinkTarget[] = [];
    // The `name` filter is not trusted to match parts of a name: the active projects are read and matched here (null when there are none).
    for (let page = 1; page <= MAX_PROJECT_PAGES; page++) {
      const rows = (await togglOk<TogglProject[] | null>(c, withQuery(`/workspaces/${x.conn.options.workspaceId}/projects`, { active: true, page, per_page: PROJECTS_PER_PAGE }))) ?? [];
      found.push(...rows.filter((p) => !q || p.name.toLowerCase().includes(q)).map(toTarget));
      if (rows.length < PROJECTS_PER_PAGE) return { items: found.slice(0, limit), complete: found.length <= limit };
    }
    return { items: found.slice(0, limit), complete: false };
  },

  entries: {
    async list(x, range) {
      const c = await credsOf(x);
      const from = dayStart(range.from, x.conn.timeZone);
      const to = dayStart(nextDay(range.to), x.conn.timeZone);
      const all = new Map<number, TogglEntry>();
      await readSpan(c, from, to, all);
      // /me/time_entries spans every workspace of the user.
      return [...all.values()]
        .filter((e) => e.workspace_id === x.conn.options.workspaceId)
        .flatMap((e) => {
          const w = toRemoteWorklog(e);
          return w && w.span.kind === "session" && w.span.start >= from && w.span.start < to ? [w] : [];
        })
        .sort((a, b) => (a.span.kind === "session" && b.span.kind === "session" ? a.span.start - b.span.start : 0) || a.remoteId.localeCompare(b.remoteId));
    },

    /** Entries changed since the checkpoint, within the window: one answer, no pages. Deleted entries come marked and are left out (a window reports no removals). */
    async changed(x, q) {
      const c = await credsOf(x);
      const now = Date.now();
      const since = Math.max(decodeCheckpoint<Since>(x.conn, "entries", V, q.since)?.at ?? 0, now - LOOKBACK_MS);
      // `since` is a Unix timestamp in seconds, not milliseconds.
      const rows = (await togglOk<TogglEntry[] | null>(c, withQuery("/me/time_entries", { since: Math.floor(since / 1000) }))) ?? [];
      const items = rows.filter((e) => e.workspace_id === x.conn.options.workspaceId).flatMap((e) => toRemoteWorklog(e) ?? []);
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "entries", V, { at: now - OVERLAP_MS } satisfies Since) };
    },

    async create(x, ref, target, w) {
      const c = await credsOf(x);
      const wid = x.conn.options.workspaceId;
      const { start, seconds } = span(w);
      // A target with ancestors is a task (its project is the ancestor); one without, a project.
      const project = target ? idOf(target.path.length > 0 ? target.path[target.path.length - 1].remoteId : target.remoteId, "project") : null;
      const task = target && target.path.length > 0 ? idOf(target.remoteId, "task") : null;
      const e = await togglOk<TogglEntry>(c, `/workspaces/${wid}/time_entries`, {
        method: "POST",
        data: {
          created_with: CREATED_WITH,
          workspace_id: wid,
          // A running timer is a negative duration: this one is a span, start and seconds, never -1.
          start: rfc3339(start),
          duration: seconds,
          description: noteOf(noteHead(ref), w.comment),
          ...(project !== null ? { project_id: project } : {}),
          ...(task !== null ? { task_id: task } : {}),
          ...(w.billable !== undefined ? { billable: w.billable } : {}),
        },
      });
      const made = toRemoteWorklog(e);
      if (!made) throw new ProviderError("incompatible", "Toggl: a created time entry that is not a span");
      return made;
    },

    /** Read, then changed with a bulk PATCH of only what changes: a PUT might clear the project and task, which the call doesn't know. */
    async update(x, id, w) {
      const c = await credsOf(x);
      const wid = x.conn.options.workspaceId;
      const r = await toggl<TogglEntry>(c, `/me/time_entries/${encodeURIComponent(id)}`, { missingIsNull: true });
      const cur = r?.data;
      if (!cur || cur.workspace_id !== wid || cur.server_deleted_at) throw new ProviderError("notFound", `Toggl: no time entry ${id}`);
      // A running timer is the user's own, in progress: not ours to rewrite.
      if (cur.duration < 0) throw new ProviderError("conflict", "Toggl: that entry is a running timer");
      const { start, seconds } = span(w);
      const description = noteOf(readNote(cur.description).head, w.comment);
      const stop = start + seconds * 1000;
      // Start, stop and duration move together: a duration alone leaves the stop where it was.
      const ops = [
        { op: "replace", path: "/start", value: rfc3339(start) },
        { op: "replace", path: "/stop", value: rfc3339(stop) },
        { op: "replace", path: "/duration", value: seconds },
        { op: "replace", path: "/description", value: description },
        ...(w.billable !== undefined ? [{ op: "replace", path: "/billable", value: w.billable }] : []),
      ];
      const done = await togglOk<TogglPatchResult>(c, `/workspaces/${wid}/time_entries/${encodeURIComponent(id)}`, { method: "PATCH", data: ops });
      const refusal = done?.failure?.find((f) => String(f.id) === id) ?? done?.failure?.[0];
      if (refusal) throw patchFailure(refusal.message);
      const changed = toRemoteWorklog({ ...cur, start: rfc3339(start), stop: rfc3339(stop), duration: seconds, description, billable: w.billable ?? cur.billable, at: new Date().toISOString() });
      if (!changed) throw new ProviderError("incompatible", "Toggl: a changed time entry that is not a span");
      return changed;
    },

    async delete(x, id) {
      // Deleting what is already gone is a success.
      await toggl<unknown>(await credsOf(x), `/workspaces/${x.conn.options.workspaceId}/time_entries/${encodeURIComponent(id)}`, { method: "DELETE", missingIsNull: true });
    },
  },
};

/** A session in whole seconds (the form the core already holds input to; checked again for the API's sake). */
function span(w: WorklogInput): { start: number; seconds: number } {
  if (w.time.kind !== "session") throw new ProviderError("invalid", "Toggl keeps sessions: a start and a duration");
  if (!Number.isInteger(w.time.seconds) || w.time.seconds <= 0) throw new ProviderError("invalid", `Toggl: not a duration: ${w.time.seconds}`);
  return { start: Math.floor(w.time.start / 1000) * 1000, seconds: w.time.seconds };
}
