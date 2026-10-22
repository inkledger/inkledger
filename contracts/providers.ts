// The words every service is described with, shared by server and app. A
// provider is a kind of service; a connection is one account on one. Two
// roles: trackers (issues and their workflow, maybe time) and time sinks
// (only receive time: Tempo, Harvest…).
//
// Four things are said about a provider, never mixed:
// - capabilities: what the provider layer can *do* with it. Each one is an
//   operation of the contract (api/providers/types.ts), checked both ways
//   (api/providers/core/validate.ts).
// - traits: what the service has that the layer doesn't operate yet: the
//   service's most, on any plan. Descriptive only: they never enable
//   anything in the app.
// - build status: whether an adapter exists (the product's state).
// - effective capabilities: what one connection can do (plan, permissions,
//   configuration): the same schemas, never more than the provider's
//   (core/validate.ts, `narrows`).
// Schema first for everything that crosses a boundary as data (capabilities,
// traits, connection summaries, probes kept in a cache, values sent or
// stored): types derive from the schemas, the same schemas check values at
// runtime, and objects are strict (an unknown property is an error, not
// silently dropped). Interfaces made of functions (the adapters) are plain
// TypeScript, held by core/validate.ts instead.
import { z } from "zod";
import { instantSchema, uniqueArray } from "./values";

/** Issue trackers the provider layer knows (api/providers/CATALOG.md). */
export const TRACKER_TYPES = [
  "jira",
  "github",
  "gitlab",
  "azure",
  "gitea",
  "linear",
  "youtrack",
  "shortcut",
  "plane",
  "openproject",
  "redmine",
  "trello",
  "asana",
  "clickup",
  "monday",
  "notion",
  "wrike",
  "basecamp",
  "todoist",
  "planner",
] as const;
export type TrackerType = (typeof TRACKER_TYPES)[number];

/** Time trackers that receive logged time (attached to a tracker connection). */
export const TIME_SINK_TYPES = ["tempo", "harvest", "clockify", "toggl", "everhour"] as const;
export type TimeSinkType = (typeof TIME_SINK_TYPES)[number];

/** Every provider type (no type in both lists, none twice: tested). */
export const PROVIDER_TYPES = [...TRACKER_TYPES, ...TIME_SINK_TYPES] as const;
export type ProviderType = TrackerType | TimeSinkType;

/** The role a provider type has, at the type level. */
export type RoleOf<T extends ProviderType> = T extends TrackerType ? "tracker" : "timeSink";

export const isTimeSinkType = (t: ProviderType): t is TimeSinkType => (TIME_SINK_TYPES as readonly ProviderType[]).includes(t);
/** The role of a type (the cast is the type system's limit on conditional returns). */
export const roleOf = <T extends ProviderType>(t: T): RoleOf<T> => (isTimeSinkType(t) ? "timeSink" : "tracker") as RoleOf<T>;

/** Whether an adapter exists (the product's state, not the service's). */
export const BUILD_STATUSES = ["planned", "experimental", "built", "disabled"] as const;
export const buildStatusSchema = z.enum(BUILD_STATUSES);
export type BuildStatus = z.infer<typeof buildStatusSchema>;

// ---------- Workflow ----------

/**
 * Where a status sits in any workflow. Trackers say it natively (Jira's
 * status category, Linear's state type…) or the user's mapping does (Trello
 * lists): never inferred from a status name. "triage" only when a tracker
 * has it.
 */
export const STATUS_CATEGORIES = ["triage", "backlog", "todo", "doing", "done", "cancelled"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/**
 * The kinds of place a tracker can keep an item's workflow, and how an item
 * moves there (a connection's probe names the concrete ones it uses).
 * - itemState: a status on the item, moved along the workflow's transitions
 *   (maybe asking for fields: Jira), to the statuses the server allows now
 *   (allowedList: Redmine, YouTrack, OpenProject, Azure), or straight to any
 *   status of the catalogue (direct: Linear, ClickUp…; the service's own
 *   permissions and validation still apply).
 * - projectField: a field of a project the item is in (GitHub Projects'
 *   Status, monday's status column, Notion's status property).
 * - column: the column it sits in (Trello lists, Asana sections, boards).
 * - labelSet: one label of a scoped set (GitLab `workflow::*`); several or
 *   none is resolved by the connection's mapping (its precedence rules).
 * - boolean: open/closed, the service's reason kept apart (GitHub's
 *   state_reason).
 * Where categories come from is said per status (RemoteStatus.categoryOrigin).
 * A new variant gets its own member, never optional fields.
 */
export const workflowSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("itemState"), transitions: z.enum(["workflow", "allowedList", "direct"]) }),
  z.strictObject({ kind: z.literal("projectField"), transitions: z.literal("direct") }),
  z.strictObject({ kind: z.literal("column"), transitions: z.literal("move") }),
  z.strictObject({ kind: z.literal("labelSet"), transitions: z.literal("direct") }),
  z.strictObject({ kind: z.literal("boolean"), transitions: z.literal("direct"), reasons: z.boolean() }),
]);
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;

// ---------- Texts ----------

/** Text formats as read; structured payloads (ADF, rich text) are their own kind of body. */
export const TEXT_FORMATS = ["jira-wiki", "commonmark", "gfm", "glfm", "html", "textile", "plain"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];
export const STRUCTURED_FORMATS = ["adf", "rich"] as const;
export type StructuredFormat = (typeof STRUCTURED_FORMATS)[number];
export type BodyFormat = TextFormat | StructuredFormat;
const bodyFormatSchema = z.enum([...TEXT_FORMATS, ...STRUCTURED_FORMATS]);

/**
 * CommonMark features. `writePreserves` lists those a service keeps exactly
 * when inkledger writes (write only: reading back may render them its own way).
 * Anything else is converted as well as the adapter can, with a warning on
 * that write. Mentions, task lists, issue references come when the RichText
 * layer operates them.
 */
export const MARKDOWN_FEATURES = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;
export type MarkdownFeature = (typeof MARKDOWN_FEATURES)[number];

/**
 * Comments: none, read only, or read and write. `formats`: what comments may
 * be read in (a service configurable per instance has several; each comment
 * says its own). Writing is always CommonMark, never one of these.
 */
export const commentsSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("read"), formats: uniqueArray(bodyFormatSchema).min(1) }),
  z.strictObject({
    mode: z.literal("readWrite"),
    formats: uniqueArray(bodyFormatSchema).min(1),
    writePreserves: uniqueArray(z.enum(MARKDOWN_FEATURES)),
    /** An idempotency key the service honours on add, or only inkledger's own de-duplication */
    idempotency: z.enum(["native", "local"]),
  }),
]);

// ---------- Time ----------

const readWrite = z.strictObject({ read: z.boolean(), write: z.boolean() }).refine((x) => x.read || !x.write, "written but not read");

/**
 * Defaults a service applies; a connection's probe may report tighter ones.
 * Declared for the catalog and checked against the descriptor (core/validate),
 * not applied to writes: the app holds every entry to its own 24 h
 * (MAX_WORKLOG_SECONDS), no tracker declares a narrower duration, and one that
 * refuses an entry it can't keep (GitLab's noFuture) says so itself. Limits need
 * not be multiples of the increment. Absent: no known limit.
 */
export const limitsSchema = z
  .strictObject({
    maxSeconds: z.number().int().positive().optional(),
    minSeconds: z.number().int().positive().optional(),
    increment: z.strictObject({ seconds: z.number().int().positive(), rounding: z.enum(["up", "nearest", "down"]) }).optional(),
    noFuture: z.boolean().optional(),
    /** How far back an entry may be logged, days (0: only today); closed periods show on entries as locked */
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .refine((l) => l.minSeconds === undefined || l.maxSeconds === undefined || l.minSeconds <= l.maxSeconds, "minSeconds above maxSeconds");
export type EntryLimits = z.infer<typeof limitsSchema>;

/**
 * Changed entries, read through `changed`: since a checkpoint (incremental:
 * removals included or not), or by re-reading a window back from now: by
 * entry day (days, with days of overlap) or by last change (milliseconds,
 * with an overlap, counted on instants: no time zone involved). Or not at all.
 */
const windowByDay = z
  .strictObject({ kind: z.literal("window"), by: z.literal("entryDate"), days: z.number().int().positive(), overlapDays: z.number().int().nonnegative() })
  .refine((w) => w.overlapDays <= w.days, "an overlap longer than its window");
const windowByChange = z
  .strictObject({ kind: z.literal("window"), by: z.literal("updatedAt"), lookbackMs: z.number().int().positive(), overlapMs: z.number().int().nonnegative() })
  .refine((w) => w.overlapMs <= w.lookbackMs, "an overlap longer than its window");
const incremental = z.strictObject({ kind: z.literal("incremental"), removals: z.boolean() });
const noFeed = z.strictObject({ kind: z.literal("none") });

/** Every entry of a period can be read to compare, in spans of at most maxDays (absent: no known limit). */
const reconcileSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("period"), maxDays: z.number().int().positive().optional() }), z.strictObject({ kind: z.literal("none") })]);

/**
 * An activity: not required, required in inkledger's input, or required but given
 * a default by the service (then inkledger may only learn which once the entry
 * comes back, if it can read activities at all).
 */
const activitiesSchema = z
  .strictObject({ read: z.boolean(), write: z.boolean(), required: z.enum(["no", "input", "serviceDefault"]) })
  .refine((a) => a.read || !a.write, "written but not read")
  .refine((a) => a.required !== "input" || a.write, "an activity required in the input must be writable");

const entryOnly = {
  billable: readWrite,
  activities: activitiesSchema,
  /** Entries for other people, by their id on the service */
  onBehalf: readWrite,
};

const shared = {
  reconcile: reconcileSchema,
  /** Approval state of each entry or day total (approving is not the layer's job) */
  approvals: z.strictObject({ read: z.boolean() }),
  /**
   * An idempotency key the service honours (a retried write lands once), or
   * only inkledger's own: de-duplication and one write at a time per entry.
   */
  idempotency: z.enum(["native", "local"]),
  /** A revision on each entry or total, required on changes (conflict when it moved); only where something can be changed */
  concurrency: z.enum(["revision", "none"]),
  limits: limitsSchema,
};

/**
 * Time entries a service keeps, as one of two models:
 * - entries: each entry stands alone, with a start (session) or only a day
 *   (date). Written: created; updated in place (native), by sending the
 *   whole entry again, keeping its identity (replace), or only by deleting
 *   and logging again, its identity changing (recreate: the engine does it
 *   and keeps the link); deleted. A read-only service writes nothing, and no
 *   entry attribute either.
 * - dayTotals: one total per day and issue (Everhour), read by day. Written
 *   by setting the day's total (setDayTotal: a replace, inkledger sends the sum of
 *   its own entries of that day); a total of 0 is how a day is removed.
 */
export const entryCapabilitiesSchema = z.discriminatedUnion("model", [
  z
    .strictObject({
      model: z.literal("entries"),
      shape: z.enum(["session", "date"]),
      write: z.discriminatedUnion("mode", [
        z.strictObject({ mode: z.literal("none") }),
        z.strictObject({ mode: z.literal("entry"), update: z.enum(["native", "replace", "recreate", "none"]), delete: z.boolean() }),
      ]),
      feed: z.union([incremental, windowByDay, windowByChange, noFeed]),
      ...entryOnly,
      ...shared,
    })
    .refine((e) => !(e.write.mode === "entry" && e.write.update === "recreate" && !e.write.delete), "recreating an entry needs deleting it")
    .refine((e) => e.write.mode !== "none" || (!e.billable.write && !e.activities.write && !e.onBehalf.write), "a read-only service writes no entry attribute")
    .refine((e) => e.write.mode !== "none" || e.activities.required !== "input", "a read-only service can't require an activity in the input")
    .refine((e) => e.write.mode !== "none" || e.concurrency === "none", "a revision only matters where something can be changed"),
  z
    .strictObject({
      model: z.literal("dayTotals"),
      write: z.strictObject({ set: z.boolean() }),
      feed: z.union([incremental, windowByDay, noFeed]),
      ...shared,
    })
    .refine((e) => e.write.set || e.concurrency === "none", "a revision only matters where something can be changed"),
]);
export type EntryCapabilities = z.infer<typeof entryCapabilitiesSchema>;

// ---------- Trackers ----------

/** Canonical push events; adapters keep their service's own names. */
export const WEBHOOK_EVENTS = ["issueChanged", "issueRemoved", "commentAdded", "worklogChanged", "worklogRemoved"] as const;

export const trackerCapabilitiesSchema = z.strictObject({
  /**
   * The workflow source kinds this service can have, each once: one behaviour
   * per kind per provider (a service with two would get two kinds). A
   * connection's probe names the concrete ones.
   */
  workflow: z.strictObject({
    sources: z
      .array(workflowSourceSchema)
      .min(1)
      .refine((s) => new Set(s.map((x) => x.kind)).size === s.length, "a source kind declared twice"),
  }),
  /** Reading the ways out of a status (list), and moving an item along one (apply) */
  transitions: readWrite,
  /** The full catalogue of statuses of a source (to choose from with direct and move) */
  statuses: z.boolean(),
  /** Finding issues by text */
  searchText: z.boolean(),
  /** Finding issues with a query in the service's own language */
  query: z.enum(["jql", "wiql", "github", "youtrack"]).nullable(),
  comments: commentsSchema,
  /** Reading an issue's description (its body), in the service's format */
  description: z.boolean(),
  /** Listing the containers (projects, repositories) the account can see, even with no issue yet */
  containers: z.boolean(),
  /** Managing issues from the app: assignees, labels, new issues, title and body */
  manage: z.object({ assign: z.boolean(), labels: z.boolean(), create: z.boolean(), edit: z.boolean(), types: z.boolean() }),
  /** Setting watching on or off (setting it again is a success) */
  watch: z.boolean(),
  /** The service's own inbox (mentions, comments, review requests), read and marked read */
  inbox: z.boolean(),
  /** The fields inkledger doesn't map (custom fields, milestone…), readable as name and value */
  otherFields: z.boolean(),
  /** History from the service (otherwise inkledger keeps what it saw change: not the provider's doing) */
  history: z.boolean(),
  /**
   * Where logged time lives: entries of the service's own; only in inkledger
   * (local), the service maybe showing totals of its own; or a counter inkledger
   * adds to (Azure's Completed Work), inkledger keeping the entries.
   */
  time: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("entries"), entries: entryCapabilitiesSchema }),
    z.strictObject({ mode: z.literal("local"), remoteTotals: z.boolean() }),
    z
      .strictObject({ mode: z.literal("counter"), read: z.boolean(), increment: z.boolean(), decrement: z.boolean(), concurrency: z.enum(["revision", "none"]) })
      .refine((c) => c.read || c.increment || c.decrement, "a counter neither read nor changed")
      .refine((c) => c.concurrency !== "revision" || c.read, "a revision is read before a change"),
  ]),
  sync: z.strictObject({
    /** Issue changes since a checkpoint; without, every issue pass is a full scan and its last page has no checkpoint */
    issueCheckpoints: z.boolean(),
    /**
     * What the service itself says when an issue leaves. "missing" is never
     * here: absent at reconciliation is the engine's finding, not a reason.
     */
    gone: z.strictObject({ deleted: z.boolean(), lostAccess: z.boolean(), movedOut: z.boolean(), transfer: z.enum(["none", "withSuccessor"]) }),
    /** Push events: an accelerator only, never relied on; each event with a full payload or only a signal to read again */
    webhooks: z
      .array(z.strictObject({ event: z.enum(WEBHOOK_EVENTS), payload: z.enum(["full", "signal"]) }))
      .min(1)
      .refine((w) => new Set(w.map((x) => x.event)).size === w.length, "an event declared twice")
      .nullable(),
  }),
});
export type TrackerCapabilities = z.infer<typeof trackerCapabilitiesSchema>;

/** What a tracker has that the layer doesn't operate yet: the service's most, on any plan. Never enables anything. */
export const trackerTraitsSchema = z.strictObject({
  create: z.boolean(),
  inbox: z.boolean(),
  relations: z.boolean(),
  devLinks: z.boolean(),
  attachments: z.strictObject({ read: z.boolean(), upload: z.boolean() }),
  timeboxes: uniqueArray(z.enum(["sprint", "cycle", "iteration", "milestone", "version"])),
  fields: uniqueArray(z.enum(["priority", "due", "start", "estimate", "points", "labels", "multiAssignee", "custom"])),
});
export type TrackerTraits = z.infer<typeof trackerTraitsSchema>;

// ---------- Time sinks ----------

/**
 * How an entry points back at its issue on a time sink:
 * - external: a structured reference the service keeps and finds by (Harvest)
 * - issueId: the tracker's own issue id (Tempo on Jira)
 * - projectTask: a project/task chosen by mapping
 * - description: only words in the description (kept, not resolvable by the service)
 */
export const SINK_REFERENCES = ["external", "issueId", "projectTask", "description"] as const;
export type SinkReference = (typeof SINK_REFERENCES)[number];

/** A call budget, requests per hour and/or per second: at least one, both whole and positive. */
const rateFigureFields = {
  perHour: z.number().int().positive().optional(),
  perSecond: z.number().int().positive().optional(),
};
const hasRateFigure = (r: { perHour?: number; perSecond?: number }) => r.perHour !== undefined || r.perSecond !== undefined;

export const rateFigureSchema = z.strictObject(rateFigureFields).refine(hasRateFigure, "a budget with no figure");

/**
 * A call budget as a connection's probe reports it, with where the figure
 * comes from. The same fields and rule as rateFigureSchema, one strict object
 * (never an intersection of two strict ones: each would refuse the other's
 * properties).
 */
export const rateLimitFigureSchema = z
  .strictObject({ ...rateFigureFields, origin: z.enum(["detected", "configured", "typical"]) })
  .refine(hasRateFigure, "a budget with no figure");
export type RateLimitFigure = z.infer<typeof rateLimitFigureSchema>;

export const timeSinkCapabilitiesSchema = z
  .strictObject({
    entries: entryCapabilitiesSchema,
    /** Supported, best first: the order is behaviour (a reorder is a change) */
    references: z
      .tuple([z.enum(SINK_REFERENCES)])
      .rest(z.enum(SINK_REFERENCES))
      .refine((r) => new Set(r).size === r.length, "a reference strategy declared twice"),
    /** Whether an entry is filed under a project/task, and how one is found: by searching (targets), or typed in by the user */
    target: z.discriminatedUnion("use", [
      z.strictObject({ use: z.literal("none") }),
      z.strictObject({ use: z.enum(["optional", "required"]), lookup: z.enum(["search", "manual"]) }),
    ]),
    /** The usual plan's published call budget (a connection's probe reports what it meets) */
    typicalRateLimit: rateFigureSchema.optional(),
  })
  // A project/task reference needs a target; a target may also be asked for by the service's API with any reference.
  .refine((c) => !c.references.includes("projectTask") || c.target.use !== "none", "a project/task reference needs a target");
export type TimeSinkCapabilities = z.infer<typeof timeSinkCapabilitiesSchema>;

export const timeSinkTraitsSchema = z.strictObject({ invoices: z.boolean(), rates: z.boolean() });
export type TimeSinkTraits = z.infer<typeof timeSinkTraitsSchema>;

// ---------- Connections ----------

/**
 * A connection's state: fine, credentials refused, signed in but not
 * allowed, set up wrong, the service out of reach, or answering in a way the
 * adapter doesn't understand (an API change). Freshness: verifiedAt.
 */
export const CONNECTION_STATUSES = ["ok", "authFailed", "forbidden", "misconfigured", "unreachable", "incompatible"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Error codes, and the state each may come with. */
export const CONNECTION_ERROR_STATUS = {
  authRejected: "authFailed",
  permissionDenied: "forbidden",
  badSettings: "misconfigured",
  notFound: "misconfigured",
  serviceDown: "unreachable",
  rateLimited: "unreachable",
  badResponse: "incompatible",
} as const satisfies Record<string, Exclude<ConnectionStatus, "ok">>;
export type ConnectionErrorCode = keyof typeof CONNECTION_ERROR_STATUS;

/** A connection's last problem, as a code and safe parameters: the app writes the words (i18n); details stay in the server log. */
export const connectionErrorSchema = z.strictObject({
  code: z.enum(Object.keys(CONNECTION_ERROR_STATUS) as [ConnectionErrorCode, ...ConnectionErrorCode[]]),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  at: instantSchema,
});
export type ConnectionError = z.infer<typeof connectionErrorSchema>;

/**
 * The host as the app shows it: a name (labels of letters, digits and inner
 * hyphens), an IPv4, or an IPv6 in brackets, maybe with a port. A display
 * value, normalized and checked when the connection was made.
 */
const hostSchema = z
  .string()
  .regex(/^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/i, "not a host")
  .refine((host) => {
    const port = host.startsWith("[") ? /^\[[^\]]+\](?::(\d{1,5}))?$/.exec(host)?.[1] : /:(\d{1,5})$/.exec(host)?.[1];
    return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
  }, "port out of range");

const summaryFields = {
  id: z.number().int().positive(),
  label: z.string().min(1),
  host: hostSchema,
  status: z.enum(CONNECTION_STATUSES),
  lastError: connectionErrorSchema.nullable(),
  /** When the capabilities were last checked (an app treats old ones as stale) */
  verifiedAt: instantSchema.nullable(),
};
const coherent = (s: { status: ConnectionStatus; lastError: ConnectionError | null }) =>
  s.status === "ok" ? s.lastError === null : s.lastError !== null && CONNECTION_ERROR_STATUS[s.lastError.code] === s.status;

/** A connection as the app shows it: type, role, capabilities and state always agree. */
export const connectionSummarySchema = z.discriminatedUnion("role", [
  z.strictObject({ ...summaryFields, role: z.literal("tracker"), type: z.enum(TRACKER_TYPES), capabilities: trackerCapabilitiesSchema }).refine(coherent, "status and error disagree"),
  z.strictObject({ ...summaryFields, role: z.literal("timeSink"), type: z.enum(TIME_SINK_TYPES), capabilities: timeSinkCapabilitiesSchema }).refine(coherent, "status and error disagree"),
]);
