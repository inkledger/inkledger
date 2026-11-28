import {
  uuid,
  pgTable,
  integer,
  boolean,
  bigint,
  serial,
  bigserial,
  text,
  uniqueIndex,
  index,
  doublePrecision,
  customType,
  primaryKey,
  check,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { PlannedKind } from "../contracts/planned";
import type { SyncState as ConnectionStatus } from "../contracts/sync";
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
  /** "admin" | "member"; kept for older builds: "admin" is the owner role (roleId names it too) */
  role: text("role").notNull().default("member"),
  /** The account's server-wide role (roles); null: a member with only its own grants */
  roleId: integer("role_id").references(() => roles.id, { onDelete: "set null" }),
  /** JSON array of Permission (contracts/accounts.ts); an admin has them all */
  permissions: text("permissions").notNull().default("[]"),
  /** JSON array of module ids this account may run (with useModules); an admin runs them all */
  moduleGrants: text("module_grants").notNull().default("[]"),
  /** 1 = the next sign-in must set a new password first (default admin, reset) */
  mustChangePassword: integer("must_change_password").notNull().default(0),
  /** Set when an admin turns the account off: no sign-in, sessions gone */
  disabledAt: ms("disabled_at"),
  /** How the account came: "local" (password, invite), "sso" (made at its first single sign-on), "scim" (provisioned) */
  authSource: text("auth_source").notNull().default("local"),
  /** 1 = keeps password sign-in while single sign-on is enforced (set by an admin; at least one owner while enforcing) */
  breakGlass: integer("break_glass").notNull().default(0),
  /** The identity provider's id for the account (SCIM externalId) */
  externalId: text("external_id"),
  /** 1 = provisioned and managed by SCIM (the identity provider turns it on and off) */
  scimManaged: integer("scim_managed").notNull().default(0),
  /** The userName SCIM knows the account by (often an address; the username is made from it) */
  scimUserName: text("scim_user_name"),
  createdAt: ms("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("uq_users_username").on(sql`lower(${t.username})`),
  uniqueIndex("uq_users_scim_user_name").on(sql`lower(${t.scimUserName})`),
  check("users_auth_source", sql`${t.authSource} IN ('local','sso','scim')`),
]);

/**
 * Named sets of permissions (contracts/accounts.ts). The system ones (owner, it-admin,
 * team-lead, auditor, member) are seeded by their migration and can't be edited or
 * removed. A "team" role applies only within the teams it is assigned for.
 */
export const roles = pgTable(
  "roles",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** JSON array of Permission; the owner role holds every one, whatever is stored */
    permissions: text("permissions").notNull().default("[]"),
    /** "server" | "team" */
    scope: text("scope").notNull().default("server"),
    /** 1 = seeded, read-only */
    system: integer("system").notNull().default(0),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_roles_key").on(t.key), check("roles_scope", sql`${t.scope} IN ('server','team')`)],
);

/** Groups of people: a team lead reads its members' time (team-scoped viewTeamTime). */
export const teams = pgTable(
  "teams",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    /** The identity provider's group id (SCIM), when the team comes from one */
    externalId: text("external_id"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_teams_name").on(sql`lower(${t.name})`), uniqueIndex("uq_teams_external").on(t.externalId)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "member" | "lead" (a lead also holds the team-lead role for the team: role_assignments) */
    role: text("role").notNull().default("member"),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index("idx_team_members_user").on(t.userId), check("team_members_role", sql`${t.role} IN ('member','lead')`)],
);

/** A role held besides users.role_id: within one team, or server-wide (team null). */
export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    teamId: integer("team_id").references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("uq_role_assignments").on(t.userId, t.roleId, sql`coalesce(${t.teamId}, 0)`), index("idx_role_assignments_team").on(t.teamId)],
);

/**
 * A module offered (Settings › Store, manageStore) to one person or one team: it shows in
 * their Store and they buy or request it for themselves (the licence is theirs, they pay).
 * A team's offer reaches its members as they are when they look. contracts/accounts.ts.
 */
export const moduleOffers = pgTable(
  "module_offers",
  {
    id: serial("id").primaryKey(),
    /** The Store product (inkledger.<id>) */
    product: text("product").notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    teamId: integer("team_id").references(() => teams.id, { onDelete: "cascade" }),
    offeredBy: integer("offered_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("module_offers_one", sql`(${t.userId} IS NULL) <> (${t.teamId} IS NULL)`),
    uniqueIndex("uq_module_offers").on(t.product, sql`coalesce(${t.userId}, 0)`, sql`coalesce(${t.teamId}, 0)`),
  ],
);

/**
 * Who each licence on this server belongs to: always one named person (holder), and who
 * paid for it (that person, an admin, or a team) and who bought it. One purchase is one
 * licence for one person; reassigning moves the holder, never copies. A holder gone (erased)
 * frees the seat. Licences from before this table have no row: Settings › Users' grants.
 */
export const moduleLicences = pgTable(
  "module_licences",
  {
    /** The licence id (inside its signed text, in server_settings modules.licenses) */
    licenceId: text("licence_id").primaryKey(),
    product: text("product").notNull(),
    holderUserId: integer("holder_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Who pays: "user" (payer_id a user: the holder themselves, or an admin) or "team" (payer_id a team) */
    payerKind: text("payer_kind").notNull(),
    payerId: integer("payer_id"),
    boughtBy: integer("bought_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    check("module_licences_payer", sql`${t.payerKind} IN ('user','team')`),
    uniqueIndex("uq_module_licences_holder").on(t.product, t.holderUserId),
    index("idx_module_licences_product").on(t.product),
  ],
);

export type RoleRow = typeof roles.$inferSelect;
export type Team = typeof teams.$inferSelect;

/**
 * Identity providers people sign in through (single sign-on): OpenID Connect (Entra ID,
 * Google, Okta, Keycloak…) or SAML 2.0. The client secret is sealed (sealFor "idp:<id>").
 */
export const identityProviders = pgTable(
  "identity_providers",
  {
    id: serial("id").primaryKey(),
    /** "oidc" | "saml" */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** OIDC: the issuer (discovered from it unless discovery_url says otherwise); SAML: the IdP's entity id */
    issuer: text("issuer").notNull().default(""),
    clientId: text("client_id").notNull().default(""),
    clientSecretSealed: text("client_secret_sealed"),
    /** OIDC: where its configuration is read (default: issuer + /.well-known/openid-configuration) */
    discoveryUrl: text("discovery_url"),
    /** Entra ID multi-tenant: the one tenant (tid) accepted */
    tenantId: text("tenant_id"),
    /** SAML: the IdP's sign-in URL (HTTP-Redirect binding) */
    samlEntryPoint: text("saml_entry_point"),
    /** SAML: the IdP's signing certificate(s), PEM */
    samlIdpCert: text("saml_idp_cert"),
    scopes: text("scopes").notNull().default("openid email profile"),
    /** JSON: which claim holds subject, username, email, name, groups */
    claimMap: text("claim_map").notNull().default("{}"),
    /** JSON: [{ group, roleId?, permissions?, teamIds? }] */
    groupMap: text("group_map").notNull().default("[]"),
    /** 1 = an unknown person signing in gets an account (just in time) */
    jitEnabled: integer("jit_enabled").notNull().default(0),
    /** JSON: what an account made here gets when no group maps: { roleId?, permissions?, teamIds? } */
    defaultAccess: text("default_access").notNull().default("{}"),
    /** 1 = everyone signs in through single sign-on, except break-glass accounts */
    enforced: integer("enforced").notNull().default(0),
    disabledAt: ms("disabled_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [check("identity_providers_kind", sql`${t.kind} IN ('oidc','saml')`)],
);

/** An account's identity at a provider: never linked by address, only by the provider's subject. */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => identityProviders.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    emailAtLink: text("email_at_link").notNull().default(""),
    lastLoginAt: ms("last_login_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_user_identities_subject").on(t.providerId, t.subject), index("idx_user_identities_user").on(t.userId)],
);

/** Bearer tokens SCIM provisioning uses: only their hash is kept. */
export const scimTokens = pgTable(
  "scim_tokens",
  {
    id: serial("id").primaryKey(),
    providerId: integer("provider_id")
      .notNull()
      .references(() => identityProviders.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull().default(""),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: ms("last_used_at"),
    revokedAt: ms("revoked_at"),
  },
  (t) => [uniqueIndex("uq_scim_tokens_hash").on(t.tokenHash), index("idx_scim_tokens_provider").on(t.providerId)],
);

/**
 * A sign-in under way at a provider (minutes): keyed by the hash of the OIDC state or the
 * SAML request id (InResponseTo), taken once. Purged with the sessions.
 */
export const ssoStates = pgTable(
  "sso_states",
  {
    id: text("id").primaryKey(),
    providerId: integer("provider_id")
      .notNull()
      .references(() => identityProviders.id, { onDelete: "cascade" }),
    nonce: text("nonce").notNull().default(""),
    pkceVerifier: text("pkce_verifier").notNull().default(""),
    /** Where the browser goes after signing in (a path of this app) */
    relay: text("relay").notNull().default("/"),
    /** "login" | "test" (an admin trying the provider: nobody is signed in) */
    mode: text("mode").notNull().default("login"),
    /** The admin testing (mode "test") */
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ms("expires_at").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_sso_states_expires").on(t.expiresAt)],
);

export type IdentityProvider = typeof identityProviders.$inferSelect;

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
    /** "ok" | "auth_failed" | "unreadable" | "unreachable" (out of reach SYNC_GIVE_UP_AFTER times: background sync paused until the user's own Sync) */
    status: text("status").$type<ConnectionStatus>().notNull().default("ok"),
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

/**
 * Where a project's code is on the user's computer (an app, its server…): what
 * "Analyse" hands to a coding agent. Only ever copied into a command, never read here.
 */
export const containerPaths = pgTable(
  "container_paths",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    /** What it is to the user: "app", "server" */
    label: text("label").notNull().default(""),
    path: text("path").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    uniqueIndex("uq_container_paths").on(t.userId, t.containerId, t.path),
    index("idx_container_paths_user").on(t.userId, t.containerId, t.position),
    check("container_paths_path", sql`length(${t.path}) BETWEEN 1 AND 1000`),
    check("container_paths_label", sql`length(${t.label}) <= 60`),
  ],
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
    /** RemoteIssue.status.id, filled by the sync: the identity estimates read history by (the name can be renamed) */
    statusId: text("status_id"),
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
    /** Labels (Jira's, a repository's…), as JSON string array */
    labels: text("labels").notNull().default("[]"),
    /** Components (Jira's: a project's parts), as JSON string array */
    components: text("components").notNull().default("[]"),
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
export const plannedEntries = pgTable(
  "planned_entries",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "work" | "travel" | "vacation" */
    kind: text("kind").$type<PlannedKind>().notNull(),
    startsAt: ms("starts_at").notNull(),
    /** Exclusive: duration is always endsAt - startsAt. */
    endsAt: ms("ends_at").notNull(),
    note: text("note"),
    connectionId: optionalConnectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key"),
    convertedWorklogId: integer("converted_worklog_id").references(() => worklogs.id, { onDelete: "set null" }),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_planned_entries_user_interval").on(t.userId, t.startsAt, t.endsAt),
    index("idx_planned_entries_issue").on(t.userId, t.connectionId, t.issueKey),
    uniqueIndex("uq_planned_entries_converted_worklog").on(t.convertedWorklogId),
    check("planned_entries_kind", sql`${t.kind} IN ('work', 'travel', 'vacation')`),
    check("planned_entries_interval", sql`${t.endsAt} > ${t.startsAt}`),
    check("planned_entries_issue_has_connection", sql`${t.issueKey} IS NULL OR ${t.connectionId} IS NOT NULL`),
    check("planned_entries_work_has_issue", sql`${t.kind} <> 'work' OR (${t.connectionId} IS NOT NULL AND ${t.issueKey} IS NOT NULL)`),
    check("planned_entries_vacation_user_level", sql`${t.kind} <> 'vacation' OR (${t.connectionId} IS NULL AND ${t.itemId} IS NULL AND ${t.issueKey} IS NULL)`),
  ],
);

export type PlannedEntry = typeof plannedEntries.$inferSelect;

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
    /** Synced: when the service last took it. Not synced yet: when its create was first sent (an answer lost is looked for after it) */
    syncedAt: ms("synced_at"),
    /** Raised by every change of the worklog: a push marks it synced only if none came while it was sending */
    revision: integer("revision").notNull().default(0),
    /** Day-total sinks: the day last set for it (moved to another day, that one is set again too) */
    pushedDay: text("pushed_day"),
    /** A sink pass (of any server process on this database) is sending it: others skip it until then, or past the lease */
    claimedAt: epochMs("claimed_at"),
    /** Not on the sink yet, where it keeps no key: what its create last sent (an answer lost is looked for by these) */
    sentSeconds: integer("sent_seconds"),
    sentStarted: ms("sent_started"),
    sentComment: text("sent_comment"),
    /** Not on the sink yet: when its create was last sent (a lost one is looked for up to shortly after) */
    lastSentAt: ms("last_sent_at"),
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

/**
 * When each timer actually ran: timers run side by side, and the time two ran
 * together is shared out at their logs (contracts/timerSplit.ts). By issue, not
 * by timer row: a run outlives its timer (gone once logged) while another timer
 * that ran with it is still to be logged.
 */
export const timerRuns = pgTable(
  "timer_runs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    issueKey: text("issue_key").notNull(),
    startedAt: ms("started_at").notNull(),
    /** Null while it runs */
    endedAt: ms("ended_at"),
    /** Taken by a log: kept only while it shares time with a run not logged yet */
    loggedAt: ms("logged_at"),
  },
  (t) => [
    index("idx_timer_runs_user_start").on(t.userId, t.startedAt),
    uniqueIndex("uq_timer_runs_open").on(t.userId, t.connectionId, t.issueKey).where(sql`${t.endedAt} IS NULL`),
  ],
);

/** The share a timer's log took of a stretch it ran together with others: the next one's default is what is left. */
export const timerShares = pgTable(
  "timer_shares",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: connectionRef(),
    issueKey: text("issue_key").notNull(),
    startedAt: ms("started_at").notNull(),
    endedAt: ms("ended_at").notNull(),
    /** In basis points: 6000 = 60 % */
    shareBp: integer("share_bp").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_timer_shares_user_start").on(t.userId, t.startedAt)],
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
  /** The palette's family (src/lib/theme): standard | soft (low glare) */
  themeVariant: text("theme_variant").notNull().default("standard"),
  /** Contrast level: normal | high | system (follows prefers-contrast) */
  themeContrast: text("theme_contrast").notNull().default("system"),
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
  /** Where the pinboard lives, each on (1) or off (0): the Board's panel, its own page in the menu, a floating widget */
  pinboardOnBoard: integer("pinboard_on_board").notNull().default(1),
  pinboardInMenu: integer("pinboard_in_menu").notNull().default(1),
  pinboardWidget: integer("pinboard_widget").notNull().default(1),
  /** Where the TODO list lives, each on (1) or off (0): its page in the menu, a floating widget (D), the bottom-right hot corner */
  todosInMenu: integer("todos_in_menu").notNull().default(1),
  todosWidget: integer("todos_widget").notNull().default(1),
  todosHotCorner: integer("todos_hot_corner").notNull().default(1),
  /** How long an issue copied for an agent keeps its attachment links open by default (minutes, ≤ a day) */
  shareLinkMinutes: integer("share_link_minutes").notNull().default(60),
  /** Raised by "Revoke all links": links signed with an older one stop working */
  shareLinkGeneration: integer("share_link_generation").notNull().default(0),
  /** Copies of the mails I pin (docs/work/ideas/mail-copies.md): off | body | full */
  mailCopies: text("mail_copies").notNull().default("off"),
  /** When I agreed to keep copies (asked once, in a dialog) */
  mailCopiesConsentAt: ms("mail_copies_consent_at"),
  /** "Analyse" on an issue: the agent command copied, run in the project's repositories (contracts/analyze.ts) */
  agentCommand: text("agent_command").notNull().default("claude"),
}, (t) => [
  check("settings_share_link_minutes", sql`${t.shareLinkMinutes} BETWEEN 5 AND 1440`),
  check("settings_agent_command", sql`length(${t.agentCommand}) BETWEEN 1 AND 200`),
  check("settings_mail_copies", sql`${t.mailCopies} IN ('off', 'body', 'full')`),
  check("settings_theme_variant", sql`${t.themeVariant} IN ('standard', 'soft')`),
  check("settings_theme_contrast", sql`${t.themeContrast} IN ('normal', 'high', 'system')`),
]);

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
    /**
     * A delete of a create whose answer was lost (no id there: remote id ""): the entry
     * is looked for by the values sent, among those made after this and before landedBefore.
     */
    landedAfter: ms("landed_after"),
    /**
     * A queued create: its first send's time less the adopt window (landedAfter) and its last
     * send's plus it (this), null while never sent. A lost create's delete: the same, copied.
     */
    landedBefore: ms("landed_before"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_outbox_user").on(t.userId),
    index("idx_outbox_connection_kind").on(t.connectionId, t.kind),
    // A worklog's queued operations (held sink deletes, pending changes), and the
    // ON DELETE SET NULL every worklog delete runs here. Rows tied to no worklog
    // (sink deletes due) are never looked up by it: left out.
    index("idx_outbox_worklog").on(t.worklogId).where(sql`${t.worklogId} IS NOT NULL`),
  ],
);

/**
 * A user's time writes one at a time across every server process on this database (overlap,
 * closed weeks, a timer's time): held by one write, others wait; a holder that died lets go
 * once expiresAt passes. The tracker's call happens under it, so no database lock is held.
 */
export const writeLeases = pgTable("write_leases", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  holder: text("holder").notNull(),
  expiresAt: epochMs("expires_at").notNull(),
});

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

export const markdownNotes = pgTable(
  "markdown_notes",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    /** note | folder (contracts/notes.ts): a folder only groups, with a title and no text, issue or versions */
    kind: text("kind").notNull().default("note"),
    position: integer("position").notNull().default(0),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    contentRevision: integer("content_revision").notNull().default(1),
    bodyText: text("body_text").notNull().default(""),
    searchTitle: text("search_title").notNull().default(""),
    searchText: text("search_text").notNull().default(""),
    connectionId: optionalConnectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key"),
    /** The note's own day, local "YYYY-MM-DD" (a meeting's, written the day after); null for folders */
    notedOn: text("noted_on"),
    /** "Tidy up with AI": the AI's copy beside the text, until kept (it becomes the body) or discarded */
    aiBody: text("ai_body"),
    /** The body's revision the AI copy was made from (another: the text changed since) */
    aiSourceRevision: integer("ai_source_revision"),
    aiCreatedAt: ms("ai_created_at"),
    deletedAt: ms("deleted_at"),
    deleteBatch: uuid("delete_batch"),
    deleteRootId: uuid("delete_root_id"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_markdown_notes_id_user").on(t.id, t.userId),
    foreignKey({ columns: [t.parentId, t.userId], foreignColumns: [t.id, t.userId], name: "markdown_notes_parent_user_fk" }),
    index("idx_markdown_notes_active_tree").on(t.userId, t.parentId, t.position, t.id).where(sql`${t.deletedAt} IS NULL`),
    index("idx_markdown_notes_user_issue").on(t.userId, t.connectionId, t.issueKey),
    index("idx_markdown_notes_trash").on(t.userId, t.deleteBatch, t.deletedAt).where(sql`${t.deletedAt} IS NOT NULL`),
    index("idx_markdown_notes_noted_on").on(t.userId, t.notedOn).where(sql`${t.deletedAt} IS NULL`),
    index("idx_markdown_notes_search")
      .using("gin", sql`(setweight(to_tsvector('simple', ${t.searchTitle}), 'A') || setweight(to_tsvector('simple', ${t.searchText}), 'B'))`)
      .where(sql`${t.deletedAt} IS NULL`),
    check("markdown_notes_issue_has_connection", sql`${t.issueKey} IS NULL OR ${t.connectionId} IS NOT NULL`),
    check("markdown_notes_kind", sql`${t.kind} IN ('note', 'folder')`),
  ],
);

export const markdownNoteVersions = pgTable(
  "markdown_note_versions",
  {
    id: uuid("id").notNull().defaultRandom().primaryKey(),
    noteId: uuid("note_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    contentRevision: integer("content_revision").notNull(),
    origin: text("origin").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    foreignKey({ columns: [t.noteId, t.userId], foreignColumns: [markdownNotes.id, markdownNotes.userId], name: "markdown_note_versions_note_user_fk" }).onDelete("cascade"),
    index("idx_markdown_note_versions_note_created").on(t.noteId, t.createdAt, t.id),
    index("idx_markdown_note_versions_created").on(t.createdAt),
    check("markdown_note_versions_origin", sql`${t.origin} IN ('auto', 'manual', 'conflict', 'delete', 'restore', 'ai')`),
  ],
);

export type MarkdownNote = typeof markdownNotes.$inferSelect;

/**
 * A mail pinned somewhere (contracts/mail.ts): its headers and the link back to it in
 * Outlook, never its body. One row per message and user, wherever it is pinned.
 */
export const mails = pgTable(
  "mails",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: text("subject").notNull().default(""),
    fromName: text("from_name"),
    fromAddress: text("from_address"),
    receivedAt: ms("received_at"),
    /** Opens the message in Outlook (null: pinned from a file, no link known) */
    webLink: text("web_link"),
    /** The Message-ID header: the same mail whatever client it came from */
    internetMessageId: text("internet_message_id"),
    /** Exchange's id of the message (REST form): may change when the mail moves folder */
    exchangeId: text("exchange_id"),
    /** link | eml | addin | graph */
    source: text("source").notNull(),
    /** Not found in the mailbox any more (Graph check); null while it is */
    goneAt: ms("gone_at"),
    /** Last looked for in the mailbox */
    checkedAt: ms("checked_at"),
    /** The signed-in mailbox it was found in (its account, lower case); null: not known to be there */
    mailbox: text("mailbox"),
    /** Why its copy couldn't be made (the pin stands) */
    copyError: text("copy_error"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_mails_user_recent").on(t.userId, t.updatedAt),
    uniqueIndex("uq_mails_user_message").on(t.userId, t.internetMessageId).where(sql`${t.internetMessageId} IS NOT NULL`),
    uniqueIndex("uq_mails_user_exchange").on(t.userId, t.exchangeId).where(sql`${t.exchangeId} IS NOT NULL`),
    check("mails_source", sql`${t.source} IN ('link', 'eml', 'addin', 'graph')`),
  ],
);

/** An encrypted copy of a pinned mail (docs/work/ideas/mail-copies.md R-1.3–R-1.5): one per mail, gone with it. */
export const mailCopies = pgTable(
  "mail_copies",
  {
    mailId: integer("mail_id")
      .primaryKey()
      .references(() => mails.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** body: headers, text, html, attachment list (JSON) | full: the raw EML */
    mode: text("mode").notNull(),
    /** sealBytesFor(plain, `mailcopy:${userId}:${mailId}`) */
    sealed: bytea("sealed").notNull(),
    plainSha256: text("plain_sha256").notNull(),
    plainBytes: integer("plain_bytes").notNull(),
    /** JSON [{ name, type, size }]: the attachments, listed without opening the copy */
    attachments: text("attachments").notNull().default("[]"),
    /** When the daily purge first found its mail pinned nowhere (cleared when pinned again); gone 7 days later (R-1.10) */
    orphanedAt: ms("orphaned_at"),
    /** addin | graph | eml */
    source: text("source").notNull(),
    capturedAt: ms("captured_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_mail_copies_user").on(t.userId, t.capturedAt),
    check("mail_copies_mode", sql`${t.mode} IN ('body', 'full')`),
    check("mail_copies_source", sql`${t.source} IN ('addin', 'graph', 'eml')`),
  ],
);

/** Every read of a copy (R-1.9), kept a year. */
export const mailCopyReads = pgTable(
  "mail_copy_reads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailId: integer("mail_id")
      .notNull()
      .references(() => mails.id, { onDelete: "cascade" }),
    /** view | eml | attachment */
    via: text("via").notNull(),
    at: ms("at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_mail_copy_reads_at").on(t.at), check("mail_copy_reads_via", sql`${t.via} IN ('view', 'eml', 'attachment')`)],
);

export type Mail = typeof mails.$inferSelect;

/** Where a mail is pinned: an issue or a Markdown note (TODOs and post-its point at the mail themselves). */
export const mailLinks = pgTable(
  "mail_links",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailId: integer("mail_id")
      .notNull()
      .references(() => mails.id, { onDelete: "cascade" }),
    /** Set with issue_key */
    connectionId: optionalConnectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key"),
    noteId: uuid("note_id"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    foreignKey({ columns: [t.noteId, t.userId], foreignColumns: [markdownNotes.id, markdownNotes.userId], name: "mail_links_note_user_fk" }).onDelete("cascade"),
    uniqueIndex("uq_mail_links_issue").on(t.mailId, t.connectionId, t.issueKey).where(sql`${t.issueKey} IS NOT NULL`),
    uniqueIndex("uq_mail_links_note").on(t.mailId, t.noteId).where(sql`${t.noteId} IS NOT NULL`),
    index("idx_mail_links_user_issue").on(t.userId, t.connectionId, t.issueKey),
    index("idx_mail_links_note").on(t.noteId),
    check("mail_links_issue_has_connection", sql`${t.issueKey} IS NULL OR ${t.connectionId} IS NOT NULL`),
    check("mail_links_one_target", sql`(${t.issueKey} IS NOT NULL) <> (${t.noteId} IS NOT NULL)`),
  ],
);

/** A user's Microsoft sign-in, to search their mailbox (Graph, Mail.Read): one per user, the tokens sealed. */
export const mailAccounts = pgTable("mail_accounts", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The account signed in (user principal name) */
  account: text("account").notNull(),
  displayName: text("display_name"),
  /** The token set, sealed for this user (api/lib/crypto.ts) */
  secret: text("secret").notNull(),
  createdAt: ms("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: ms("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Every host the server has called out to (api/lib/egress.ts), for Settings →
 * Network: what leaves the server, how often, and how it went. Hosts only:
 * never a path, a query or a body. */
export const egressHosts = pgTable("egress_hosts", {
  host: text("host").primaryKey(),
  calls: integer("calls").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  /** The last answer's status, or "error" when no answer came */
  lastStatus: text("last_status"),
  firstAt: ms("first_at").notNull(),
  lastAt: ms("last_at").notNull(),
});

/** The key the Outlook add-in pins with: it opens mails.* only; deleting it revokes it. */
export const mailAddinKeys = pgTable(
  "mail_addin_keys",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 of the key: the key itself is shown once */
    keyHash: text("key_hash").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: ms("last_used_at"),
  },
  (t) => [uniqueIndex("uq_mail_addin_keys_hash").on(t.keyHash), index("idx_mail_addin_keys_user").on(t.userId)],
);
export type MarkdownNoteVersion = typeof markdownNoteVersions.$inferSelect;

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
    /**
     * A board that follows a tag: "label" or "component", and its value (null:
     * a board pinned by hand). It shows the user's open issues with that tag,
     * on one tracker or on every one (null), and nothing is pinned on it.
     */
    followField: text("follow_field"),
    followValue: text("follow_value"),
    /** Its tracker: removed with it (never widened to every tracker). */
    followConnectionId: integer("follow_connection_id").references(() => connections.id, { onDelete: "cascade" }),
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
    /** A TODO hung on the board (its text is the TODO's; its issue is read through it, issue_key stays null) */
    todoId: integer("todo_id").references((): AnyPgColumn => todos.id, { onDelete: "cascade" }),
    /** A pinned mail hung on the board (its subject is the mail's) */
    mailId: integer("mail_id").references(() => mails.id, { onDelete: "cascade" }),
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
    // A TODO too.
    uniqueIndex("uq_pinboard_todo").on(t.boardId, t.todoId),
    // A mail too.
    uniqueIndex("uq_pinboard_mail").on(t.boardId, t.mailId),
  ],
);

export type PinboardNote = typeof pinboardNotes.$inferSelect;

/**
 * The user's TODO list: things to do, each planned for a day or not, and
 * tied (or not) to an issue, one of its comments (the tracker's id and a
 * snapshot of its text) or one of the user's private notes on it.
 */
export const todos = pgTable(
  "todos",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** The day it is planned for, "YYYY-MM-DD" in the user's zone (null: someday) */
    dueOn: text("due_on"),
    doneAt: ms("done_at"),
    /** Order within its list, by hand (smaller first) */
    position: integer("position").notNull().default(0),
    /** Set with issue_key (a TODO of its own has neither); the server always sets it */
    connectionId: optionalConnectionRef(),
    itemId: itemRef(),
    issueKey: text("issue_key"),
    /** A comment on the issue: the tracker's id, and its first words as they were */
    commentId: text("comment_id"),
    commentExcerpt: text("comment_excerpt"),
    issueNoteId: integer("issue_note_id").references(() => issueNotes.id, { onDelete: "set null" }),
    /** The mail it is about (e.g. "answer this"); gone with the mail */
    mailId: integer("mail_id").references(() => mails.id, { onDelete: "set null" }),
    /** The day its reminder was put away (shown again the next day it is due or late) */
    reminderSeenOn: text("reminder_seen_on"),
    /** 0 normal, 1 high (contracts/todo.ts) */
    priority: integer("priority").notNull().default(0),
    /** How long it should take, seconds (null: not said) */
    estimateSeconds: integer("estimate_seconds"),
    /** Its checklist, JSON: [{ id, text, done }] (contracts/todo.ts parseSteps) */
    steps: text("steps").notNull().default("[]"),
    /** daily | weekdays | weekly: ticked, it comes back (null: once) */
    repeat: text("repeat"),
    /** The ticked TODO this one came back from (unticking it takes this one away again) */
    repeatOf: integer("repeat_of").references((): AnyPgColumn => todos.id, { onDelete: "set null" }),
    /** What suggested it (an issue's news, once per news): never suggested twice */
    source: text("source"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_todos_user_open").on(t.userId, t.doneAt, t.dueOn),
    index("idx_todos_user_issue").on(t.userId, t.issueKey),
    uniqueIndex("uq_todos_user_source").on(t.userId, t.source).where(sql`${t.source} IS NOT NULL`),
    check("todos_issue_has_connection", sql`${t.issueKey} IS NULL OR ${t.connectionId} IS NOT NULL`),
  ],
);

/**
 * Time spent on a TODO, kept beside the real time and never counted as it:
 * a stretch of work on it. Linked: the TODO's issue timer ran meanwhile (that
 * timer's time is the real one); not linked: a TODO with no issue, whose time
 * shows the gap no issue covers. Kept when the TODO goes (with its words).
 */
export const todoSessions = pgTable(
  "todo_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    todoId: integer("todo_id").references(() => todos.id, { onDelete: "set null" }),
    /** The TODO's text when the stretch began */
    label: text("label").notNull(),
    /** 1 = its issue's timer ran with it */
    linked: integer("linked").notNull().default(0),
    startedAt: ms("started_at").notNull(),
    /** null while it runs */
    endedAt: ms("ended_at"),
  },
  (t) => [
    index("idx_todo_sessions_user_start").on(t.userId, t.startedAt),
    index("idx_todo_sessions_todo").on(t.todoId),
    // One stretch at a time per user.
    uniqueIndex("uq_todo_sessions_open").on(t.userId).where(sql`${t.endedAt} IS NULL`),
  ],
);

export type TodoSession = typeof todoSessions.$inferSelect;

export type Todo = typeof todos.$inferSelect;

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

/**
 * Hours of a single day (JSON WorkDay, contracts/workScheduleSchema.ts):
 * on `day` they replace that weekday's hours of the version in force
 * (a late lunch, a day off), past or future.
 */
export const workDayOverrides = pgTable(
  "work_day_overrides",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The day, "YYYY-MM-DD" */
    day: text("day").notNull(),
    workDay: text("work_day").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("uq_work_day_overrides_user_day").on(t.userId, t.day)],
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
    /** Null only for a server alert (kind "alert": a backup, a licence, the certificate), which is about no tracker */
    connectionId: optionalConnectionRef(),
    itemId: itemRef(),
    kind: text("kind").notNull(),
    issueKey: text("issue_key").notNull(),
    /** Kind-specific detail: priority name, due date "YYYY-MM-DD", an alert's JSON, or "" */
    detail: text("detail").notNull().default(""),
    dedupe: text("dedupe").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    dismissedAt: ms("dismissed_at"),
    /** Seen in the app (opened in the preview, or marked read): local only, the tracker's inbox is read on dismiss */
    readAt: ms("read_at"),
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
    /** Bumped on every write: a module may write only over the value it read (storage.update). */
    revision: integer("revision").notNull().default(0),
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
 * Each time an issue of the user moved into done, once (a database trigger on
 * issues, whatever wrote it: sync, webhook, own transition): modules hear
 * closures that happened while the app was closed.
 */
export const issueClosures = pgTable(
  "issue_closures",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemId: integer("item_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** When it was closed (epoch ms): its tracker's time when it moved, else when it was seen */
    closedAt: epochMs("closed_at").notNull(),
    /** 1 = assigned to the user (their account on the connection) when it closed: only those count for modules */
    assigned: integer("assigned").notNull().default(0),
  },
  (t) => [uniqueIndex("uq_issue_closures_item_at").on(t.itemId, t.closedAt), index("idx_issue_closures_user_at").on(t.userId, t.closedAt)],
);

/** The closures a module was already told, per user: each one told once. */
export const moduleClosureClaims = pgTable(
  "module_closure_claims",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    moduleId: text("module_id").notNull(),
    closureId: integer("closure_id")
      .notNull()
      .references(() => issueClosures.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moduleId, t.closureId] })],
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

/**
 * Desks (contracts/desk.ts): issues side by side. The one without a name is the
 * user's current desk (one each); named ones are kept to reopen.
 */
export const desks = pgTable(
  "desks",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** null: the current desk */
    name: text("name"),
    /** JSON DeskLayout, normalized before it is stored */
    layout: text("layout").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_desks_user_current").on(t.userId).where(sql`${t.name} IS NULL`),
    uniqueIndex("uq_desks_user_name").on(t.userId, sql`lower(${t.name})`).where(sql`${t.name} IS NOT NULL`),
  ],
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

// ---------- Estimates: status history (docs/work/ideas/estimates.md) ----------

/** An issue's status history read (R-3.4, R-3.12). */
export const issueHistoryReads = pgTable(
  "issue_history_reads",
  {
    itemId: integer("item_id")
      .primaryKey()
      .references(() => issues.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** available | pending | unsupported | stale | retry | invalid */
    state: text("state").notNull(),
    /** Raised by every write of this row: a read writes only over the generation it saw */
    generation: integer("generation").notNull().default(0),
    readAt: ms("read_at"),
    /** The issue's remoteUpdatedAt and status_id when it was read: later ones make it stale */
    sourceUpdatedAt: epochMs("source_updated_at"),
    statusIdAtRead: text("status_id_at_read"),
    changes: integer("changes").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ms("next_attempt_at"),
    /** Why it is invalid or failed (a code, never tracker content) */
    reason: text("reason"),
  },
  (t) => [
    index("idx_issue_history_reads_due").on(t.userId, t.state, t.nextAttemptAt),
    check("issue_history_reads_state", sql`${t.state} IN ('available','pending','unsupported','stale','retry','invalid')`),
  ],
);

/** A status the user set apart from the provider's default (R-3.14), by remote status id. */
export const workStatuses = pgTable(
  "work_statuses",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    statusId: text("status_id").notNull(),
    counts: integer("counts").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.connectionId, t.statusId] })],
);

/** An issue's status changes as its tracker returned them (R-3.11): ids, in (at, ordinal) order. Replaced whole by each read. */
export const issueStatusChanges = pgTable(
  "issue_status_changes",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** The change's index in the order the tracker returned the history: ties on `at` keep it */
    ordinal: integer("ordinal").notNull(),
    at: ms("at").notNull(),
    /** Remote status ids; null `from` only on the first change (which then makes the history invalid) */
    fromStatusId: text("from_status_id"),
    toStatusId: text("to_status_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.ordinal] }), index("idx_issue_status_changes_order").on(t.itemId, t.at, t.ordinal)],
);

/** A status as last seen on its tracker (R-3.13): a status deleted since stays readable. */
export const statusSnapshots = pgTable(
  "status_snapshots",
  {
    connectionId: integer("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    statusId: text("status_id").notNull(),
    name: text("name").notNull(),
    /** contracts/providers.ts STATUS_CATEGORIES */
    category: text("category").notNull(),
    seenAt: ms("seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.statusId] })],
);

/** What any estimate of the user depends on; raised by every write that changes one (R-3.15). */
export const estimateRevisions = pgTable("estimate_revisions", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  revision: bigint("revision", { mode: "bigint" }).notNull().default(sql`0`),
});

// ---------- Triage: ideas waiting to become issues (docs/work/ideas/triage.md) ----------

export const ideas = pgTable(
  "ideas",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Markdown */
    body: text("body").notNull().default(""),
    /** contracts/ideas.ts IDEA_STATES */
    state: text("state").notNull().default("raw"),
    /** me | agent | ask (null: not chosen) */
    route: text("route"),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
    /** Order within its state (smaller first) */
    position: integer("position").notNull().default(0),
    /** JSON [{ id, text }] (≤ 20) */
    acceptance: text("acceptance").notNull().default("[]"),
    /** JSON [{ id, text, answer, blocking }] (≤ 20) */
    questions: text("questions").notNull().default("[]"),
    /** JSON string[] (≤ 20) */
    labels: text("labels").notNull().default("[]"),
    estimateSeconds: integer("estimate_seconds"),
    /** The issue it came from (a vague one sent to triage) */
    sourceConnectionId: integer("source_connection_id").references(() => connections.id),
    sourceItemId: integer("source_item_id").references(() => issues.id, { onDelete: "set null" }),
    sourceIssueKey: text("source_issue_key"),
    /** The mail it came from */
    mailId: integer("mail_id").references(() => mails.id, { onDelete: "set null" }),
    /** The issue it became */
    promotedConnectionId: integer("promoted_connection_id").references(() => connections.id),
    promotedItemId: integer("promoted_item_id").references(() => issues.id, { onDelete: "set null" }),
    promotedIssueKey: text("promoted_issue_key"),
    promotedAt: ms("promoted_at"),
    discardedReason: text("discarded_reason"),
    deletedAt: ms("deleted_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_ideas_user_state").on(t.userId, t.state, t.position),
    uniqueIndex("uq_ideas_open_source")
      .on(t.userId, t.sourceConnectionId, t.sourceIssueKey)
      .where(sql`${t.sourceIssueKey} IS NOT NULL AND ${t.state} NOT IN ('promoted','discarded') AND ${t.deletedAt} IS NULL`),
    check("ideas_state", sql`${t.state} IN ('raw','refining','ready','promoted','discarded')`),
    check("ideas_route", sql`${t.route} IS NULL OR ${t.route} IN ('me','agent','ask')`),
    check("ideas_source_has_connection", sql`${t.sourceIssueKey} IS NULL OR ${t.sourceConnectionId} IS NOT NULL`),
    check("ideas_promoted_has_connection", sql`${t.promotedIssueKey} IS NULL OR ${t.promotedConnectionId} IS NOT NULL`),
  ],
);

/** Pictures in an idea's text (`![name](idea-file:<id>)`): sealed bytes, gone with the idea. */
export const ideaFiles = pgTable(
  "idea_files",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ideaId: integer("idea_id")
      .notNull()
      .references(() => ideas.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Read from the bytes when it came, never the browser's word */
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("idx_idea_files_idea").on(t.ideaId), index("idx_idea_files_user").on(t.userId), check("idea_files_name", sql`length(${t.name}) BETWEEN 1 AND 200`)],
);

/**
 * Feedback about the app (contracts/feedback.ts), kept on this server: what its author sent
 * and where it stands. Shared with inkledger's developers only when the server allows it
 * and its author ticked the consent (api/feedback/upstream.ts).
 */
export const feedback = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    /** Its id outside this table: the one sent upstream, and the screenshot's sealing scope */
    uid: uuid("uid").notNull().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** contracts/feedback.ts FEEDBACK_TYPES */
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** The page it was sent from (path, as seen here; only its shape ever leaves) */
    page: text("page").notNull().default(""),
    appVersion: text("app_version").notNull().default(""),
    /** Theme, variant and contrast it was seen in, e.g. "dark·soft·normal" */
    look: text("look").notNull().default(""),
    density: text("density").notNull().default(""),
    /** contracts/feedback.ts FEEDBACK_STATUSES */
    status: text("status").notNull().default("new"),
    /** Why it was rejected */
    statusReason: text("status_reason"),
    /** Sealed for the row (scope feedback-shot:uid) */
    screenshot: bytea("screenshot"),
    screenshotType: text("screenshot_type"),
    /** Its author agreed to send it to inkledger's developers (and the screenshot with it) */
    shareConsent: integer("share_consent").notNull().default(0),
    shareScreenshot: integer("share_screenshot").notNull().default(0),
    /** contracts/feedback.ts FEEDBACK_SHARE_STATES; null: not shared */
    shareState: text("share_state"),
    sharedAt: ms("shared_at"),
    /** The developers' state last read back: applied here only when it changes */
    upstreamStatus: text("upstream_status"),
    /** Accepted by the developers and made public: its public issue and draft proposal (https://github.com/… only) */
    publicIssueUrl: text("public_issue_url"),
    /** open | closed */
    publicIssueState: text("public_issue_state"),
    publicPrUrl: text("public_pr_url"),
    /** open | merged | closed (merged reads as implemented) */
    publicPrState: text("public_pr_state"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_feedback_uid").on(t.uid),
    index("idx_feedback_user").on(t.userId, t.createdAt),
    index("idx_feedback_share").on(t.shareState),
    check("feedback_type", sql`${t.type} IN ('problem', 'idea', 'improvement')`),
    check("feedback_status", sql`${t.status} IN ('new', 'discussion', 'accepted', 'in_progress', 'implemented', 'rejected')`),
    check("feedback_share_state", sql`${t.shareState} IS NULL OR ${t.shareState} IN ('queued', 'sent', 'refused')`),
    check("feedback_title", sql`length(${t.title}) BETWEEN 1 AND 200`),
  ],
);

export type Feedback = typeof feedback.$inferSelect;

/** A feedback's thread: its author and the admins writing, the developers' replies, every change of state. */
export const feedbackComments = pgTable(
  "feedback_comments",
  {
    id: serial("id").primaryKey(),
    feedbackId: integer("feedback_id")
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
    /** Who wrote it; null for the developers' replies, or once its writer's account is erased */
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    /** contracts/feedback.ts FEEDBACK_ORIGINS */
    origin: text("origin").notNull(),
    body: text("body").notNull().default(""),
    /** A change of state: from and to */
    statusFrom: text("status_from"),
    statusTo: text("status_to"),
    /** The developers' comment it copies (never twice) */
    upstreamId: text("upstream_id"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_feedback_comments_feedback").on(t.feedbackId, t.createdAt),
    uniqueIndex("uq_feedback_comments_upstream").on(t.feedbackId, t.upstreamId),
    check("feedback_comments_origin", sql`${t.origin} IN ('user', 'admin', 'upstream', 'status')`),
  ],
);


/**
 * A chat about an issue between teammates on this server (contracts/chat.ts). Every user keeps
 * their own copy of an issue, so a thread is anchored to the issue's identity on its tracker
 * (type, base URL, the tracker's stable id), not to anyone's row; the key and the rest are a
 * snapshot for lists, refreshed as members open it.
 */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: serial("id").primaryKey(),
    uid: uuid("uid").notNull().defaultRandom(),
    /** Who opened it; null once their account is erased */
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    /** connections.type and connections.base_url (normalized) of the tracker it lives on */
    trackerType: text("tracker_type").notNull(),
    trackerBase: text("tracker_base").notNull(),
    /** issues.jira_id on that tracker: stable when the issue moves */
    issueRemoteId: text("issue_remote_id").notNull(),
    issueKey: text("issue_key").notNull(),
    issueTitle: text("issue_title").notNull().default(""),
    issueStatus: text("issue_status").notNull().default(""),
    /** The canonical category (StatusCategory) */
    issueCategory: text("issue_category").notNull().default(""),
    /** contracts/chat.ts CHAT_THREAD_STATES */
    state: text("state").notNull().default("open"),
    resolvedBy: integer("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ms("resolved_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    lastMessageAt: ms("last_message_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_chat_threads_uid").on(t.uid),
    index("idx_chat_threads_issue").on(t.trackerType, t.trackerBase, t.issueRemoteId),
    check("chat_threads_state", sql`${t.state} IN ('open', 'resolved')`),
  ],
);

export type ChatThread = typeof chatThreads.$inferSelect;

/** Who is in a thread, and what each of them keeps of it: where they read to, muted, pinned, archived. */
export const chatMembers = pgTable(
  "chat_members",
  {
    threadId: integer("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** contracts/chat.ts CHAT_ROLES */
    role: text("role").notNull().default("member"),
    joinedAt: ms("joined_at")
      .notNull()
      .$defaultFn(() => new Date()),
    /** Left the thread: it no longer reaches them */
    leftAt: ms("left_at"),
    /** chat_messages.id of the last message they read (0: none) */
    lastReadId: integer("last_read_id").notNull().default(0),
    muted: integer("muted").notNull().default(0),
    pinned: integer("pinned").notNull().default(0),
    archivedAt: ms("archived_at"),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    index("idx_chat_members_user").on(t.userId, t.leftAt),
    check("chat_members_role", sql`${t.role} IN ('owner', 'member')`),
  ],
);

export type ChatMember = typeof chatMembers.$inferSelect;

/** A thread's lines: what a member wrote (Markdown, with cards and files), or what happened (joined, resolved…). */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** Who wrote it (or did what a system line says); null once their account is erased */
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    /** text | system */
    kind: text("kind").notNull().default("text"),
    body: text("body").notNull().default(""),
    /** A system line's event (ChatSystemEvent as JSON) */
    system: text("system"),
    /** Cards (ChatRef[] as JSON): snapshots of what its writer chose to show */
    refs: text("refs").notNull().default("[]"),
    replyToId: integer("reply_to_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
    /** The sending page's id for it: a retry never writes it twice */
    clientNonce: text("client_nonce"),
    /** The tracker comment it was published as */
    jiraCommentId: text("jira_comment_id"),
    editedAt: ms("edited_at"),
    /** Removed by its writer: the line stays (replies point at it), its words and files go */
    deletedAt: ms("deleted_at"),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_chat_messages_thread").on(t.threadId, t.id),
    uniqueIndex("uq_chat_messages_nonce").on(t.authorId, t.clientNonce),
    check("chat_messages_kind", sql`${t.kind} IN ('text', 'system')`),
    check("chat_messages_body", sql`length(${t.body}) <= 10000`),
  ],
);

export type ChatMessage = typeof chatMessages.$inferSelect;

/** Files in a thread: uploaded while writing (no message yet), then sent with one. Sealed for their row. */
export const chatFiles = pgTable(
  "chat_files",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** The message it went with; null while it waits to be sent */
    messageId: integer("message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
    /** Who uploaded it; null once their account is erased */
    uploaderId: integer("uploader_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** Read from the bytes when it came, never the browser's word */
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    /** A picture's size, read from its header (no layout shift while it loads) */
    width: integer("width"),
    height: integer("height"),
    data: bytea("data").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("idx_chat_files_thread").on(t.threadId),
    index("idx_chat_files_message").on(t.messageId),
    check("chat_files_name", sql`length(${t.name}) BETWEEN 1 AND 200`),
  ],
);

export type ChatFile = typeof chatFiles.$inferSelect;

/** Reactions to a message (contracts/chat.ts CHAT_REACTIONS), one of each per person. */
export const chatReactions = pgTable(
  "chat_reactions",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] }), index("idx_chat_reactions_user").on(t.userId)],
);
export const workspaceRevisions = pgTable("workspace_revisions", {
  id: text("id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  catalogVersion: text("catalog_version").notNull(),
  productDefaultVersion: text("product_default_version").notNull(),
  committedAt: epochMs("committed_at").notNull(),
  operations: text("operations").notNull(),
  constraints: text("constraints").notNull(),
  causedByRevision: text("caused_by_revision"),
  status: text("status").notNull().default("committed"),
  /** Unknown future content (D-28), kept byte-identical and read-only: JSON array of opaque entries. */
  opaque: text("opaque").notNull().default("[]"),
}, (t) => [
  primaryKey({ columns: [t.userId, t.id] }),
  uniqueIndex("uq_workspace_revision_scope").on(t.userId, t.surfaceId, t.deviceClass, t.revisionNumber),
  index("idx_workspace_revision_current").on(t.userId, t.surfaceId, t.deviceClass, t.status, t.revisionNumber),
  check("workspace_revision_status", sql`${t.status} IN ('committed','superseded')`),
  check("workspace_revision_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceDrafts = pgTable("workspace_drafts", {
  id: text("id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  baseRevision: text("base_revision").notNull(),
  draftRevision: integer("draft_revision").notNull(),
  status: text("status").notNull(),
  patches: text("patches").notNull(),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs("updated_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  // Scoped: the same draft id in another scope is another draft, never this one overwritten.
  primaryKey({ columns: [t.userId, t.surfaceId, t.deviceClass, t.id] }),
  index("idx_workspace_draft_scope").on(t.userId, t.surfaceId, t.deviceClass, t.status),
  check("workspace_draft_status", sql`${t.status} IN ('editing','ready','conflict','stale','applying','applied','aborted','discarded')`),
  check("workspace_draft_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceDescriptors = pgTable("workspace_descriptors", {
  effectiveRevision: text("effective_revision").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  sourceActiveRevision: text("source_active_revision").notNull(),
  workspaceFingerprint: text("workspace_fingerprint").notNull(),
  descriptor: text("descriptor").notNull(),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.effectiveRevision] }),
  index("idx_workspace_descriptor_source").on(t.userId, t.surfaceId, t.deviceClass, t.sourceActiveRevision),
  check("workspace_descriptor_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspacePrepared = pgTable("workspace_prepared", {
  prepareId: text("prepare_id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  baseRevision: text("base_revision").notNull(),
  draftRevision: integer("draft_revision").notNull(),
  clientInstanceId: text("client_instance_id").notNull(),
  interactionEpoch: integer("interaction_epoch").notNull(),
  descriptor: text("descriptor").notNull(),
  expiresAt: epochMs("expires_at").notNull(),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.surfaceId, t.deviceClass, t.prepareId] }),
  index("idx_workspace_prepared_client").on(t.userId, t.clientInstanceId, t.expiresAt),
  check("workspace_prepared_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspacePresentations = pgTable("workspace_presentations", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientInstanceId: text("client_instance_id").notNull(),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  status: text("status").notNull(),
  lastIssuedEpoch: integer("last_issued_epoch").notNull(),
  presentedDescriptor: text("presented_descriptor"),
  presentedEpoch: integer("presented_epoch"),
  pending: text("pending"),
  updatedAt: epochMs("updated_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.clientInstanceId, t.surfaceId, t.deviceClass] }),
  index("idx_workspace_presentation_scope").on(t.userId, t.surfaceId, t.deviceClass, t.status),
  check("workspace_presentation_status", sql`${t.status} IN ('stable','pendingActivation','activationUncertain','unknown')`),
  check("workspace_presentation_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceOperations = pgTable("workspace_operations", {
  operationId: text("operation_id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  kind: text("kind").notNull(),
  response: text("response").notNull(),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.surfaceId, t.deviceClass, t.operationId] }),
  index("idx_workspace_operation_scope").on(t.userId, t.surfaceId, t.deviceClass, t.kind),
  check("workspace_operation_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceDiscovery = pgTable("workspace_discovery", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  seenAnchorIds: text("seen_anchor_ids").notNull().default("[]"),
  placedAnchorIds: text("placed_anchor_ids").notNull().default("[]"),
  dismissedAnchorIds: text("dismissed_anchor_ids").notNull().default("[]"),
  seenAreaIds: text("seen_area_ids").notNull().default("[]"),
  placedAreaIds: text("placed_area_ids").notNull().default("[]"),
  dismissedAreaIds: text("dismissed_area_ids").notNull().default("[]"),
  updatedAt: epochMs("updated_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.surfaceId, t.deviceClass] }),
  check("workspace_discovery_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceFlowSettings = pgTable("workspace_flow_settings", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  rawRetentionDays: integer("raw_retention_days").notNull().default(30),
  aggregateRetentionDays: integer("aggregate_retention_days").notNull().default(365),
  updatedAt: epochMs("updated_at").notNull().$defaultFn(() => Date.now()),
  // The last Delete FlowMap data: anything that happened before it is never stored again (§16.5).
  deletedAt: epochMs("deleted_at"),
});

export const workspaceFlowEvents = pgTable("workspace_flow_events", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  effectiveRevision: text("effective_revision").notNull(),
  occurredAt: epochMs("occurred_at").notNull(),
  payload: text("payload").notNull(),
  receivedAt: epochMs("received_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.id] }),
  index("idx_flow_events_scope_revision").on(t.userId, t.surfaceId, t.deviceClass, t.effectiveRevision, t.occurredAt),
  // A user's oldest first (the cap prune), and every user's older than retention (purge, snapshots): more pages, more rows.
  index("idx_flow_events_user_time").on(t.userId, t.occurredAt),
  index("idx_flow_events_time").on(t.occurredAt),
  check("flow_events_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceFlowAggregates = pgTable("workspace_flow_aggregates", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  effectiveRevision: text("effective_revision").notNull(),
  origin: text("origin").notNull().default("local"),
  payload: text("payload").notNull(),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.id] }),
  index("idx_flow_aggregates_scope").on(t.userId, t.surfaceId, t.deviceClass, t.createdAt),
  check("flow_aggregates_origin", sql`${t.origin} IN ('local','import')`),
  check("flow_aggregates_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceFlowImports = pgTable("workspace_flow_imports", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  document: text("document").notNull(),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.id] }),
  index("idx_flow_imports_scope").on(t.userId, t.surfaceId, t.deviceClass, t.createdAt),
  check("flow_imports_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

export const workspaceFlowFeedback = pgTable("workspace_flow_feedback", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  status: text("status").notNull(),
  updatedAt: epochMs("updated_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.id] }),
  check("flow_feedback_status", sql`${t.status} IN ('unconfirmed','confirmed','rejected')`),
]);

export const workspacePlannerFeedback = pgTable("workspace_planner_feedback", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  signature: text("signature").notNull(),
  updatedAt: epochMs("updated_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [primaryKey({ columns: [t.userId, t.signature] })]);

export const workspaceImports = pgTable("workspace_imports", {
  id: text("id").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  surfaceId: text("surface_id").notNull(),
  deviceClass: text("device_class").notNull(),
  draftId: text("draft_id").notNull(),
  document: text("document").notNull(),
  hasUnknownContent: boolean("has_unknown_content").notNull().default(false),
  createdAt: epochMs("created_at").notNull().$defaultFn(() => Date.now()),
}, (t) => [
  primaryKey({ columns: [t.userId, t.id] }),
  uniqueIndex("uq_workspace_import_draft").on(t.userId, t.draftId),
  check("workspace_import_device", sql`${t.deviceClass} IN ('desktop','mobile')`),
]);

/**
 * A question the app owes the user an answer to (log a stopped timer, away
 * time, …), held here so every page and device of theirs shows the same one
 * and the first answer wins (contracts/decisions.ts). One open per
 * `dedupeKey`. JSON fields as text, like the rest of the schema.
 */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state").notNull().default("open"),
    payload: text("payload").notNull().default("{}"),
    premise: text("premise").notNull().default("{}"),
    draft: text("draft").notNull().default("{}"),
    /** Who wrote each draft field last: {field: {client, at}} */
    draftBy: text("draft_by").notNull().default("{}"),
    revision: integer("revision").notNull().default(0),
    busyBy: text("busy_by"),
    busyLabel: text("busy_label").notNull().default(""),
    busyUntil: ms("busy_until"),
    resolution: text("resolution").notNull().default("{}"),
    createdLabel: text("created_label").notNull().default(""),
    createdAt: ms("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: ms("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_decisions_open").on(t.userId, t.dedupeKey).where(sql`${t.state} IN ('open','resolving')`),
    index("idx_decisions_user_state").on(t.userId, t.state, t.updatedAt),
    check("decisions_state", sql`${t.state} IN ('open','resolving','resolved','dismissed','superseded','obsolete','expired')`),
  ],
);

export type Decision = typeof decisions.$inferSelect;

/**
 * The audit log: who did what, when, from where. Append-only (a trigger refuses UPDATE,
 * DELETE and TRUNCATE; only the retention purge deletes, under its own setting) and
 * hash-chained: each row's hash covers the one before, so an edited or removed row shows.
 * Tamper-evident, not tamper-proof: the app's role owns the table (docs/it/audit.md).
 * No foreign keys: an event outlives the account and the thing it names.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: epochMs("at").notNull(),
    actorUserId: integer("actor_user_id"),
    actorLabel: text("actor_label").notNull().default(""),
    actorKind: text("actor_kind").notNull(),
    /** contracts/audit.ts AUDIT_ACTIONS */
    action: text("action").notNull(),
    outcome: text("outcome").notNull().default("ok"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetOwnerUserId: integer("target_owner_user_id"),
    ip: text("ip"),
    /** sha256 of the User-Agent, shortened: tells devices apart without keeping the string */
    userAgentHash: text("user_agent_hash"),
    requestId: text("request_id"),
    /** JSON, redacted (contracts/audit.ts): kept as text, so the hash covers exactly what is stored */
    before: text("before"),
    after: text("after"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    /**
     * When an erasure pseudonymised the row (api/gdpr): its label, address and names were
     * replaced after it was chained, so verify checks its link but not its content hash.
     */
    pseudonymisedAt: epochMs("pseudonymised_at"),
  },
  (t) => [
    index("idx_audit_events_at").on(t.at),
    index("idx_audit_events_actor_at").on(t.actorUserId, t.at),
    index("idx_audit_events_target").on(t.targetType, t.targetId),
    check("audit_events_actor_kind", sql`${t.actorKind} IN ('user','system','sync','scim','cli')`),
    check("audit_events_outcome", sql`${t.outcome} IN ('ok','denied','failed')`),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
