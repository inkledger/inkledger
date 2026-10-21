// Harvest as a time sink, through the provider contract: it only receives
// time. An entry is filed under a project and a task the user is assigned to
// (found by searching their project assignments), points back at its issue
// with Harvest's external_reference and always carries "[KEY] title" first in
// its notes. Harvest keeps a date and decimal hours (no start unless the
// account uses timestamps); the start inkledger sends is reduced to what Harvest
// keeps, and what comes back is read as a session at the entry's start of day
// when Harvest has no time of day. Locked, approved and invoiced entries are
// not editable. Built on a simulator, not verified on a real account:
// api/providers/harvest/SPIKES.md.
import { z } from "zod";
import type { TimeSinkCapabilities, TimeSinkTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, localDateOf, type Instant, type LocalDate, type TimeZone } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type { CallContext, ExternalRef, IssueHandle, Limited, RemotePerson, RemoteWorklog, SinkTarget, TimeSinkProvider, WorklogInput } from "../types";
import { hv, hvOk, hvPage, hvPages, type HarvestCompany, type HarvestCreds, type HarvestExternalReference, type HarvestProjectAssignment, type HarvestTimeEntry, type HarvestUser } from "./client";

const DAY_MS = 86_400_000;
/** The feed window the capabilities declare: entries changed in the last 7 days, a pass overlapping its checkpoint by an hour. */
const LOOKBACK_MS = 7 * DAY_MS;
const OVERLAP_MS = 3_600_000;

// The catalogue's entry for harvest, here where the adapter keeps to it (the
// registry holds the two together).
export const harvestSinkCapabilities: TimeSinkCapabilities = {
  // Updated in place (PATCH), deleted; the feed is updated_since, read as a window. Billable is read, not
  // written (it follows the task assignment); approvals are Timesheet Approval; no idempotency key exists.
  entries: {
    model: "entries",
    shape: "session",
    write: { mode: "entry", update: "native", delete: true },
    feed: { kind: "window", by: "updatedAt", lookbackMs: LOOKBACK_MS, overlapMs: OVERLAP_MS },
    reconcile: { kind: "period" },
    billable: { read: true, write: false },
    activities: { read: false, write: false, required: "no" },
    onBehalf: { read: false, write: false },
    approvals: { read: true },
    idempotency: "local",
    concurrency: "none",
    limits: {},
  },
  references: ["external", "projectTask", "description"],
  target: { use: "required", lookup: "search" },
};

export const harvestSinkTraits: TimeSinkTraits = { invoices: true, rates: true };

const optionsSchema = z.strictObject({
  /** The Harvest account the token is used on (shown in Harvest's developer page beside the token) */
  accountId: z.coerce.string().regex(/^\d{1,12}$/, "the Harvest account id is a number"),
});
export type HarvestOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"harvest", HarvestOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
type FeedPage = { page: number; since: string; at: number };

async function credsOf(x: X): Promise<HarvestCreds> {
  const cred = await x.conn.credential();
  const token = cred.kind === "token" ? cred.token : cred.kind === "oauth" ? cred.accessToken : cred.password;
  return { apiBase: x.conn.baseUrl, token, accountId: x.conn.options.accountId };
}

// ---------- Time of day, in the user's zone ----------

/** Wall-clock minutes of the day an instant falls on in a zone. */
function minutesOfDay(at: Instant, zone: TimeZone): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(ms: number, zone: TimeZone): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time (minutes into the day) is, on a date, in a zone. */
function wallToInstant(date: LocalDate, minutes: number, zone: TimeZone): Instant {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  const first = naive - offsetAt(naive, zone);
  return instant(naive - offsetAt(first, zone));
}

/** "8:30am", as Harvest writes a time of day. */
function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}:${String(minutes % 60).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/** Minutes into the day of "8:30am" (or "20:30"), null when unreadable. */
function parseClock(text: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([ap]m)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  return h * 60 + Number(m[2]);
}

// ---------- What an entry says ----------

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** The first thing in the notes, whatever else is written: which issue this is. */
const noteHeader = (ref: ExternalRef) => `[${ref.issue.key}] ${oneLine(ref.snapshot.title)}`;
const HEADER = /^\[([^\]\n]{1,100})\] [^\n]*(?:\n\n|\n|$)/;

const notesOf = (header: string, comment: string) => (comment.trim() ? `${header}\n\n${comment.trim()}` : header);

/** Harvest's external_reference for an issue: the issue's id, its project, the tracker connection, a link. */
function externalOf(ref: ExternalRef): HarvestExternalReference {
  return {
    id: ref.issue.remoteId,
    ...(ref.issue.container ? { group_id: ref.issue.container.remoteId } : {}),
    account_id: `${ref.trackerType}:${ref.trackerConnectionId}`,
    ...(ref.snapshot.url ? { permalink: ref.snapshot.url } : {}),
  };
}

const TARGET = /^(\d+):(\d+)$/;

/** project:task, as the target's id keeps both. */
function targetIds(target: SinkTarget | null): { project_id: number; task_id: number } {
  if (!target) throw new ProviderError("invalid", "Harvest files an entry under a project and a task");
  const m = TARGET.exec(target.remoteId);
  if (!m) throw new ProviderError("invalid", `Harvest: not a project and task: ${target.remoteId}`);
  return { project_id: Number(m[1]), task_id: Number(m[2]) };
}

/**
 * The time of an entry as Harvest takes it. A duration account keeps the day
 * and decimal hours: 0.01 h is 36 s, so what is sent is rounded to it (the
 * entry then reads back as what Harvest holds). A timestamp account keeps a
 * start and an end to the minute, within one day.
 */
function timeFields(w: WorklogInput, zone: TimeZone, timestamps: boolean): Record<string, string | number> {
  if (w.time.kind !== "session") throw new ProviderError("invalid", "Harvest keeps sessions");
  const { start, seconds } = w.time;
  const spent_date = localDateOf(start, zone);
  if (!timestamps) {
    const hours = Math.round(seconds / 36) / 100;
    if (hours <= 0) throw new ProviderError("invalid", `${seconds}s rounds to nothing in Harvest (hours keep two decimals)`);
    if (hours > 24) throw new ProviderError("invalid", "Harvest takes at most 24 hours in an entry");
    return { spent_date, hours };
  }
  const from = minutesOfDay(start, zone);
  const length = Math.round(seconds / 60);
  if (length < 1) throw new ProviderError("invalid", `${seconds}s rounds to nothing in Harvest (times keep minutes)`);
  if (from + length >= 24 * 60) throw new ProviderError("invalid", "Harvest cannot keep an entry across midnight");
  return { spent_date, started_time: clock(from), ended_time: clock(from + length) };
}

async function timestampsOf(c: HarvestCreds): Promise<boolean> {
  return (await hvOk<HarvestCompany>(c, "/company")).wants_timestamp_timers;
}

// ---------- Entries as read ----------

function lockOf(e: HarvestTimeEntry): RemoteWorklog["locked"] {
  const message = e.locked_reason ?? undefined;
  if (e.is_billed) return { cause: "invoiced", ...(message ? { message } : {}) };
  if (e.is_closed) return { cause: "approved", ...(message ? { message } : {}) };
  if (e.is_locked) return { cause: /approv/i.test(message ?? "") ? "approved" : "other", ...(message ? { message } : {}) };
  return null;
}

/** The issue an entry points at: its external reference, else the key its notes start with. */
function issueOf(e: HarvestTimeEntry): IssueHandle | null {
  const key = HEADER.exec(e.notes ?? "")?.[1];
  const id = e.external_reference?.id;
  if (id) return { remoteId: id, ...(key ? { key } : {}) };
  return key ? { key } : null;
}

function toRemoteWorklog(e: HarvestTimeEntry, zone: TimeZone): RemoteWorklog {
  const date = localDate(e.spent_date);
  const at = e.started_time ? parseClock(e.started_time) : null;
  const locked = lockOf(e);
  const notes = e.notes ?? "";
  return {
    remoteId: String(e.id),
    issue: issueOf(e),
    span: { kind: "session", start: wallToInstant(date, at ?? 0, zone), seconds: Math.round(e.hours * 3600) },
    comment: notes.replace(HEADER, "").trim(),
    authorRemoteId: String(e.user.id),
    createdAt: instantFrom(e.created_at),
    updatedAt: instantFrom(e.updated_at),
    billable: e.billable,
    approval: e.is_closed ? "approved" : "none",
    version: null,
    ...(locked ? { locked } : {}),
    // A running timer is still counting: not for inkledger to change.
    editable: locked || e.is_running ? { update: false, delete: false } : { update: true, delete: true },
  };
}

const personOf = (u: HarvestUser): RemotePerson & { email?: string } => ({
  remoteId: String(u.id),
  name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || String(u.id),
  ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
  ...(u.email ? { email: u.email } : {}),
});

export const harvestSink: TimeSinkProvider<"harvest", HarvestOptions> = {
  role: "timeSink",
  type: "harvest",
  capabilities: harvestSinkCapabilities,
  traits: harvestSinkTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Harvest options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  async verify(x) {
    const me = await hvOk<HarvestUser>(await credsOf(x), "/users/me");
    // A deactivated user can sign in but no longer track time.
    if (me.is_active === false) throw new ProviderError("forbidden", "Harvest: this user is no longer active on the account");
    return personOf(me);
  },

  async probe(x) {
    const c = await credsOf(x);
    // The account answers for this token (and says how it keeps time).
    await hvOk<HarvestCompany>(c, "/company");
    // Published: 100 requests per 15 seconds.
    return { capabilities: harvestSinkCapabilities, rateLimit: { perHour: 24_000, origin: "typical" }, verifiedAt: instant(Date.now()) };
  },

  async targets(x, query, limit): Promise<Limited<SinkTarget>> {
    const c = await credsOf(x);
    const assignments = await hvPages<HarvestProjectAssignment>(c, "/users/me/project_assignments", "project_assignments");
    const q = query.trim().toLowerCase();
    const found: SinkTarget[] = [];
    for (const pa of assignments) {
      if (!pa.is_active) continue;
      const where = [pa.client?.name, pa.project.name].filter(Boolean).join(" / ");
      for (const ta of pa.task_assignments) {
        if (!ta.is_active) continue;
        const text = [pa.client?.name, pa.project.name, pa.project.code, ta.task.name].filter(Boolean).join(" ").toLowerCase();
        if (q && !text.includes(q)) continue;
        found.push({ remoteId: `${pa.project.id}:${ta.task.id}`, name: ta.task.name, path: [{ remoteId: String(pa.project.id), name: where }] });
      }
    }
    return { items: found.slice(0, limit), complete: found.length <= limit };
  },

  entries: {
    async list(x, range) {
      const c = await credsOf(x);
      // The user's own (an admin's list holds everyone's), by spent date, not running.
      const rows = await hvPages<HarvestTimeEntry>(c, "/time_entries", "time_entries", { user_id: x.conn.remoteAccountId, from: range.from, to: range.to, is_running: "false" });
      return rows.filter((e) => !e.is_running).map((e) => toRemoteWorklog(e, x.conn.timeZone));
    },

    async changed(x, q) {
      const c = await credsOf(x);
      decodeCheckpoint<Since>(x.conn, "entries", V, q.since);
      const start =
        decodePageToken<FeedPage>(x.conn, "entries", V, q.since, q.page) ??
        ((now: number): FeedPage => {
          // From the checkpoint less the overlap, never further back than the window.
          const cp = decodeCheckpoint<Since>(x.conn, "entries", V, q.since);
          const from = cp ? Math.max(cp.at - OVERLAP_MS, now - LOOKBACK_MS) : now - LOOKBACK_MS;
          return { page: 1, since: new Date(from).toISOString(), at: now };
        })(Date.now());
      const r = await hvPage<HarvestTimeEntry>(c, "/time_entries", "time_entries", start.page, { user_id: x.conn.remoteAccountId, updated_since: start.since, is_running: "false" });
      const items = r.items.filter((e) => !e.is_running).map((e) => toRemoteWorklog(e, x.conn.timeZone));
      if (r.next !== null) return { last: false, items, gone: [], next: encodePageToken(x.conn, "entries", V, q.since, { ...start, page: r.next } satisfies FeedPage) };
      return { last: true, items, gone: [], checkpoint: encodeCheckpoint(x.conn, "entries", V, { at: start.at } satisfies Since) };
    },

    async create(x, ref, target, w) {
      const c = await credsOf(x);
      const body = {
        ...targetIds(target),
        ...timeFields(w, x.conn.timeZone, await timestampsOf(c)),
        notes: notesOf(noteHeader(ref), w.comment),
        external_reference: externalOf(ref),
      };
      // No idempotency key exists: a retry after a timeout may land twice (the engine writes one entry at a time and reconciles).
      return toRemoteWorklog(await hvOk<HarvestTimeEntry>(c, "/time_entries", { method: "POST", body: JSON.stringify(body) }), x.conn.timeZone);
    },

    async update(x, id, w) {
      const c = await credsOf(x);
      const cur = await hvOk<HarvestTimeEntry>(c, `/time_entries/${encodeURIComponent(id)}`);
      // The header naming the issue stays; only what follows it is the comment.
      const header = HEADER.exec(cur.notes ?? "")?.[0].trim() ?? "";
      const notes = header ? notesOf(header, w.comment) : w.comment.trim();
      const body = { ...timeFields(w, x.conn.timeZone, await timestampsOf(c)), notes };
      return toRemoteWorklog(await hvOk<HarvestTimeEntry>(c, `/time_entries/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }), x.conn.timeZone);
    },

    async delete(x, id) {
      // Already gone is a success.
      await hv<undefined>(await credsOf(x), `/time_entries/${encodeURIComponent(id)}`, { method: "DELETE", missingIsNull: true });
    },
  },
};
