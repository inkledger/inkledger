import {
  uuid,
  pgTable,
  integer,
  bigint,
  serial,
  text,
  uniqueIndex,
  index,
  doublePrecision,
  customType,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * A moment stored as epoch milliseconds (bigint), read as a Date — the same
 * representation the app used on SQLite, so data moves over unchanged.
 */
const ms = customType<{ data: Date; driverData: string | number }>({
  dataType: () => "bigint",
  toDriver: (d) => d.getTime(),
  fromDriver: (v) => new Date(Number(v)),
});

/** Raw bytes (a module's cached pictures). */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  // node-postgres gives a Buffer, PGlite (tests) a Uint8Array.
  fromDriver: (v) => Buffer.from(v),
});

/** Epoch milliseconds kept as a number (sortable, nullable). */
const epochMs = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  /** The address or login the person gave (a tracker's login, at activation) */
  email: text("email").notNull().default(""),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  /** inkledger's own sign-in name (null until the account chooses one) */
  username: text("username"),
  /** scrypt hash (api/lib/password.ts); null: signs in only through a linked connection */
  passwordHash: text("password_hash"),
  /** "admin" | "member" */
  role: text("role").notNull().default("member"),
  /** JSON array of Permission (contracts/accounts.ts); an admin has them all */
  permissions: text("permissions").notNull().default("[]"),
  /** 1 = the next sign-in must set a new password first (default admin, reset) */
  mustChangePassword: integer("must_change_password").notNull().default(0),
  /** Set when an admin turns the account off: no sign-in, sessions gone */
  disabledAt: ms("disabled_at"),
  createdAt: ms("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("uq_users_username").on(sql`lower(${t.username})`),
]);

/**
 * A one-time link an admin hands to a new person (no mail leaves the server):
 * opening it, they choose their password. Only the token's hash is kept.
 */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ms("expires_at").notNull(),
    usedAt: ms("used_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_invites_user").on(t.userId)],
);

/**
 * A tracker account the user works with (a provider instance: a Jira site,
 * a GitHub account…). Every issue, worklog and the rows hanging on them
 * belong to one. Never deleted while anything refers to it: removing it from
 * the app archives it (archived_at), so logged time is never lost.
 */
export const connections = pgTable(
  "connections",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The provider: "jira" (more to come) */
    type: text("type").notNull(),
    /** The user's name for it ("" = the host) */
    label: text("label").notNull().default(""),
    /** Site or API root, normalized */
    baseUrl: text("base_url").notNull(),
    /** The user's id on it (Jira Cloud accountId, Server username…) */
    remoteAccountId: text("remote_account_id").notNull(),
    displayName: text("display_name").notNull().default(""),
    avatarUrl: text("avatar_url"),
    /** Provider options, JSON (Jira: deployment, authType, username) */
    options: text("options").notNull().default("{}"),
    encryptedSecret: text("encrypted_secret").notNull(),
    /** "ok" | "auth_failed" | "unreadable" */
    status: text("status").notNull().default("ok"),
    /** What the last test found (TrackerProbe as JSON): plan, active sources, call budget */
    probe: text("probe"),
    probedAt: ms("probed_at"),
    /** Writes allowed by the user on an adapter not verified on a real account yet (0: it only reads) */
    writesAllowed: integer("writes_allowed").notNull().default(0),
    /** Webhooks on (D5, off by default): their secret, sealed like the credentials; null when off */
    webhookSecret: text("webhook_secret"),
    /** 1 = mirrors the Jira credentials still kept on users (until they move here for good) */
    legacy: integer("legacy").notNull().default(0),
    archivedAt: ms("archived_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_connections_user_account").on(t.userId, t.type, t.baseUrl, t.remoteAccountId),
    index("idx_connections_user").on(t.userId),
  ],
);

export type Connection = typeof connections.$inferSelect;

/**
 * The connection a row belongs to. Filled by the database when the insert
 * leaves it out and the user has exactly one connection (a trigger: see the
 * platform-core migration); refused when the user has several.
 */
const connectionRef = () =>
  integer("connection_id")
    .references(() => connections.id)
    .notNull()
    .$defaultFn(() => sql`NULL`);

/** connection_id where a row may be about no issue (a free note on a board). */
const optionalConnectionRef = () => integer("connection_id").references(() => connections.id);

/**
 * The issue a row is about (issues.id): stable when the issue changes key.
 * Filled by the database from the row's issue key; null while the issue is
 * not in the catalogue (a worklog on an issue never imported).
 */
const itemRef = () => integer("item_id").references(() => issues.id, { onDelete: "set null" });

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ms("expires_at").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_sessions_user").on(t.userId)],
);

/**
 * A browser or app that may sign in again without the Jira secret: the
 * stored (encrypted) one is reused. Only the token's hash is kept, as for
 * sessions; the token travels in its own long-lived HttpOnly cookie.
 */
export const rememberedDevices = pgTable(
  "remembered_devices",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ms("expires_at").notNull(),
    lastUsedAt: ms("last_used_at")
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_remembered_devices_user").on(t.userId)],
);

/**
 * A project, repository, board, list… of a connection, as its service
 * names it: issues belong to one, reports and buckets group by it.
 * remoteId is its stable id; "key:<KEY>" until only its key is known (rows
 * from before containers), replaced by the real id when a sync brings it.
 */
export const containers = pgTable(
  "containers",
  {
    id: serial("id").primaryKey(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    remoteId: text("remote_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull().default(""),
    /** ContainerKind (api/providers/types.ts): project, repository, board… */
    kind: text("kind").notNull().default("project"),
    parentId: integer("parent_id"),
    avatarUrl: text("avatar_url"),
    /** Its group on the service (Jira project category, GitHub owner): clients are suggested from it */
    groupName: text("group_name"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_containers_connection_remote").on(t.connectionId, t.remoteId), index("idx_containers_connection_key").on(t.connectionId, t.key)],
);

export const issues = pgTable(
  "issues",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    /** The project, repository, board… it belongs to (null until known) */
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
    /** The issue's stable id on its connection (Jira id) */
    remoteId: text("jira_id").notNull(),
    /** Its human key (APP-12): changes when the issue moves; old keys stay in item_aliases */
    key: text("key").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull(),
    /** The native status group's name ("To Do", "In corso"…), as the service shows it */
    statusCategory: text("status_category").notNull().default(""),
    /** The canonical category (StatusCategory): triage, backlog, todo, doing, done, cancelled */
    category: text("category").notNull().default("todo"),
    /** 0 (highest) … 4 (lowest), the native order scaled; null: no priority known */
    priorityRank: integer("priority_rank"),
    projectKey: text("project_key").notNull(),
    projectName: text("project_name").notNull(),
    issueType: text("issue_type").notNull().default(""),
    priority: text("priority").notNull().default(""),
    /** Jira labels, as JSON string array */
    labels: text("labels").notNull().default("[]"),
    /** Assignee accountId (Cloud) or username (Server/DC) */
    assigneeId: text("assignee_id").notNull().default(""),
    /** Display names; null = never fetched (rows older than these columns) */
    assigneeName: text("assignee_name"),
    reporterName: text("reporter_name"),
    /** 1 = starred as favorite by the user */
    favorite: integer("favorite").notNull().default(0),
    /** Manual order among favorites (ascending) */
    favoriteRank: integer("favorite_rank").notNull().default(0),
    /** 1 = hidden by the user: kept in sync, out of every list */
    hidden: integer("hidden").notNull().default(0),
    /** 1 = the user watches it on Jira (refreshed by full syncs) */
    watching: integer("watching").notNull().default(0),
    timeEstimateSeconds: integer("time_estimate_seconds"),
    timeSpentSeconds: integer("time_spent_seconds"),
    dueDate: text("due_date"),
    remoteUpdated: text("jira_updated"),
    /** Jira "updated" (epoch ms): sortable across time zones, unlike the text */
    remoteUpdatedAt: epochMs("jira_updated_at"),
    /** Jira "created" (epoch ms) */
    remoteCreatedAt: epochMs("jira_created_at"),
    /** Last status category change (epoch ms), when Jira provides it */
    statusChangedAt: epochMs("status_changed_at"),
    /** Latest comment by anyone (epoch ms), open issues only */
    lastCommentAt: epochMs("last_comment_at"),
    /** Most recent of the three above: the "needs my attention" order */
    activityAt: epochMs("activity_at"),
    /**
     * Latest activity by someone else (comment, status change, assignment to
     * me; epoch ms): drives "unread", while activityAt drives the order.
     */
    othersActivityAt: epochMs("others_activity_at"),
    /** Last time the user opened / acted on it (epoch ms): newer others' activity = unread */
    seenAt: epochMs("seen_at"),
    /** Jira project icon (absolute URL on the user's site, fetched via proxy) */
    projectAvatarUrl: text("project_avatar_url"),
    url: text("url").notNull(),
    /**
     * Set when the issue left the user's (its tracker said why, or
     * reconciliation found it missing): kept, with its time, never deleted here.
     */
    goneAt: ms("gone_at"),
    /** "deleted" | "lostAccess" | "movedOut" | "transferred" | "missing" */
    goneReason: text("gone_reason"),
    /**
     * The last "other fields" read from its tracker (T8): JSON of
     * {name, value}[], at most 32 KB, never in lists; shown when the tracker
     * can't be reached.
     */
    raw: text("raw"),
    syncedAt: ms("synced_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_issues_connection_remote").on(t.userId, t.connectionId, t.remoteId),
    index("idx_issues_user_status").on(t.userId, t.status),
    index("idx_issues_user_project").on(t.userId, t.projectKey),
    index("idx_issues_connection_container").on(t.connectionId, t.containerId),
    index("idx_issues_user_connection_category").on(t.userId, t.connectionId, t.category),
    // Search: substring matches (ILIKE) on title and key, any language (pg_trgm).
    index("idx_issues_summary_trgm").using("gin", t.summary.op("gin_trgm_ops")),
    index("idx_issues_key_trgm").using("gin", t.key.op("gin_trgm_ops")),
  ],
);

export const worklogs = pgTable(
  "worklogs",
  {
    id: serial("id").primaryKey(),
    /**
     * The worklog's own identity in inkledger, from the moment it is logged: it
     * outlives a queued create getting its remote id, and is the idempotency
     * key sent to services that take one.
     */
    uuid: uuid("uuid").notNull().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key").notNull(),
    /** Its id on the primary sink (Jira); "pending-N" while its create is queued (outbox N) */
    remoteId: text("jira_worklog_id").notNull(),
    timeSpentSeconds: integer("time_spent_seconds").notNull(),
    started: ms("started").notNull(),
    comment: text("comment").notNull().default(""),
    authorAccountId: text("author_account_id").notNull().default(""),
    remoteCreated: text("jira_created"),
    remoteUpdated: text("jira_updated"),
    syncedAt: ms("synced_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Per connection: two trackers may both have an APP-1 with a worklog 10001.
    uniqueIndex("uq_worklogs_connection_issue_remote").on(t.userId, t.connectionId, t.issueKey, t.remoteId),
    index("idx_worklogs_user_started").on(t.userId, t.started),
    // An issue's time (reports and the issue page by its identity).
    index("idx_worklogs_item").on(t.itemId),
    uniqueIndex("uq_worklogs_uuid").on(t.uuid),
  ],
);

/**
 * A bucket: a set of sources (whole connections, or some of their
 * containers) the lists can be narrowed to, chosen per device. Personal
 * totals never follow it (D9).
 */
export const buckets = pgTable(
  "buckets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    /** A search (query language, English) narrowing its sources further, or "" */
    query: text("query").notNull().default(""),
    /** The board's layout for it: "lanes" (one per source, native columns), "category" or "custom" */
    boardMode: text("board_mode").notNull().default("lanes"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_buckets_user").on(t.userId)],
);

/** A bucket's own board columns ("custom" mode): each source's statuses mapped onto them. */
export const bucketColumns = pgTable(
  "bucket_columns",
  {
    id: serial("id").primaryKey(),
    bucketId: integer("bucket_id")
      .notNull()
      .references(() => buckets.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    name: text("name").notNull(),
    /** JSON { "<connectionId>": ["status", …] } */
    statuses: text("statuses").notNull().default("{}"),
  },
  (t) => [index("idx_bucket_columns_bucket").on(t.bucketId, t.position)],
);

export const bucketSources = pgTable(
  "bucket_sources",
  {
    id: serial("id").primaryKey(),
    bucketId: integer("bucket_id")
      .notNull()
      .references(() => buckets.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** One container of it; null: the whole connection */
    containerId: integer("container_id").references(() => containers.id, { onDelete: "cascade" }),
  },
  (t) => [index("idx_bucket_sources_bucket").on(t.bucketId)],
);

/** What each device remembers for itself: its active bucket (none: everything). */
export const devicePrefs = pgTable(
  "device_prefs",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    bucketId: integer("bucket_id").references(() => buckets.id, { onDelete: "set null" }),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.deviceId] })],
);

/**
 * Worklogs deleted in the last 30 days, by the user or gone from their
 * service, kept to be restored (restoring logs them again: a new id on the
 * service). Filled by the database on every delete of a worklog (see the
 * worklog-trash migration), so no delete path can skip it.
 */
export const worklogTrash = pgTable(
  "worklog_trash",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id"),
    worklogUuid: uuid("worklog_uuid").notNull(),
    issueKey: text("issue_key").notNull(),
    started: ms("started").notNull(),
    timeSpentSeconds: integer("time_spent_seconds").notNull(),
    comment: text("comment").notNull().default(""),
    /** Its id on the service when it was deleted (null: never got there) */
    remoteId: text("remote_id"),
    /** "user" (deleted in inkledger) | "remote" (gone from its service) */
    reason: text("reason").notNull(),
    deletedAt: ms("deleted_at").notNull(),
  },
  (t) => [index("idx_worklog_trash_user_deleted").on(t.userId, t.deletedAt)],
);

/**
 * Where a worklog stands on each service it goes to: its id there (null
 * until a queued create lands), its revision, and whether it is in step.
 * The primary sink's row (the worklog's own connection) is kept by the
 * database from the worklog itself (see the worklog-registry migration).
 */
export const worklogSinks = pgTable(
  "worklog_sinks",
  {
    id: serial("id").primaryKey(),
    worklogId: integer("worklog_id")
      .notNull()
      .references(() => worklogs.id, { onDelete: "cascade" }),
    sinkConnectionId: integer("sink_connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    remoteId: text("remote_id"),
    /** "synced" | "pending" | "failed" | "conflict" */
    state: text("state").notNull(),
    /** The service's revision of the entry, when it keeps one */
    version: text("version"),
    lastError: text("last_error"),
    /** Locked on the service (approved, invoiced, period closed…): JSON { cause, message? }; changed there only */
    locked: text("locked"),
    /** In conflict: what the service has now, JSON { seconds, started, comment }, until the user picks */
    remoteSnapshot: text("remote_snapshot"),
    syncedAt: ms("synced_at"),
  },
  (t) => [
    uniqueIndex("uq_worklog_sinks_worklog_sink").on(t.worklogId, t.sinkConnectionId),
    uniqueIndex("uq_worklog_sinks_remote").on(t.sinkConnectionId, t.remoteId),
    index("idx_worklog_sinks_unsynced").on(t.state).where(sql`${t.state} <> 'synced'`),
  ],
);

export const timers = pgTable(
  "timers",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key").notNull(),
    /** "running" | "paused" */
    state: text("state").notNull().default("running"),
    /** Start of the current run segment (meaningful when state = running) */
    startedAt: ms("started_at").notNull(),
    /** Seconds accumulated across previous run/pause segments */
    accumulatedSeconds: integer("accumulated_seconds").notNull().default(0),
    /** When it was last paused / stopped: its worklog ends there */
    pausedAt: ms("paused_at"),
    /** What the user is doing; becomes the worklog comment */
    note: text("note").notNull().default(""),
    /**
     * The device (x-device-id) that controls the timer while it runs: others
     * see it and take it over only on purpose. Null: no device known.
     */
    ownerDevice: text("owner_device"),
    /** How the owner is shown to the others ("Chrome · macOS") */
    ownerLabel: text("owner_label").notNull().default(""),
    /** The owner's lease, renewed by its heartbeat; past it the timer is orphaned (anyone may take it) */
    leaseUntil: ms("lease_until"),
    /** Bumped on every change of state or owner: a client acting on an older view is refused */
    epoch: integer("epoch").notNull().default(0),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_timers_connection_issue").on(t.userId, t.connectionId, t.issueKey)],
);

/**
 * Timer actions already done, by the id the client gave them: a retry or a
 * double click answers the first result instead of acting twice. Kept a day.
 */
export const timerOps = pgTable(
  "timer_ops",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    opId: text("op_id").notNull(),
    /** The JSON answer of the first run */
    result: text("result").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.opId] }), index("idx_timer_ops_created").on(t.createdAt)],
);

export const settings = pgTable("settings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  dailyTargetSeconds: integer("daily_target_seconds").notNull().default(8 * 3600),
  weeklyTargetSeconds: integer("weekly_target_seconds").notNull().default(40 * 3600),
  /** Notify when a timer runs longer than this (minutes). 0 = disabled */
  timerAlertMinutes: integer("timer_alert_minutes").notNull().default(120),
  notifyEnabled: integer("notify_enabled").notNull().default(1),
  /** JSON array of { id, visible } — custom dashboard layout ("" = default) */
  dashboardLayout: text("dashboard_layout").notNull().default(""),
  /** Base colour the UI palette is derived from (src/lib/theme) */
  themeColor: text("theme_color").notNull().default("#B5562F"),
  /** Ask about the away time after this many idle minutes. 0 = disabled */
  idleMinutes: integer("idle_minutes").notNull().default(10),
  /** JSON array of board status names kept collapsed */
  boardCollapsed: text("board_collapsed").notNull().default("[]"),
  /** JSON array of domains whose links open freely (contracts/links.ts) */
  allowedLinkDomains: text("allowed_link_domains").notNull().default("[]"),
  /** How much of an add-on's dashboard backdrop shows: subtle | normal | scenic */
  backdropVisibility: text("backdrop_visibility").notNull().default("normal"),
  /**
   * Time logged over time already logged (parallel work, agents): "warn"
   * says so and lets it be, "block" refuses it.
   */
  overlapPolicy: text("overlap_policy").notNull().default("warn"),
  /** What meets the goals: time logged (parallel work counts twice) or clock time (counted once) */
  /** Night on the Dashboard: a module's light dims the page after dark (1) or never (0) */
  dashboardNight: integer("dashboard_night").notNull().default(1),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type Worklog = typeof worklogs.$inferSelect;
export type Timer = typeof timers.$inferSelect;
/**
 * Offline outbox: worklog operations queued while Jira is unreachable.
 * kind: "create" | "update" | "delete"
 */
export const outbox = pgTable(
  "outbox",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    itemId: itemRef(),
    kind: text("kind").notNull(),
    issueKey: text("issue_key").notNull(),
    /** Real Jira worklog id for update/delete; "" for create */
    remoteId: text("jira_worklog_id").notNull().default(""),
    /** The worklog this operation is about (gone when the worklog is) */
    worklogId: integer("worklog_id").references(() => worklogs.id, { onDelete: "set null" }),
    timeSpentSeconds: integer("time_spent_seconds").notNull().default(0),
    started: ms("started"),
    comment: text("comment").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    /**
     * Set while a replay is sending it to Jira: another server process on the
     * same database (dev + container) skips it instead of posting it twice.
     */
    claimedAt: epochMs("claimed_at"),
    /** A time sink's delete that failed waits until then before its next try (null: now). */
    nextAttemptAt: epochMs("next_attempt_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_outbox_user").on(t.userId), index("idx_outbox_connection_kind").on(t.connectionId, t.kind)],
);

/**
 * Closed weeks: one row per user/week. A closed week is locked against
 * worklog edits until it is reopened (row deleted).
 */
export const weekLocks = pgTable(
  "week_locks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Monday of the week, "YYYY-MM-DD" */
    weekStart: text("week_start").notNull(),
    /** Optional personal note (e.g. "inviato al cliente") */
    note: text("note").notNull().default(""),
    closedAt: ms("closed_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_week_locks_user_week").on(t.userId, t.weekStart)],
);

export type WeekLock = typeof weekLocks.$inferSelect;

/** Named boards ("lavagne") of a user; notes belong to one. */
/**
 * Extra host names the server answers to, added by a signed-in user (the
 * desktop app sharing this server on the Wi-Fi: "<mac>.local", LAN IPs).
 * Global: the host check runs before any session.
 */
/** Server-wide settings set from the app (key → JSON value): device access, backups. */
export const serverSettings = pgTable("server_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: ms("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const serverHosts = pgTable("server_hosts", {
  host: text("host").primaryKey(),
  createdAt: ms("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Private notes on an issue: the user's own comments, written from the issue
 * page and never sent to Jira. One may also hang on a pinboard (pinboard_notes.issue_note_id).
 */
export const issueNotes = pgTable(
  "issue_notes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key").notNull(),
    body: text("body").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_issue_notes_user_issue").on(t.userId, t.issueKey)],
);

export type IssueNote = typeof issueNotes.$inferSelect;

export const pinboards = pgTable(
  "pinboards",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    /**
     * The bucket the board belongs to: shown only while that bucket is on.
     * Null: a board for every bucket. A deleted bucket leaves its boards to
     * every bucket (nothing pinned is lost).
     */
    bucketId: integer("bucket_id").references(() => buckets.id, { onDelete: "set null" }),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_pinboards_user").on(t.userId), index("idx_pinboards_bucket").on(t.bucketId)],
);

export type Pinboard = typeof pinboards.$inferSelect;

/**
 * The Board's lavagna: post-its pinned by hand, free on a fixed canvas.
 * A note may point to an issue or be a free reminder (issue_key null).
 */
export const pinboardNotes = pgTable(
  "pinboard_notes",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The board it is on (null only before the migration that names boards) */
    boardId: integer("board_id").references(() => pinboards.id, { onDelete: "cascade" }),
    /** Set with issue_key (a free note has neither) */
    connectionId: optionalConnectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key"),
    /** A private note hung on the board (its text is the note's; issue_key is its issue) */
    issueNoteId: integer("issue_note_id").references(() => issueNotes.id, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
    /** yellow | pink | blue | green | orange */
    color: text("color").notNull().default("yellow"),
    /** Top-left corner on the canvas, px */
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    /** Slight tilt in degrees, set once */
    rotation: doublePrecision("rotation").notNull().default(0),
    /** Stacking order: the last moved is on top */
    z: integer("z").notNull().default(0),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_pinboard_user").on(t.userId),
    index("idx_pinboard_board").on(t.boardId),
    // A private note hangs at most once on a board.
    uniqueIndex("uq_pinboard_issue_note").on(t.boardId, t.issueNoteId),
  ],
);

export type PinboardNote = typeof pinboardNotes.$inferSelect;

/**
 * Work schedule versions: the schedule (JSON, contracts/workSchedule.ts)
 * in force from `validFrom` until the next version. Past days keep the
 * version of their time, so changing hours never rewrites past weeks.
 */
export const workSchedules = pgTable(
  "work_schedules",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** First day it applies to, "YYYY-MM-DD" */
    validFrom: text("valid_from").notNull(),
    schedule: text("schedule").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_work_schedules_user_from").on(t.userId, t.validFrom)],
);

export type OutboxEntry = typeof outbox.$inferSelect;

export type Settings = typeof settings.$inferSelect;

/** Outcome of the last Jira sync per user (manual or scheduled). */
export const syncState = pgTable("sync_state", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastSyncAt: ms("last_sync_at"),
  lastError: text("last_error"),
  lastErrorAt: ms("last_error_at"),
  /** Last successful full sync (catalog refresh + watchers); null = never */
  lastFullSyncAt: ms("last_full_sync_at"),
  /** Jira's clock at the last worklog sync (changes are read from there); null = never imported */
  lastWorklogSyncAt: ms("last_worklog_sync_at"),
});

export type SyncState = typeof syncState.$inferSelect;

/**
 * Persistent notifications raised by the sync (assignment, priority, due
 * date, watchers). Kept until dismissed; `dedupe` makes inserts idempotent.
 * kind: NotificationKind (contracts/notifications)
 */
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    itemId: itemRef(),
    kind: text("kind").notNull(),
    issueKey: text("issue_key").notNull(),
    /** Kind-specific detail: priority name, due date "YYYY-MM-DD", or "" */
    detail: text("detail").notNull().default(""),
    dedupe: text("dedupe").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    dismissedAt: ms("dismissed_at"),
  },
  (t) => [
    uniqueIndex("uq_notifications_user_dedupe").on(t.userId, t.dedupe),
    index("idx_notifications_user_dismissed").on(t.userId, t.dismissedAt),
  ],
);

export type Notification = typeof notifications.$inferSelect;

/** Add-on module state, per user (host API storage): small JSON values. */
export const moduleStorage = pgTable(
  "module_storage",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moduleId, t.key] })],
);

/**
 * Add-on module files, per user (host API files): pictures a module made on
 * one device and reuses on the others (the Bonsai's renders). A cache, kept
 * small: api/modules/files.ts evicts by last use, by age and on uninstall.
 */
export const moduleFiles = pgTable(
  "module_files",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    key: text("key").notNull(),
    contentType: text("content_type").notNull(),
    data: bytea("data").notNull(),
    size: integer("size").notNull(),
    updatedAt: ms("updated_at").notNull(),
    usedAt: ms("used_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moduleId, t.key] }), index("idx_module_files_used").on(t.usedAt)],
);

/**
 * Keys an issue had before it moved (APP-1 → NEW-1): old links, bookmarks
 * and notifications still find it.
 */
/**
 * Where each sync stream of a connection stands: its checkpoint (opaque,
 * from the adapter), who is syncing it now (a lease, so two processes on one
 * database never sync the same stream at once), when it may run again after
 * a rate limit or an outage, and how the last pass went.
 */
export const connectionSync = pgTable(
  "connection_sync",
  {
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** "issues" | "worklogs" | "entries" */
    stream: text("stream").notNull(),
    checkpoint: text("checkpoint"),
    leaseOwner: text("lease_owner"),
    leaseUntil: ms("lease_until"),
    /** Not before this (a rate limit's Retry-After, or a backoff after failures) */
    retryAfter: ms("retry_after"),
    /** Failures in a row (drives the backoff), 0 after a success */
    failures: integer("failures").notNull().default(0),
    lastOkAt: ms("last_ok_at"),
    lastFullAt: ms("last_full_at"),
    lastError: text("last_error"),
    lastErrorAt: ms("last_error_at"),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.stream] })],
);

export const itemAliases = pgTable(
  "item_aliases",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_item_aliases_item_key").on(t.itemId, t.key), index("idx_item_aliases_key").on(t.key)],
);

/**
 * What changed on an issue (§4.2 Change): a tracker's own history when it
 * gives one is read live; this keeps what inkledger saw change between two
 * syncs (origin "diff"), for trackers without a history and for news.
 */
export const activity = pgTable(
  "activity",
  {
    id: serial("id").primaryKey(),
    itemId: integer("item_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    at: ms("at").notNull(),
    /** Who did it, when the tracker says (null for a seen difference) */
    actor: text("actor"),
    /** status | assignee | priority | summary | category */
    field: text("field").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    /** "diff": seen between two syncs; "native": the tracker's own history */
    origin: text("origin").notNull().default("diff"),
  },
  (t) => [index("idx_activity_item_at").on(t.itemId, t.at)],
);

/**
 * A client (§4.7): who the work is for, across trackers. Its containers
 * (projects, repositories) are its issues; searches (client:), buckets and
 * reports group by it.
 */
export const clients = pgTable(
  "clients",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Other names it is searched by, JSON string array */
    aliases: text("aliases").notNull().default("[]"),
    /** A chart colour token, or "" for the default */
    color: text("color").notNull().default(""),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_clients_user_name").on(t.userId, sql`lower(${t.name})`)],
);

/** A container belongs to one client at most. */
export const clientContainers = pgTable(
  "client_containers",
  {
    clientId: integer("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.containerId] }), uniqueIndex("uq_client_containers_container").on(t.containerId)],
);

// Searches the user keeps (§4.7): saved under a name, and the last ones used.
// Kept in English (formatQuery "en") and shown in the user's language.
export const savedQueries = pgTable(
  "saved_queries",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    query: text("query").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_saved_queries_user_name").on(t.userId, sql`lower(${t.name})`)],
);

export const recentQueries = pgTable(
  "recent_queries",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    usedAt: ms("used_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.query] }), index("idx_recent_queries_user").on(t.userId, t.usedAt)],
);

/** Webhook deliveries already taken, by the service's own id: a replay is refused (kept two days). */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    receivedAt: ms("received_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.deliveryId] }), index("idx_webhook_deliveries_at").on(t.receivedAt)],
);

/**
 * Where a time sink files the time of a tracker's container (project,
 * repository): one of its targets (project/task), with the activity it
 * asks for. A null container is the sink's default for every other one.
 */
export const sinkMappings = pgTable(
  "sink_mappings",
  {
    id: serial("id").primaryKey(),
    sinkConnectionId: integer("sink_connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "cascade" }),
    targetRemoteId: text("target_remote_id").notNull(),
    targetName: text("target_name").notNull().default(""),
    /** JSON [{ remoteId, name }], root first */
    targetPath: text("target_path").notNull().default("[]"),
    activityId: text("activity_id"),
  },
  (t) => [uniqueIndex("uq_sink_mappings").on(t.sinkConnectionId, sql`coalesce(${t.containerId}, 0)`)],
);
