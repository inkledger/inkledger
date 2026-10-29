// Clockify as a time sink, through the provider contract. Time only: each
// worklog of the user becomes a finished time entry (start and end instants,
// to the second), under a project or task when one is mapped, the issue named
// in the note as "[KEY] title" on its first line. There is no change feed:
// entries are read by period (start/end) to reconcile. An entry is replaced
// whole on update (PUT), so the project, task, billable flag and tags are
// read first and sent again. Running timers are not entries of ours and are
// left alone. Built on a simulator, not verified on a real account: SPIKES.md.
import { z } from "zod";
import type { EntryCapabilities, TimeSinkCapabilities, TimeSinkTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, type LocalDate, type TimeZone } from "@contracts/values";
import { secretOf } from "../core/context";
import { ProviderError } from "../core/errors";
import type { ApprovalState, CallContext, ExternalRef, Limited, RemoteWorklog, SinkTarget, TimeSinkProvider, WorklogInput } from "../types";
import {
  cf,
  cfOk,
  cfPages,
  type ClockifyApproval,
  type ClockifyCreds,
  type ClockifyEntry,
  type ClockifyProject,
  type ClockifyTask,
  type ClockifyUser,
  type ClockifyWorkspace,
} from "./client";

const optionsSchema = z.object({
  /** The workspace entries go to; absent: the user's active one, as Clockify names it */
  workspaceId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/, "a Clockify workspace id is 24 hex characters")
    .optional(),
});
export type ClockifyOptions = z.infer<typeof optionsSchema>;

// Exactly the catalogue's entry (registry test): sessions, native update, delete, no feed,
// billable and on-behalf read and written, approvals read, no key honoured by the service.
const clockifyEntries: EntryCapabilities = {
  model: "entries",
  shape: "session",
  write: { mode: "entry", update: "native", delete: true },
  feed: { kind: "none" },
  reconcile: { kind: "period" },
  billable: { read: true, write: true },
  activities: { read: false, write: false, required: "no" },
  onBehalf: { read: true, write: true },
  approvals: { read: true },
  idempotency: "local",
  concurrency: "none",
  limits: {},
};

export const clockifySinkCapabilities: TimeSinkCapabilities = {
  entries: clockifyEntries,
  references: ["projectTask", "description"],
  target: { use: "optional", lookup: "search" },
  // Published budget and its scope (verify: clockify-rate-limit): none declared until then
};
export const clockifySinkTraits: TimeSinkTraits = { invoices: true, rates: true };

type X = CallContext<"clockify", ClockifyOptions>;

async function credsOf(x: X): Promise<ClockifyCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

/** The workspace of a connection: its option, else the user's active one (read once per connection). */
const workspaces = new WeakMap<object, Promise<string>>();
function workspaceOf(x: X, c: ClockifyCreds): Promise<string> {
  const known = workspaces.get(x.conn);
  if (known) return known;
  const found = x.conn.options.workspaceId
    ? Promise.resolve(x.conn.options.workspaceId)
    : cfOk<ClockifyUser>(c, "/user").then((u) => {
        const id = u.activeWorkspace ?? u.defaultWorkspace;
        if (!id) throw new ProviderError("invalid", "Clockify: the user has no active workspace; set one in the connection");
        return id;
      });
  workspaces.set(x.conn, found);
  found.catch(() => workspaces.delete(x.conn));
  return found;
}

// ---------- Time ----------

/** Clockify prints and takes instants to the second ("2026-10-14T08:30:00Z"), never with milliseconds. */
const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The offset of a zone at an instant, in ms (east positive). */
function zoneOffset(ms: number, zone: TimeZone): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(ms / 1000) * 1000;
}

/** The instant a local day starts in a zone (a day may be 23 or 25 hours long). */
export function dayStart(date: LocalDate, zone: TimeZone): number {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}

const nextDay = (date: LocalDate): LocalDate => {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10));
};

// ---------- The note ----------

const HEADER = /^\[([^\]\n]+)\] (.*)$/;
/** Clockify cuts a description at 3000 characters (an entry over it is refused). */
export const MAX_DESCRIPTION = 3000;
const MAX_HEADER = 300;

/** The first line names the issue; what the user wrote follows. */
export function noteOf(head: string, comment: string): string {
  const h = head.slice(0, MAX_HEADER);
  return comment ? `${h}\n${comment.slice(0, MAX_DESCRIPTION - h.length - 1)}` : h;
}
const headOf = (ref: ExternalRef) => `[${ref.issue.key}] ${ref.snapshot.title}`.replace(/\s+/g, " ").trim();

/** The note split back: the issue key its first line names (if it is ours) and the comment. */
function splitNote(description: string | null | undefined): { head: string | null; key: string | null; comment: string } {
  const text = description ?? "";
  const [first, ...rest] = text.split("\n");
  const m = HEADER.exec(first);
  return m ? { head: first, key: m[1], comment: rest.join("\n") } : { head: null, key: null, comment: text };
}

// ---------- Entries ----------

type Known = { state?: ApprovalState };

function worklogOf(e: ClockifyEntry, issue: RemoteWorklog["issue"], approvals: Map<string, Known> | null): RemoteWorklog | null {
  const start = instantFrom(e.timeInterval.start);
  const end = instantFrom(e.timeInterval.end);
  // A timer still running has no length yet: not an entry to file or reconcile.
  if (start === null || end === null) return null;
  const note = splitNote(e.description);
  const locked = e.isLocked === true;
  const approval = locked ? approvals?.get(e.id)?.state : undefined;
  return {
    remoteId: e.id,
    issue: issue ?? (note.key ? { key: note.key } : null),
    span: { kind: "session", start, seconds: Math.round((end - start) / 1000) },
    comment: note.comment,
    authorRemoteId: e.userId,
    billable: e.billable ?? null,
    ...(approval ? { approval } : {}),
    ...(locked ? { locked: { cause: approval === "approved" ? ("approved" as const) : approval === "submitted" ? ("submitted" as const) : ("periodClosed" as const), message: "Locked in Clockify" } } : {}),
    editable: { update: !locked, delete: !locked },
  };
}

const APPROVAL_OF: Record<string, ApprovalState> = { PENDING: "submitted", APPROVED: "approved", REJECTED: "rejected" };

/** Which of the entries sit in a submitted or approved timesheet (best effort: the list is for managers, a plain user gets a 403). */
async function approvalsFor(c: ClockifyCreds, ws: string, userId: string, entries: ClockifyEntry[]): Promise<Map<string, Known> | null> {
  if (!entries.some((e) => e.isLocked === true)) return null;
  let requests: ClockifyApproval[];
  try {
    requests = await cfPages<ClockifyApproval>(c, `/workspaces/${ws}/approval-requests`);
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === "forbidden" || e.kind === "notFound")) return null;
    throw e;
  }
  const mine = requests.filter((r) => r.owner?.userId === userId && r.dateRange);
  const out = new Map<string, Known>();
  for (const e of entries) {
    const at = instantFrom(e.timeInterval.start);
    const hit = mine.find((r) => at !== null && at >= (instantFrom(r.dateRange!.start) ?? Infinity) && at <= (instantFrom(r.dateRange!.end) ?? -Infinity));
    const state = hit?.status?.state ? APPROVAL_OF[hit.status.state] : undefined;
    if (state) out.set(e.id, { state });
  }
  return out;
}

/** What an entry is filed under: a task (with its project) or a project. */
function placement(target: SinkTarget | null): { projectId?: string; taskId?: string } {
  if (!target) return {};
  const project = target.path.at(-1);
  return project ? { projectId: project.remoteId, taskId: target.remoteId } : { projectId: target.remoteId };
}

function sessionOf(w: WorklogInput): { start: string; end: string } {
  if (w.time.kind !== "session") throw new ProviderError("invalid", "Clockify keeps sessions, not days");
  const start = Math.floor(w.time.start / 1000) * 1000;
  return { start: isoOf(start), end: isoOf(start + w.time.seconds * 1000) };
}

const person = (u: ClockifyUser) => ({ remoteId: u.id, name: u.name ?? u.email ?? u.id, ...(u.profilePicture ? { avatarUrl: u.profilePicture } : {}) });

// ---------- Targets ----------

/** How many matching projects have their tasks looked into (one request each). */
const TASK_PROJECTS = 5;

async function findTargets(x: X, query: string, limit: number): Promise<Limited<SinkTarget>> {
  const c = await credsOf(x);
  const ws = await workspaceOf(x, c);
  const projects = await cfOk<ClockifyProject[]>(c, `/workspaces/${ws}/projects?${new URLSearchParams({ name: query, archived: "false", page: "1", "page-size": String(limit + 1) }).toString()}`);
  const items: SinkTarget[] = projects.filter((p) => !p.archived).map((p) => ({ remoteId: p.id, name: p.name, path: [] }));
  let complete = projects.length <= limit;
  // The tasks of the projects that matched (the API cannot search tasks across projects).
  for (const p of projects.slice(0, Math.min(limit, TASK_PROJECTS))) {
    const tasks = await cfOk<ClockifyTask[]>(c, `/workspaces/${ws}/projects/${p.id}/tasks?${new URLSearchParams({ "is-active": "true", page: "1", "page-size": String(limit + 1) }).toString()}`);
    if (tasks.length > limit) complete = false;
    for (const t of tasks.filter((t) => t.status !== "DONE")) items.push({ remoteId: t.id, name: t.name, path: [{ remoteId: p.id, name: p.name }] });
  }
  if (projects.length > TASK_PROJECTS) complete = false;
  if (items.length > limit) complete = false;
  return { items: items.slice(0, limit), complete };
}

// ---------- The provider ----------

export const clockifySink: TimeSinkProvider<"clockify", ClockifyOptions> = {
  role: "timeSink",
  type: "clockify",
  capabilities: clockifySinkCapabilities,
  traits: clockifySinkTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Clockify options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  async verify(x) {
    const c = await credsOf(x);
    const me = await cfOk<ClockifyUser>(c, "/user");
    const wanted = x.conn.options.workspaceId;
    if (wanted) {
      const mine = await cfOk<ClockifyWorkspace[]>(c, "/workspaces");
      if (!mine.some((w) => w.id === wanted)) throw new ProviderError("forbidden", "Clockify: the key's user is not in that workspace");
    }
    return { ...person(me), ...(me.email ? { email: me.email } : {}) };
  },

  async probe(x) {
    await cfOk<ClockifyUser>(await credsOf(x), "/user");
    // 50 requests a second per key is Clockify's published budget (not yet declared: clockify-rate-limit).
    return { capabilities: clockifySinkCapabilities, rateLimit: { perSecond: 50, origin: "typical" }, verifiedAt: instant(Date.now()) };
  },

  targets: findTargets,

  entries: {
    async list(x, range) {
      const c = await credsOf(x);
      const ws = await workspaceOf(x, c);
      const zone = x.conn.timeZone;
      // Local days to instants (Clockify's filters are instants, never dates), the last second of the last day.
      const from = isoOf(dayStart(range.from, zone));
      const to = isoOf(dayStart(nextDay(range.to), zone) - 1000);
      const rows = await cfPages<ClockifyEntry>(c, `/workspaces/${ws}/user/${x.conn.remoteAccountId}/time-entries?${new URLSearchParams({ start: from, end: to }).toString()}`);
      const approvals = await approvalsFor(c, ws, x.conn.remoteAccountId, rows);
      return rows.flatMap((e) => worklogOf(e, null, approvals) ?? []);
    },

    async create(x, ref, target, w) {
      const c = await credsOf(x);
      const ws = await workspaceOf(x, c);
      const body = {
        ...sessionOf(w),
        description: noteOf(headOf(ref), w.comment),
        ...(w.billable === undefined ? {} : { billable: w.billable }),
        ...placement(target),
      };
      // No idempotency key exists: the engine's own protects a retry, never this call.
      const path = w.onBehalfOfRemoteId ? `/workspaces/${ws}/user/${w.onBehalfOfRemoteId}/time-entries` : `/workspaces/${ws}/time-entries`;
      const made = await cfOk<ClockifyEntry>(c, path, { method: "POST", body: JSON.stringify(body) });
      const out = worklogOf(made, ref.issue, null);
      if (!out) throw new ProviderError("incompatible", "Clockify: a created entry came back still running");
      return out;
    },

    async update(x, id, w) {
      const c = await credsOf(x);
      const ws = await workspaceOf(x, c);
      const cur = (await cf<ClockifyEntry>(c, `/workspaces/${ws}/time-entries/${id}`, { missingIsNull: true }))?.data;
      if (!cur) throw new ProviderError("notFound", `Clockify: no entry ${id}`);
      if (cur.isLocked) throw new ProviderError("conflict", "Clockify: the entry is locked (approved or in a closed period)");
      const note = splitNote(cur.description);
      // PUT replaces the entry: what the input doesn't say is sent back as it is, or Clockify clears it.
      const body = {
        ...sessionOf(w),
        description: note.head ? noteOf(note.head, w.comment) : w.comment.slice(0, MAX_DESCRIPTION),
        billable: w.billable ?? cur.billable ?? undefined,
        ...(cur.projectId ? { projectId: cur.projectId } : {}),
        ...(cur.taskId ? { taskId: cur.taskId } : {}),
        ...(cur.tagIds ? { tagIds: cur.tagIds } : {}),
      };
      const saved = await cfOk<ClockifyEntry>(c, `/workspaces/${ws}/time-entries/${id}`, { method: "PUT", body: JSON.stringify(body) });
      const out = worklogOf(saved, null, null);
      if (!out) throw new ProviderError("incompatible", "Clockify: a changed entry came back still running");
      return out;
    },

    async delete(x, id) {
      const c = await credsOf(x);
      const ws = await workspaceOf(x, c);
      // Already gone is a success (404).
      await cf<undefined>(c, `/workspaces/${ws}/time-entries/${id}`, { method: "DELETE", missingIsNull: true });
    },
  },
};
