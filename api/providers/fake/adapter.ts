// Services in memory, for tests. The tracker has a direct workflow over the
// six categories, time entries, comments, reads in small pages so paging is
// exercised, and hooks for what happens on the service outside inkledger (a move
// with a new id) and for an adapter that breaks the contract (to prove the
// binding catches it). The time sink keeps date entries pointing back at
// their issue, filed under a project/task.
import type { StatusCategory, TimeSinkCapabilities, TimeSinkTraits, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, localDate } from "@contracts/values";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import type {
  CallContext,
  IssueRef,
  PageToken,
  RemoteComment,
  RemoteIssue,
  RemoteStatus,
  RemoteWorklog,
  ReportedEntryGone,
  ReportedIssueGone,
  SinkTarget,
  Stream,
  TimeSinkProvider,
  TrackerProvider,
} from "../types";

const status = (id: string, name: string, category: StatusCategory, order: number): RemoteStatus => ({
  id,
  name,
  category,
  categoryOrigin: { by: "native" },
  source: { kind: "itemState" },
  order,
});
const STATUSES = [
  status("backlog", "Backlog", "backlog", 0),
  status("todo", "To do", "todo", 1),
  status("doing", "Doing", "doing", 2),
  status("done", "Done", "done", 3),
  status("dropped", "Dropped", "cancelled", 4),
];

export type FakeOptions = { region: string };

export function fakeTrackerCapabilities(o: { entryUpdate?: boolean; comments?: boolean } = {}): TrackerCapabilities {
  return {
    workflow: { sources: [{ kind: "itemState", transitions: "direct" }] },
    transitions: { read: true, write: true },
    statuses: true,
    searchText: true,
    query: null,
    comments: o.comments === false ? { mode: "none" } : { mode: "readWrite", formats: ["commonmark"], writePreserves: ["paragraph", "emphasis", "strong", "code", "link", "list"], idempotency: "native" },
    description: true,
    containers: true,
    manage: { assign: false, labels: false, create: false, edit: false, types: false },
    watch: false,
    inbox: false,
    otherFields: false,
    history: false,
    statusHistory: false,
    time: {
      mode: "entries",
      entries: {
        model: "entries",
        shape: "session",
        write: { mode: "entry", update: o.entryUpdate === false ? "recreate" : "native", delete: true },
        feed: { kind: "incremental", removals: true },
        reconcile: { kind: "period", maxDays: 31 },
        billable: { read: false, write: false },
        activities: { read: false, write: false, required: "no" },
        onBehalf: { read: false, write: false },
        approvals: { read: false },
        idempotency: "native",
        concurrency: "revision",
        limits: { maxSeconds: 24 * 3600 },
      },
    },
    sync: { issueCheckpoints: true, gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "withSuccessor" }, webhooks: null },
  };
}

export const fakeTrackerTraits: TrackerTraits = { create: false, inbox: false, relations: false, devLinks: false, attachments: { read: false, upload: false }, timeboxes: [], fields: ["labels"] };

const V = 1;
type Stamped<T> = T & { at: number };
const unstamp = <T,>(stamped: Stamped<T>): T => {
  const copy: Partial<Stamped<T>> = { ...stamped };
  delete copy.at;
  return copy as T;
};

/** Ascending change time, ties broken by id: a pass reads the same way twice. */
const ordered = <T extends { at: number }>(xs: T[], idOf: (x: T) => string) => [...xs].sort((a, b) => a.at - b.at || idOf(a).localeCompare(idOf(b)));

type Misbehave = "gonePastCapabilities" | "editableWhenLocked" | "probeWidens" | "checkpointMidPass";

/** A fresh fake tracker: its own data, seeded with the given issues. */
export function fakeTracker(
  seed: { key: string; title: string; category?: StatusCategory; remoteId?: string }[] = [],
  o: { pageSize?: number; entryUpdate?: boolean; comments?: boolean; misbehave?: Misbehave } = {},
) {
  let clock = 1_000;
  let seq = 0;
  const pageSize = o.pageSize ?? 2;
  const capabilities = fakeTrackerCapabilities(o);
  const issues = new Map<string, Stamped<RemoteIssue>>();
  const worklogs = new Map<string, Stamped<RemoteWorklog> & { version: string; key?: string }>();
  const goneIssues: Stamped<ReportedIssueGone>[] = [];
  const goneWorklogs: Stamped<ReportedEntryGone>[] = [];
  const comments = new Map<string, RemoteComment[]>();
  const keys = new Map<string, string>();
  const statusOf = (c: StatusCategory = "todo") => STATUSES.find((s) => s.category === c) ?? STATUSES[1];
  for (const s of seed) {
    const at = ++clock;
    const project = s.key.split("-")[0];
    issues.set(s.key, {
      remoteId: s.remoteId ?? `r-${++seq}`,
      key: s.key,
      url: `https://fake.example/items/${s.key}`,
      title: s.title,
      type: { id: "task", name: "Task" },
      status: statusOf(s.category),
      container: { remoteId: `p-${project}`, key: project, name: "Fake project", kind: "project" },
      labels: [],
      assignees: [],
      updatedAt: instant(at),
      at,
    });
  }
  // Every operation finds an issue by its id: a stale key never matters.
  const byRemote = (remoteId: string) => [...issues.values()].find((i) => i.remoteId === remoteId);
  const must = (ref: IssueRef) => byRemote(ref.remoteId) ?? (() => { throw new ProviderError("notFound", `fake: no issue ${ref.remoteId}`); })();
  const sinceOf = (x: CallContext, stream: Stream, cp: Parameters<typeof decodeCheckpoint>[3]) => decodeCheckpoint<{ at: number }>(x.conn, stream, V, cp)?.at ?? 0;

  /** One page of a pass over stamped items: removals and the checkpoint only with the last. */
  function pass<T, G>(x: CallContext, stream: Stream, all: Stamped<T>[], gone: Stamped<G>[], idOf: (t: Stamped<T>) => string, q: { since: Parameters<typeof decodeCheckpoint>[3]; page: PageToken | null }) {
    const since = sinceOf(x, stream, q.since);
    const from = decodePageToken<{ from: number }>(x.conn, stream, V, q.since, q.page)?.from ?? 0;
    const changed = ordered(all.filter((i) => i.at > since), idOf);
    const slice = changed.slice(from, from + pageSize).map((i) => unstamp<T>(i));
    if (from + pageSize < changed.length) {
      return { last: false as const, items: slice, gone: [], next: encodePageToken(x.conn, stream, V, q.since, { from: from + pageSize }) };
    }
    return {
      last: true as const,
      items: slice,
      gone: gone.filter((g) => g.at > since).map((g) => unstamp<G>(g)),
      checkpoint: encodeCheckpoint(x.conn, stream, V, { at: clock }),
    };
  }

  const worklogOut = (w: Stamped<RemoteWorklog> & { version: string }): RemoteWorklog => {
    const out = unstamp<RemoteWorklog & { version: string }>(w);
    if (o.misbehave === "editableWhenLocked") return { ...out, locked: { cause: "approved" }, editable: { update: true, delete: true } };
    return out;
  };

  const tracker: TrackerProvider<"jira", FakeOptions> = {
    role: "tracker",
    type: "jira",
    capabilities,
    traits: fakeTrackerTraits,
    parseOptions(raw) {
      const region = (raw as { region?: unknown } | null)?.region;
      if (typeof region !== "string") throw new ProviderError("invalid", "fake: options need a region");
      return { region };
    },
    normalizeKey: (raw) => (/^[A-Z]+-\d+$/.test(raw.trim().toUpperCase()) ? raw.trim().toUpperCase() : null),
    parseRef: (r, text) => {
      const k = tracker.normalizeKey(text);
      if (k) return { key: k };
      const m = text.startsWith(`${r.baseUrl}/items/`) ? tracker.normalizeKey(text.slice(r.baseUrl.length + 7)) : null;
      return m ? { key: m } : null;
    },
    verify: async (x) => ({ remoteId: x.conn.remoteAccountId, name: "Fake user" }),
    probe: async () => ({
      capabilities: o.misbehave === "probeWidens" ? { ...capabilities, watch: true } : capabilities,
      activeSources: [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Fake workflow" }],
      rateLimit: { perSecond: 10, origin: "typical" },
      verifiedAt: instant(clock),
    }),
    listChanged: async (x, q) => {
      const page = pass(x, "issues", [...issues.values()], goneIssues, (i) => i.remoteId, q);
      if (o.misbehave === "gonePastCapabilities" && page.last) return { ...page, gone: [{ remoteId: "r-x", reason: "lostAccess" }] };
      if (o.misbehave === "checkpointMidPass" && !page.last) return { ...page, last: true, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: clock }) };
      return page;
    },
    getIssue: async (_x, ref) => {
      const i = byRemote(ref.remoteId);
      return i ? unstamp<RemoteIssue>(i) : null;
    },
    findIssue: async (_x, handle) => {
      const key = handle.key ?? "";
      const i = handle.remoteId ? byRemote(handle.remoteId) : issues.get((keys.get(key) ?? key).toUpperCase());
      return i ? { kind: "found", issue: unstamp<RemoteIssue>(i) } : { kind: "none" };
    },
    searchText: async (_x, text, limit) => {
      const found = [...issues.values()].filter((i) => i.title.toLowerCase().includes(text.toLowerCase()));
      return { items: found.slice(0, limit).map((i) => unstamp<RemoteIssue>(i)), complete: found.length <= limit };
    },
    containers: async () => {
      const projects = new Set([...issues.values()].map((i) => i.key.split("-")[0]));
      return [...projects].sort().map((project) => ({ remoteId: `p-${project}`, key: project, name: "Fake project", kind: "project" as const }));
    },
    description: async (_x, ref) => {
      const i = byRemote(ref.remoteId);
      return i ? { kind: "text", format: "commonmark", text: `What ${i.key} is about.` } : null;
    },
    statuses: async () => STATUSES,
    transitions: {
      list: async (_x, ref) => {
        const cur = must(ref).status.id;
        return STATUSES.filter((s) => s.id !== cur).map((s) => ({ id: s.id, name: s.name, to: s, requirements: [], remoteUrl: `https://fake.example/items/${ref.key}` }));
      },
      apply: async (_x, ref, id) => {
        const to = STATUSES.find((s) => s.id === id);
        if (!to) throw new ProviderError("invalid", `fake: no status ${id}`);
        const at = ++clock;
        Object.assign(must(ref), { status: to, updatedAt: instant(at), at });
        return unstamp<RemoteIssue>(must(ref));
      },
    },
    worklogs: {
      list: async (_x, ref) => [...worklogs.values()].filter((w) => w.issue?.remoteId === ref.remoteId).map(worklogOut),
      changed: async (x, q) => {
        const page = pass(x, "worklogs", [...worklogs.values()], goneWorklogs, (w) => w.remoteId, q);
        return { ...page, items: page.items.map((w) => worklogOut({ ...(w as RemoteWorklog & { version: string }), at: 0 })) };
      },
      create: async (x, ref, w, m) => {
        const i = must(ref);
        // The same key twice makes one entry (native idempotency).
        const again = [...worklogs.values()].find((e) => e.key === m.idempotencyKey);
        if (again) return worklogOut(again);
        if (w.time.kind !== "session") throw new ProviderError("invalid", "fake keeps sessions");
        const made = { remoteId: `w-${++seq}`, issue: { remoteId: i.remoteId, key: i.key }, span: w.time, comment: w.comment, authorRemoteId: x.conn.remoteAccountId, editable: { update: o.entryUpdate !== false, delete: true }, version: "1", key: m.idempotencyKey, at: ++clock };
        worklogs.set(made.remoteId, made);
        return worklogOut(made);
      },
      ...(o.entryUpdate === false
        ? {}
        : {
            update: async (_x, _ref, id, w, m) => {
              const cur = worklogs.get(id);
              if (!cur) throw new ProviderError("notFound", `fake: no worklog ${id}`);
              if (m.expectedVersion !== cur.version) throw new ProviderError("conflict", "fake: the entry moved on");
              Object.assign(cur, { span: w.time, comment: w.comment, version: String(Number(cur.version) + 1), at: ++clock });
              return worklogOut(cur);
            },
          }),
      delete: async (_x, _ref, id) => {
        // Deleting what is already gone is a success.
        if (!worklogs.delete(id)) return;
        goneWorklogs.push({ remoteId: id, reason: "deleted", at: ++clock });
      },
    },
    ...(o.comments === false
      ? {}
      : {
          comments: {
            list: async (_x: CallContext<"jira", FakeOptions>, ref: IssueRef) => comments.get(ref.remoteId) ?? [],
            add: async (x: CallContext<"jira", FakeOptions>, ref: IssueRef, body: string) => {
              const made: RemoteComment = { id: `c-${++seq}`, author: { remoteId: x.conn.remoteAccountId, name: "Fake user" }, body: { kind: "text", format: "commonmark", text: body }, createdAt: instant(++clock), updatedAt: null };
              comments.set(ref.remoteId, [...(comments.get(ref.remoteId) ?? []), made]);
              return { comment: made, warnings: body.includes("|") ? [{ code: "approximated" as const, feature: "table" as const, serverDetail: "fake: tables flattened" }] : [] };
            },
          },
        }),
  };

  /** What happens on the service outside inkledger. */
  const outside = {
    /** The issue moves to another project and gets a new id (GitLab's move): gone, with a successor. */
    moveWithNewId(key: string, newKey: string) {
      const old = issues.get(key)!;
      issues.delete(key);
      const at = ++clock;
      const moved = { ...old, remoteId: `r-${++seq}`, key: newKey, updatedAt: instant(at), at };
      issues.set(newKey, moved);
      keys.set(key, newKey);
      goneIssues.push({ remoteId: old.remoteId, reason: "transferred", successor: { remoteId: moved.remoteId, key: newKey }, at });
    },
    /** Someone edits the issue's title. */
    edit(key: string, title: string) {
      Object.assign(issues.get(key)!, { title, updatedAt: instant(++clock), at: clock });
    },
    /** The issue changes key, keeping its id (a project move on Jira). */
    rename(key: string, newKey: string) {
      const cur = issues.get(key)!;
      issues.delete(key);
      issues.set(newKey, Object.assign(cur, { key: newKey, url: `https://fake.example/items/${newKey}`, updatedAt: instant(++clock), at: clock }));
      keys.set(key, newKey);
    },
    /** The issue disappears and the service says nothing (reconciliation finds it missing). */
    vanish(key: string) {
      issues.delete(key);
    },
    /** Someone changes an entry on the service: its revision moves on. */
    touchWorklog(id: string) {
      const cur = worklogs.get(id)!;
      Object.assign(cur, { version: String(Number(cur.version) + 1), at: ++clock });
    },
    /** Someone changes the entry on the service: its length, its comment. */
    changeWorklog(id: string, change: { seconds?: number; comment?: string }) {
      const cur = worklogs.get(id)!;
      const span = cur.span.kind === "session" && change.seconds !== undefined ? { ...cur.span, seconds: change.seconds } : cur.span;
      Object.assign(cur, { span, comment: change.comment ?? cur.comment, version: String(Number(cur.version) + 1), at: ++clock });
    },
    /** The entry is approved on the service: it can't be changed any more. */
    lockWorklog(id: string, message = "Approved by the team lead") {
      const cur = worklogs.get(id)!;
      Object.assign(cur, { locked: { cause: "approved", message }, editable: { update: false, delete: false }, version: String(Number(cur.version) + 1), at: ++clock });
    },
  };
  return Object.assign(tracker, { outside });
}

export const fakeSinkCapabilities: TimeSinkCapabilities = {
  entries: {
    model: "entries",
    shape: "date",
    write: { mode: "entry", update: "replace", delete: true },
    feed: { kind: "none" },
    reconcile: { kind: "period", maxDays: 31 },
    billable: { read: true, write: true },
    activities: { read: true, write: true, required: "input" },
    onBehalf: { read: false, write: false },
    approvals: { read: true },
    idempotency: "local",
    concurrency: "none",
    limits: { maxSeconds: 24 * 3600, increment: { seconds: 60, rounding: "nearest" } },
  },
  references: ["external", "projectTask"],
  target: { use: "required", lookup: "search" },
  typicalRateLimit: { perHour: 3600 },
};
export const fakeSinkTraits: TimeSinkTraits = { invoices: true, rates: true };

const ACTIVITIES = [
  { id: "dev", name: "Development" },
  { id: "mtg", name: "Meetings" },
];
const TARGETS: SinkTarget[] = [{ remoteId: "t-1", name: "Build", path: [{ remoteId: "p-1", name: "Client A" }] }];

/** A fresh fake time sink. */
export function fakeSink(): TimeSinkProvider<"harvest", FakeOptions> {
  let seq = 0;
  const entries = new Map<string, RemoteWorklog>();
  return {
    role: "timeSink",
    type: "harvest",
    capabilities: fakeSinkCapabilities,
    traits: fakeSinkTraits,
    parseOptions: (raw) => {
      const region = (raw as { region?: unknown } | null)?.region;
      return { region: typeof region === "string" ? region : "eu" };
    },
    verify: async (x) => ({ remoteId: x.conn.remoteAccountId, name: "Fake sink user" }),
    probe: async () => ({ capabilities: fakeSinkCapabilities, rateLimit: { perHour: 3600, origin: "typical" }, verifiedAt: instant(1) }),
    targets: async (_x, query, limit) => {
      const found = TARGETS.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()));
      return { items: found.slice(0, limit), complete: found.length <= limit };
    },
    entries: {
      list: async (_x, range) => [...entries.values()].filter((e) => e.span.kind === "date" && e.span.date >= range.from && e.span.date <= range.to),
      create: async (x, ref, target, w) => {
        if (!target) throw new ProviderError("invalid", "fake sink: entries are filed under a task");
        if (w.time.kind !== "date") throw new ProviderError("invalid", "fake sink keeps dates");
        if (!w.activityId) throw new ProviderError("invalid", "fake sink: an activity is required");
        const activity = ACTIVITIES.find((a) => a.id === w.activityId) ?? null;
        const made: RemoteWorklog = { remoteId: `e-${++seq}`, issue: ref.issue, span: { kind: "date", date: localDate(w.time.date), seconds: w.time.seconds }, comment: w.comment, authorRemoteId: x.conn.remoteAccountId, billable: w.billable ?? true, activity, approval: "none", editable: { update: true, delete: true } };
        entries.set(made.remoteId, made);
        return made;
      },
      update: async (_x, id, w) => {
        const cur = entries.get(id);
        if (!cur) throw new ProviderError("notFound", `fake sink: no entry ${id}`);
        if (w.time.kind !== "date") throw new ProviderError("invalid", "fake sink keeps dates");
        Object.assign(cur, { span: { kind: "date", date: w.time.date, seconds: w.time.seconds }, comment: w.comment });
        return cur;
      },
      delete: async (_x, id) => {
        entries.delete(id);
      },
      activities: async (_x, _scope, limit) => ({ items: ACTIVITIES.slice(0, limit), complete: ACTIVITIES.length <= limit }),
    },
  };
}
