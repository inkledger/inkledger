// The contract every provider adapter fulfils (api/providers/<type>/). Two
// roles: trackers (issues and their workflow, maybe time) and time sinks
// (only time). Each optional operation matches a capability; core/validate.ts
// checks the two agree both ways and that a connection's probe never claims
// more than its provider. Checked against every service in CATALOG.md: a
// service that doesn't fit without forcing changes this contract, not the
// service.
//
// Who does what:
// - The adapter translates its service: calls, formats, errors (always a
//   ProviderError, core/errors.ts; the registry's binding converts anything
//   else), checkpoints (core/checkpoint.ts).
// - The core validates before calling: input against capabilities (time
//   shape, transition fields, targets), and owns retries, idempotency keys
//   and composed mutations.
// - The sync engine owns identity: aliases, transfers, reconciliation.
// - The registry binds a provider to a connection with its typed options; the
//   rest of the app only sees effective capabilities.
//
// Conventions: values are the branded ones of @contracts/values (Instant,
// LocalDate, Markdown); operations on an issue take an IssueRef (stable id
// first; the container only a hint); texts are read in the service's format
// and written as Markdown; every call gets a CallContext.
//
// What the sync engine (WP-08) owes this contract:
// - A pass is read page after page; its checkpoint is stored only after the
//   last page; a pass cut short is read again from the previous checkpoint.
//   Ingestion is idempotent: duplicates and replays change nothing.
// - An "invalidCheckpoint" error restarts from none (a full read), logged.
// - Same remoteId, new key: the item takes the new key, the old one becomes
//   an alias (item_aliases), and so do the rows about it.
// - A gone "transferred" links old and new identity: the rows about the old
//   item move to the successor, its id and key become aliases.
// - "missing" (absent at reconciliation) is never treated as deleted: kept,
//   marked, until the service says more.
// - An entry that can only be recreated: create the new one first (same
//   idempotency key on retries), then delete the old; a failed delete leaves
//   the old one marked superseded and queued, never two live copies unlinked.
// - Mutations are retried only when protected: an idempotency key the
//   service honours, or a read that shows the first attempt didn't land.
// - Calls to a connection are throttled from its rate limits (errors and
//   probe); a rateLimit error waits retryAfterMs.
import type { QueryExpr } from "@contracts/query";
import type {
  BodyFormat,
  MarkdownFeature,
  ProviderType,
  RateLimitFigure,
  StatusCategory,
  StructuredFormat,
  TextFormat,
  TimeSinkCapabilities,
  TimeSinkTraits,
  TimeSinkType,
  TrackerCapabilities,
  TrackerTraits,
  TrackerType,
  WorkflowSource,
} from "@contracts/providers";
import type { Instant, JsonValue, LocalDate, Markdown, TimeZone } from "@contracts/values";

export type { Instant, JsonValue, LocalDate, Markdown, TimeZone } from "@contracts/values";

// ---------- Calls and connections ----------

/**
 * What opens a service, decrypted on use. OAuth access tokens arrive valid:
 * refreshing them is the connection layer's job, never an adapter's.
 */
export type Credential =
  | { kind: "token"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "oauth"; accessToken: string; expiresAt: Instant | null };

/** One account on a service, with what's needed to call it. */
export type Conn<T extends ProviderType = ProviderType, O = unknown> = {
  id: number;
  userId: number;
  type: T;
  /** Site or API root, normalized */
  baseUrl: string;
  remoteAccountId: string;
  /** The provider's options, as its parseOptions made them */
  options: O;
  /** Where this connection's LocalDates are counted (the user's zone) */
  timeZone: TimeZone;
  credential: () => Promise<Credential>;
};

/** Every call: the connection, a way to cancel it, and an id tying its logs, retries and requests together. */
export type CallContext<T extends ProviderType = ProviderType, O = unknown> = {
  conn: Conn<T, O>;
  signal: AbortSignal;
  correlationId: string;
};

/** What parseRef may look at: the connection's site and options, never its credentials (no I/O). */
export type RefContext<O = unknown> = { baseUrl: string; options: O };

// ---------- Issues ----------

/** Someone on a service. */
/** A person on a service; `handle` is what the service names them by in requests (GitHub login), when not their id. */
export type RemotePerson = { remoteId: string; name: string; avatarUrl?: string | null; handle?: string };

/** A new issue, as the app writes it. */
/** A new issue; `type` is one of the container's issue types (manage.types), required where the service asks for one. */
export type IssueDraft = { title: string; body?: Markdown; labels?: string[]; assignees?: RemotePerson[]; type?: string };

/** An issue type a new issue can have in a container (Jira: Task, Bug…). */
export type IssueTypeOption = { id: string; name: string };

/** Canonical container kinds; a service's own word goes after "x-" ("x-space"). */
export type ContainerKind = "project" | "repository" | "board" | "list" | "section" | "team" | "space" | "folder" | "workspace" | "database" | "plan" | `x-${string}`;

/** The project, repository, board, list… an issue belongs to. */
export type ContainerRef = {
  /** Stable id on the service */
  remoteId: string;
  /** A readable identifier, normalized (project key, owner/repo, board short name); not always unique across a service */
  key: string;
  /** What people call it */
  name: string;
  kind: ContainerKind;
  avatarUrl?: string | null;
  /** The group it belongs to on the service (a Jira project category, a GitHub owner): where a client is suggested from */
  group?: string | null;
};

/** A container as a hint: what a service may need to call, never part of an identity. */
export type ContainerHint = Pick<ContainerRef, "remoteId" | "key">;

/** Which issue, fully: what the core holds and every operation takes. */
export type IssueRef = { remoteId: string; key: string; container?: ContainerHint };

/**
 * Which issue, as a feed, a time entry or a person says it: at least its id
 * or its key, with its container when the key alone isn't unique (repo#12).
 */
export type IssueHandle = ({ remoteId: string; key?: string } | { remoteId?: undefined; key: string }) & { container?: ContainerHint };

/** A local mapping's id (a connection's category mapping), never a service id: built by mappingId. */
export type MappingId = number & { readonly __mappingId: unique symbol };
/** A version of one mapping (each mapping counts its own, from 1): items are recomputed when it changes. Built by mappingVersion. */
export type MappingVersion = number & { readonly __mappingVersion: unique symbol };

const positiveInt = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Not a ${what}: ${n}`);
  return n;
};
export const mappingId = (n: number) => positiveInt(n, "mapping id") as MappingId;
export const mappingVersion = (n: number) => positiveInt(n, "mapping version") as MappingVersion;

/** Where a status was read from, precisely: which field, board or label scope, of which container. */
export type StatusSourceRef =
  | { kind: "itemState"; containerRemoteId?: string }
  | { kind: "projectField"; fieldRemoteId: string; containerRemoteId: string }
  | { kind: "column"; boardRemoteId: string }
  | { kind: "labelSet"; scope: string; containerRemoteId?: string }
  | { kind: "boolean" };

/** A status as its tracker names it, with the category it sits in. */
export type RemoteStatus = {
  /** Unique within its source (StatusSourceRef qualifies it) */
  id: string;
  name: string;
  category: StatusCategory;
  /** Said by the service, or by a version of the connection's mapping */
  categoryOrigin: { by: "native" } | { by: "mapping"; mapping: MappingId; version: MappingVersion };
  source: StatusSourceRef;
  /** The service's own reason or sub-state (GitHub's state_reason, Jira's resolution) */
  nativeReason?: string | null;
  color?: string;
  order?: number;
};

/** An issue, card, task, story or work item, in the layer's words. */
export type RemoteIssue = {
  /** Stable id on the tracker. A move that gives a new id is a gone "transferred" with a successor. */
  remoteId: string;
  /** Human key (APP-12, repo#12…): may change when it moves */
  key: string;
  url: string;
  title: string;
  type: { id: string; name: string; level?: "epic" | "standard" | "sub" };
  status: RemoteStatus;
  container: ContainerRef;
  priority?: { id: string; name: string; rank: number | null } | null;
  labels: string[];
  assignees: RemotePerson[];
  reporter?: RemotePerson | null;
  due?: LocalDate | null;
  estimateSeconds?: number | null;
  spentSeconds?: number | null;
  createdAt?: Instant | null;
  updatedAt?: Instant | null;
  statusChangedAt?: Instant | null;
  parent?: IssueRef | null;
  /** Fields the layer doesn't map (custom fields), by the service's ids, JSON only */
  fields?: Record<string, JsonValue>;
};

// ---------- Paging ----------

/** Which incremental stream a checkpoint or page token belongs to. */
export type Stream = "issues" | "worklogs" | "entries" | "inbox";

/** Where a pass stopped: opaque outside its adapter, bound to provider, connection, stream and format (core/checkpoint.ts). */
export type Checkpoint = string & { readonly __checkpoint: unique symbol };
/** The next page of a pass under way: bound to the pass (its starting checkpoint) as well. */
export type PageToken = string & { readonly __pageToken: unique symbol };

/**
 * A pass from a checkpoint (null: everything), and where in it. Stream,
 * connection, provider, format and starting checkpoint are inside the
 * tokens and checked on every decoding (core/checkpoint.ts): a token can't
 * be used on another stream, connection or pass.
 */
export type PageQuery = { since: Checkpoint | null; page: PageToken | null };

/**
 * Why an issue stopped being among the user's, as its service says it (only
 * the reasons its capabilities declare). Adapters never report "missing".
 */
export type ReportedIssueGone =
  | { remoteId: string; reason: "deleted" }
  | { remoteId: string; reason: "lostAccess" }
  | { remoteId: string; reason: "movedOut" }
  | { remoteId: string; reason: "transferred"; successor: IssueRef };

/**
 * The engine's view: what services report, plus "missing" (absent at
 * reconciliation, cause unknown), which only the engine concludes.
 */
export type IssueGone = ReportedIssueGone | { remoteId: string; reason: "missing" };

/** A time entry removed, as its service says it (only when its feed declares removals). */
export type ReportedEntryGone = { remoteId: string; reason: "deleted" };
/** The engine's view of a removed entry. */
export type EntryGone = ReportedEntryGone | { remoteId: string; reason: "missing" };

/**
 * One page of a pass: more to read (next), or the last one, the only one
 * with the checkpoint (null when the provider has no checkpoints: every pass
 * is a full scan). Adapters keep pages in a deterministic order (ties broken
 * by id) as far as their service allows; the engine never relies on it, its
 * ingestion being idempotent.
 */
export type Page<T, G> =
  | { last: false; items: T[]; gone: G[]; next: PageToken }
  | { last: true; items: T[]; gone: G[]; checkpoint: Checkpoint | null };

// ---------- Workflow ----------

/** A field a transition asks for. Types are added as real adapters need them; unknown is the safe fallback. */
export type FieldReq = { id: string; name: string; required: boolean } & (
  | { type: "text"; multiline: boolean }
  | { type: "number" }
  | { type: "date" }
  | { type: "choice"; options: { id: string; name: string }[] }
  | { type: "multiChoice"; options: { id: string; name: string }[] }
  | { type: "user" }
  | { type: "unknown"; nativeType: string }
);

/**
 * Values for a transition's fields. Their kind follows the field's FieldReq,
 * and the core checks them against it (required, options, types) before the
 * adapter gets them: values are never interpreted without their FieldReq.
 */
export type FieldValue = string | number | string[] | { date: LocalDate } | { user: string };

/**
 * A way out of the current status, as the service offers it now (the core
 * accepts an apply only for a transition of the latest list; the service may
 * still refuse it: conflict or invalid). Whether inkledger can carry it out is the
 * core's computation from the requirements (a required field of unknown type:
 * not here; then remoteUrl, the service's own page, or null when it has none).
 */
export type Transition = { id: string; name: string; to: RemoteStatus; requirements: FieldReq[]; remoteUrl: string | null };

/**
 * An active workflow source of a connection: a declared kind with its
 * concrete identity, the reference always of the same kind (a column source
 * has a column reference).
 */
export type ActiveWorkflowSource = {
  [K in WorkflowSource["kind"]]: Extract<WorkflowSource, { kind: K }> & { ref: Extract<StatusSourceRef, { kind: K }>; name: string };
}[WorkflowSource["kind"]];

// ---------- Time ----------

/** Time as a service keeps it (read). */
export type RemoteTimeSpan =
  | { kind: "session"; start: Instant; seconds: number }
  | { kind: "date"; date: LocalDate; seconds: number }
  /** The day's total for the issue */
  | { kind: "dayTotal"; date: LocalDate; seconds: number };

/** Time to write an entry: what an "entries" service takes (its shape, checked by the core). */
export type TimeInput = { kind: "session"; start: Instant; seconds: number } | { kind: "date"; date: LocalDate; seconds: number };

/** Why an entry can't be changed: canonical, the service's own words beside it. */
export type LockCause = "approved" | "submitted" | "invoiced" | "periodClosed" | "permission" | "other";

export type ApprovalState = "none" | "draft" | "submitted" | "approved" | "rejected";

/** A time entry on a service. */
export type RemoteWorklog = {
  remoteId: string;
  /** The issue it is on; null on a time sink entry nobody linked to an issue (queued for reconciliation) */
  issue: IssueHandle | null;
  span: RemoteTimeSpan;
  /** Plain text */
  comment: string;
  /** Who logged it, as the service knows them */
  authorRemoteId: string;
  /** Their name, where the service says it (others' entries on a shared issue) */
  authorName?: string | null;
  createdAt?: Instant | null;
  updatedAt?: Instant | null;
  billable?: boolean | null;
  activity?: { id: string; name: string } | null;
  approval?: ApprovalState | null;
  /** Opaque revision for optimistic updates: compared only by its service */
  version?: string | null;
  /** Why it can't be changed, for the user */
  locked?: { cause: LockCause; message?: string } | null;
  /** What can be done to it now: authoritative for operations (never true when locked), a snapshot nonetheless */
  editable: { update: boolean; delete: boolean };
  /** The service keeps only the day (a session's clock time is a guess): a known entry keeps its own start that day */
  dayOnly?: boolean;
};

/** What a new or changed entry says. billable/activity/onBehalf only where the capabilities allow (checked by the core). */
export type WorklogInput = {
  time: TimeInput;
  comment: string;
  billable?: boolean;
  activityId?: string;
  /** Log for this person, by their id on this service */
  onBehalfOfRemoteId?: string;
};

/** What a creation carries besides its content: a key, always set by the engine; the same key twice makes one entry where the service honours it. */
export type CreateOptions = { idempotencyKey: string };

/**
 * What a change or deletion carries: the revision it was read at, required
 * when the capabilities say "revision" (conflict when it moved). Deleting
 * what is already gone is a success.
 */
export type ChangeOptions = { expectedVersion?: string };

/** Setting a day total replaces it: a key for retries, and the revision it was read at when the service keeps one. */
export type SetOptions = CreateOptions & ChangeOptions;

// ---------- Webhooks ----------

/** A delivery as received: header names lower-cased, the body as sent. */
export type WebhookRequest = { headers: Record<string, string>; body: string };

export type WebhookCheck = {
  /** The delivery is the service's, for this connection's secret (its signature when it signs; true when it can't) */
  verify(req: WebhookRequest, secret: string): boolean;
  /** The delivery's own id, to refuse a replay; null when the service gives none */
  deliveryId(req: WebhookRequest): string | null;
  /** When it was sent (epoch ms), when the service says: too old is refused */
  sentAt?(req: WebhookRequest): number | null;
};

// ---------- Texts and history ----------

/** A comment's body: text in a markup, or a structured document (authoritative) with a text preview. */
export type RemoteBody =
  | { kind: "text"; format: TextFormat; text: string }
  | { kind: "structured"; format: StructuredFormat; payload: JsonValue; preview: string };

/**
 * Why a CommonMark text wasn't kept exactly: a canonical code and the feature
 * (shown by the app in its words), and a detail for the server log only (the
 * binding strips it before anything leaves the server).
 */
export type ConversionWarning = { code: "unsupportedFeature" | "approximated" | "stripped"; feature?: MarkdownFeature; serverDetail?: string };
/** A conversion warning as it may leave the server. */
export type PublicConversionWarning = Omit<ConversionWarning, "serverDetail">;

/** The warning without its server detail: removed from the object, not only from the type. */
export function publicConversionWarning(warning: ConversionWarning): PublicConversionWarning {
  const shown: ConversionWarning = { ...warning };
  delete shown.serverDetail;
  return shown;
}

/** Something listed up to a limit: complete false when the service had more (enough for pickers, not for syncing catalogues). */
export type Limited<T> = { items: T[]; complete: boolean };

/** An entry of a small catalogue (activities). */
export type CatalogItem = { id: string; name: string };

export type RemoteComment = {
  id: string;
  author: RemotePerson;
  body: RemoteBody;
  createdAt: Instant | null;
  updatedAt: Instant | null;
};

/** One value in an issue's history: what people read, the service's id, the original (JSON). */
export type ChangeValue = { text: string; id?: string; raw?: JsonValue };

/**
 * A change as the service's history records it (the adapter reads every
 * page). No value is an empty list, never [""]. What inkledger saw change between
 * two reads is the engine's, another type.
 */
export type RemoteChange = {
  at: Instant;
  actor: RemotePerson | null;
  /** No id for changes the service doesn't tie to a field */
  field: { id?: string; name: string };
  from: ChangeValue[];
  to: ChangeValue[];
};

// ---------- Probes ----------

export type { RateLimitFigure };

/**
 * What a connection can do: capabilities within the provider's (the only
 * source of its effective limits: capabilities.time.entries.limits), and the
 * call budget it meets. Probed right after verify (an adapter may reuse what
 * verify read); the core keeps verifiedAt and treats it as fresh for a day,
 * and drops it on an auth or forbidden error and when the options change.
 */
export type TrackerProbe = {
  capabilities: TrackerCapabilities;
  /** Concrete sources, each once (by sourceKey) and of a declared kind */
  activeSources: ActiveWorkflowSource[];
  rateLimit?: RateLimitFigure;
  verifiedAt: Instant;
};
export type TimeSinkProbe = { capabilities: TimeSinkCapabilities; rateLimit?: RateLimitFigure; verifiedAt: Instant };

/** Looking an issue up by a handle: found, none the user can see, or several a key alone can't tell apart (never a silent pick). */
export type FindResult = { kind: "found"; issue: RemoteIssue } | { kind: "none" } | { kind: "ambiguous"; candidates: [RemoteIssue, RemoteIssue, ...RemoteIssue[]] };

// ---------- Trackers ----------

/** An issue tracker. O: its options, as parseOptions makes them. */
export interface TrackerProvider<T extends TrackerType = TrackerType, O = unknown> {
  role: "tracker";
  type: T;
  capabilities: TrackerCapabilities;
  traits: TrackerTraits;
  /**
   * The options a person may change from the app (Settings → Connections),
   * each a choice among values: the app shows them as they are, and checks
   * a change with parseOptions.
   */
  settings?: readonly { key: string; choices: readonly string[] }[];

  /** The connection's stored options, checked (throws ProviderError "invalid"). */
  parseOptions(raw: unknown): O;

  /** A key as the tracker writes it, or null: syntax only, for input already known to be a key. */
  normalizeKey(raw: string): string | null;
  /** What someone typed or pasted, classified: key, URL, permalink → an issue handle, or null. Pure, no I/O. */
  parseRef(r: RefContext<O>, text: string): IssueHandle | null;
  /**
   * Present when capabilities.query: a search (contracts/query.ts) in the
   * tracker's own query language, for `query`; the terms it can't say are
   * named in `unsupported`. Pure, no I/O.
   */
  translate?(expr: QueryExpr | null, now: Date): { query: string; unsupported: string[] };
  /**
   * Present when capabilities.sync.webhooks: how the service's deliveries
   * are checked. Pure, no I/O. The core also checks the connection's own
   * token in the URL, refuses replays and stale deliveries, then reads the
   * connection again (a delivery is a signal, never data).
   */
  webhook?: WebhookCheck;

  /** Checks the credentials: who they belong to (cheap). */
  verify(x: CallContext<T, O>): Promise<RemotePerson & { login?: string; email?: string }>;
  /** What this connection can do (cached by the core). */
  probe(x: CallContext<T, O>): Promise<TrackerProbe>;

  /** The user's items changed since a checkpoint, a page at a time. */
  listChanged(x: CallContext<T, O>, q: PageQuery): Promise<Page<RemoteIssue, ReportedIssueGone>>;
  getIssue(x: CallContext<T, O>, ref: IssueRef): Promise<RemoteIssue | null>;
  /**
   * An issue by a handle (a key typed, a URL parsed). getIssue and every
   * operation fall back on the remoteId when a container hint is stale.
   */
  findIssue(x: CallContext<T, O>, handle: IssueHandle): Promise<FindResult>;

  /** Present when capabilities.searchText. Only what the connection may see; complete false when cut short. */
  searchText?(x: CallContext<T, O>, text: string, limit: number): Promise<Limited<RemoteIssue>>;
  /** Present when capabilities.query (the service's own query language). */
  query?(x: CallContext<T, O>, query: string, limit: number): Promise<Limited<RemoteIssue>>;

  /** Present when capabilities.statuses: every status of a source (its reference names the container when statuses are per container). */
  statuses?(x: CallContext<T, O>, source: ActiveWorkflowSource): Promise<RemoteStatus[]>;

  /** list when capabilities.transitions.read, apply when .write. */
  transitions?: {
    list?(x: CallContext<T, O>, ref: IssueRef): Promise<Transition[]>;
    /** The issue as it is after, when the service says it (else the engine reads it again) */
    apply?(x: CallContext<T, O>, ref: IssueRef, transitionId: string, fields: Record<string, FieldValue>): Promise<RemoteIssue | null>;
  };

  /** Present when capabilities.time.mode is "entries"; each operation as the entries' capabilities say. */
  worklogs?: {
    list(x: CallContext<T, O>, ref: IssueRef): Promise<RemoteWorklog[]>;
    /** One entry by its id, null when gone (optional: without it the core reads the issue's list) */
    get?(x: CallContext<T, O>, ref: IssueRef, id: string): Promise<RemoteWorklog | null>;
    /** Present for an incremental or window feed */
    changed?(x: CallContext<T, O>, q: PageQuery): Promise<Page<RemoteWorklog, ReportedEntryGone>>;
    create?(x: CallContext<T, O>, ref: IssueRef, w: WorklogInput, m: CreateOptions): Promise<RemoteWorklog>;
    update?(x: CallContext<T, O>, ref: IssueRef, id: string, w: WorklogInput, m: ChangeOptions): Promise<RemoteWorklog>;
    delete?(x: CallContext<T, O>, ref: IssueRef, id: string, m: ChangeOptions): Promise<void>;
    /** Present for a dayTotals service that can be written: sets the day's total, whole seconds ≥ 0 (0 removes it) */
    setDayTotal?(x: CallContext<T, O>, ref: IssueRef, date: LocalDate, seconds: number, m: SetOptions): Promise<RemoteWorklog | null>;
    /** Present when activities are writable: those an entry on this issue may have (no issue: the connection's whole catalogue) */
    activities?(x: CallContext<T, O>, scope: { issue?: IssueRef }, limit: number): Promise<Limited<CatalogItem>>;
  };

  /** Present when capabilities.time.mode is "counter"; each operation as declared. */
  /** Amounts are positive whole seconds (the method says the direction; checked by the core). */
  timeCounter?: {
    read?(x: CallContext<T, O>, ref: IssueRef): Promise<{ seconds: number; version: string | null }>;
    increment?(x: CallContext<T, O>, ref: IssueRef, seconds: number, m: ChangeOptions): Promise<{ seconds: number; version: string | null }>;
    decrement?(x: CallContext<T, O>, ref: IssueRef, seconds: number, m: ChangeOptions): Promise<{ seconds: number; version: string | null }>;
  };

  /** Present unless capabilities.comments.mode is "none"; add when "readWrite". */
  comments?: {
    list(x: CallContext<T, O>, ref: IssueRef): Promise<RemoteComment[]>;
    /** The comment as stored, or null when the service doesn't give it back yet (read again); warnings for what didn't convert exactly */
    add?(x: CallContext<T, O>, ref: IssueRef, body: Markdown, m: CreateOptions): Promise<{ comment: RemoteComment | null; warnings: ConversionWarning[] }>;
  };

  /** Present when capabilities.description: the issue's body as its service keeps it (null: it has none). */
  description?(x: CallContext<T, O>, ref: IssueRef): Promise<RemoteBody | null>;

  /** Present when capabilities.containers: every container the account can see (a bucket can pick one with no issue yet). */
  containers?(x: CallContext<T, O>): Promise<ContainerRef[]>;

  /** Present as capabilities.manage says. Each change gives the issue back as it now is (null: read it again). */
  manage?: {
    /** manage.assign: who can be assigned in a container */
    assignable?(x: CallContext<T, O>, container: ContainerHint): Promise<RemotePerson[]>;
    /** manage.assign: the issue's assignees become exactly these */
    assign?(x: CallContext<T, O>, ref: IssueRef, people: RemotePerson[]): Promise<RemoteIssue | null>;
    /** manage.labels: the labels a container offers */
    labelOptions?(x: CallContext<T, O>, container: ContainerHint): Promise<string[]>;
    /** manage.labels: the issue's labels become exactly these */
    setLabels?(x: CallContext<T, O>, ref: IssueRef, labels: string[]): Promise<RemoteIssue | null>;
    /** manage.create */
    create?(x: CallContext<T, O>, container: ContainerHint, draft: IssueDraft): Promise<RemoteIssue>;
    /** manage.edit: a new title and/or body */
    edit?(x: CallContext<T, O>, ref: IssueRef, patch: { title?: string; body?: Markdown }): Promise<RemoteIssue | null>;
    /** manage.types: the issue types a new issue can have in a container (sub-tasks left out: they need a parent) */
    createTypes?(x: CallContext<T, O>, container: ContainerHint): Promise<IssueTypeOption[]>;
  };

  /** Present when capabilities.watch. */
  watch?(x: CallContext<T, O>, ref: IssueRef, on: boolean): Promise<void>;

  /** Present when capabilities.history (every page read by the adapter). */
  history?(x: CallContext<T, O>, ref: IssueRef): Promise<RemoteChange[]>;

  /**
   * Present when capabilities.inbox: what the service told the user since
   * `cursor` (null: its recent unread), and the cursor to ask from next time.
   * `notModified` when nothing changed (no item, the cursor kept).
   */
  inbox?(x: CallContext<T, O>, cursor: string | null): Promise<{ items: InboxItem[]; cursor: string | null; notModified?: boolean }>;
  /** Present when capabilities.inbox: one item read on the service too. */
  markRead?(x: CallContext<T, O>, id: string): Promise<void>;

  /** Present when capabilities.otherFields: the issue's fields inkledger doesn't map, as the service names them, values as text (empty ones left out). */
  otherFields?(x: CallContext<T, O>, ref: IssueRef): Promise<{ name: string; value: string }[]>;
}

/** One item of a service's own inbox, about one issue. */
export type InboxItem = {
  /** The service's id of the item (a thread): marking it read uses it */
  id: string;
  /** mention | comment | review | change | assign | other: news the sync can't see, assign it can */
  reason: "mention" | "comment" | "review" | "change" | "assign" | "other";
  issue: IssueHandle;
  title: string;
  at: Instant;
  unread: boolean;
};

// ---------- Time sinks ----------

/**
 * Where a time entry points back to. Identity: the tracker connection and the
 * issue (trackerType is checked against the connection); the snapshot only
 * describes, never reconciles.
 */
export type ExternalRef = { trackerType: TrackerType; trackerConnectionId: number; issue: IssueRef; snapshot: { url: string; title: string } };

/** A project, task (or the like) a time sink files entries under; path: its ancestors, root first, itself excluded. */
export type SinkTarget = { remoteId: string; name: string; path: { remoteId: string; name: string }[] };

/** A service that only receives time. */
export interface TimeSinkProvider<T extends TimeSinkType = TimeSinkType, O = unknown> {
  role: "timeSink";
  type: T;
  capabilities: TimeSinkCapabilities;
  traits: TimeSinkTraits;

  parseOptions(raw: unknown): O;
  verify(x: CallContext<T, O>): Promise<RemotePerson & { email?: string }>;
  probe(x: CallContext<T, O>): Promise<TimeSinkProbe>;

  /** Present when targets are used and found by searching: a limited search, complete false when cut short. */
  targets?(x: CallContext<T, O>, query: string, limit: number): Promise<Limited<SinkTarget>>;

  entries: {
    /** The user's entries from `from` to `to`, both days included, in the connection's time zone (the adapter reads every page; the core splits long ranges into the reconcile span) */
    list(x: CallContext<T, O>, range: { from: LocalDate; to: LocalDate }): Promise<RemoteWorklog[]>;
    changed?(x: CallContext<T, O>, q: PageQuery): Promise<Page<RemoteWorklog, ReportedEntryGone>>;
    /** target: null exactly when the capabilities' target use is "none" (checked by the core) */
    create?(x: CallContext<T, O>, ref: ExternalRef, target: SinkTarget | null, w: WorklogInput, m: CreateOptions): Promise<RemoteWorklog>;
    update?(x: CallContext<T, O>, id: string, w: WorklogInput, m: ChangeOptions): Promise<RemoteWorklog>;
    delete?(x: CallContext<T, O>, id: string, m: ChangeOptions): Promise<void>;
    setDayTotal?(x: CallContext<T, O>, ref: ExternalRef, target: SinkTarget | null, date: LocalDate, seconds: number, m: SetOptions): Promise<RemoteWorklog | null>;
    /** Those an entry under this target may have (no target: the connection's whole catalogue) */
    activities?(x: CallContext<T, O>, scope: { target?: SinkTarget }, limit: number): Promise<Limited<CatalogItem>>;
  };
}

/**
 * Every adapter as the validator sees it: role, capabilities, traits, and
 * each operation, required or optional, only as something callable (checked
 * at runtime with typeof). Never a surface to call through: the core uses
 * adapters bound to a connection (core/bind.ts). The operation names are in
 * core/operations.ts, which a type-level test holds to these interfaces.
 */
// Callability only, any signature: never used to call (signatures live on the provider interfaces).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Op = (...args: any[]) => unknown;
export type TrackerShape = {
  role: "tracker";
  type: TrackerType;
  capabilities: TrackerCapabilities;
  traits: TrackerTraits;
  parseOptions: Op;
  normalizeKey: Op;
  parseRef: Op;
  translate?: Op;
  webhook?: unknown;
  verify: Op;
  probe: Op;
  listChanged: Op;
  getIssue: Op;
  findIssue: Op;
  searchText?: Op;
  query?: Op;
  statuses?: Op;
  transitions?: { list?: Op; apply?: Op };
  worklogs?: { list: Op; get?: Op; changed?: Op; create?: Op; update?: Op; delete?: Op; setDayTotal?: Op; activities?: Op };
  timeCounter?: { read?: Op; increment?: Op; decrement?: Op };
  comments?: { list: Op; add?: Op };
  description?: Op;
  containers?: Op;
  manage?: { assignable?: Op; assign?: Op; labelOptions?: Op; setLabels?: Op; create?: Op; edit?: Op; createTypes?: Op };
  watch?: Op;
  history?: Op;
  inbox?: Op;
  markRead?: Op;
  otherFields?: Op;
};
export type TimeSinkShape = {
  role: "timeSink";
  type: TimeSinkType;
  capabilities: TimeSinkCapabilities;
  traits: TimeSinkTraits;
  parseOptions: Op;
  verify: Op;
  probe: Op;
  targets?: Op;
  entries: { list: Op; changed?: Op; create?: Op; update?: Op; delete?: Op; setDayTotal?: Op; activities?: Op };
};
export type ProviderShape = TrackerShape | TimeSinkShape;

export type { BodyFormat };
