// The audit log: who did what, when, from where. Every action the server records is named
// here with the fields of it that may be kept; anything else in what it changed is kept
// only as "[redacted]" (a secret, a token, a password hash never reaches a row or a file).

/** Who acted: a person, the server itself (a schedule), a sync pass, provisioning, the command line. */
export const AUDIT_ACTOR_KINDS = ["user", "system", "sync", "scim", "cli"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** How it went: done, refused for lack of a permission, or failed. */
export const AUDIT_OUTCOMES = ["ok", "denied", "failed"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** What a kept field is replaced with when it isn't one of the action's own. */
export const REDACTED = "[redacted]";

/** How a sign-in happened (sso and scim are for identity providers, wired as they come). */
export const SIGN_IN_METHODS = ["password", "remembered", "invite", "activation", "sso", "scim"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

const ACCESS = ["role", "permissions", "modules", "teams"] as const;
const ROLE = ["key", "name", "scope", "permissions"] as const;

/**
 * Every action and the fields of its before/after that are kept as they are. A closed list:
 * an action not named here doesn't compile, and a field not named is redacted.
 */
export const AUDIT_ACTIONS = {
  // Signing in and the account itself
  "auth.signIn": ["method", "username"],
  "auth.signInFailed": ["method", "username", "reason"],
  "auth.signOut": [],
  "auth.passwordChanged": [],
  "account.rename": ["username", "displayName"],
  // Accounts (Settings › Users)
  "users.invite": ["username", "displayName", ...ACCESS],
  "users.reinvite": [],
  "users.setAccess": ["username", ...ACCESS],
  "users.rename": ["username", "displayName"],
  "users.resetPassword": ["username"],
  "users.setDisabled": ["username", "disabled"],
  "users.setBreakGlass": ["username", "breakGlass"],
  // A person's data on request (api/gdpr): never their name, only their id as the target
  "users.exportData": ["self"],
  "users.erase": ["erased", "rows", "connections", "auditPseudonymised"],
  // Single sign-on (Settings › Single sign-on) and what identity providers do here
  "sso.createProvider": ["kind", "name", "issuer", "jitEnabled", "enforced", "disabled"],
  "sso.updateProvider": ["kind", "name", "issuer", "jitEnabled", "enforced", "disabled", "clientChanged"],
  "sso.removeProvider": ["kind", "name"],
  "sso.setEnforced": ["name", "enforced"],
  "sso.createScimToken": ["provider", "label"],
  "sso.revokeScimToken": ["provider", "label"],
  "sso.accountCreated": ["username", "provider", "role", "permissions", "teams"],
  "sso.accessSynced": ["username", "provider", "role", "permissions", "teams"],
  "scim.createUser": ["username", "userName", "active"],
  "scim.replaceUser": ["username", "userName", "active"],
  "scim.patchUser": ["username", "userName", "active"],
  "scim.deactivateUser": ["username", "userName", "active"],
  "scim.reactivateUser": ["username", "userName", "active"],
  "scim.createGroup": ["name"],
  "scim.updateGroup": ["name"],
  "scim.deleteGroup": ["name"],
  // Roles and teams (Settings › Users, Settings › Teams)
  "roles.create": ROLE,
  "roles.update": ROLE,
  "roles.remove": ROLE,
  "teams.create": ["name"],
  "teams.rename": ["name"],
  "teams.remove": ["name"],
  "teams.setMember": ["team", "username", "role"],
  "teams.removeMember": ["team", "username", "role"],
  // One's own settings
  "settings.update": [
    "dailyTargetSeconds",
    "weeklyTargetSeconds",
    "timerAlertMinutes",
    "notifyEnabled",
    "idleMinutes",
    "themeColor",
    "themeVariant",
    "themeContrast",
    "allowedLinkDomains",
    "backdropVisibility",
    "overlapPolicy",
    "dashboardNight",
    "pinboardOnBoard",
    "pinboardInMenu",
    "pinboardWidget",
    "todosInMenu",
    "todosWidget",
    "todosHotCorner",
    "shareLinkMinutes",
    "agentCommand",
    "mailCopies",
    "mailCopiesConsent",
  ],
  "settings.revokeShareLinks": [],
  // Server settings
  "info.addHosts": ["hosts"],
  "info.setAccess": ["tailscaleHost", "tailscalePort", "customHosts"],
  "audit.setRetention": ["days"],
  // Alerts (the webhook's URL is a secret: only its host is kept)
  "alerts.setWebhook": ["host", "format", "removed"],
  "alerts.test": ["host"],
  // Connections to trackers and time sinks
  "connections.add": ["type", "label", "baseUrl", "selfHosted"],
  "connections.reconnect": ["type", "baseUrl"],
  "connections.allowWrites": ["allowed"],
  "connections.standIn": ["trackerId"],
  "connections.setExcluded": ["count"],
  "connections.setWebhook": ["on"],
  "connections.setOption": ["key", "value"],
  "connections.rename": ["label"],
  "connections.archive": [],
  // The Store, licences and modules
  "store.requestLicense": ["product", "locale"],
  "store.checkout": ["product", "method"],
  "store.claimPaid": ["product"],
  "store.install": ["product"],
  "store.restoreLicense": [],
  "store.dismiss": ["product"],
  "modules.activate": ["product"],
  "modules.deactivate": ["product"],
  "modules.acceptToken": ["product"],
  "modules.removeLicense": ["id", "product"],
  "modules.uninstall": ["id"],
  "modules.setEnabled": ["id", "enabled"],
  "modules.importProgress": [],
  // A module's own settings changed by its user (from its settings panel; one event per key a minute)
  "modules.configure": ["id", "key"],
  // A licence that landed, given to the one person it was got for (who paid: them, an admin, a team)
  "store.grantAcquired": ["product", "moduleId", "userId", "payerKind", "payerId"],
  // Who gets a module (Settings › Store, manageStore): offered to buy, assigned (bought per person), moved
  "store.offer": ["product", "userId", "teamId"],
  "store.withdrawOffer": ["product", "userId", "teamId"],
  "store.assign": ["product", "kind", "count", "skipped", "teamId"],
  "store.reassign": ["licence", "userId"],
  // Backups
  "backup.update": ["schedule", "time", "weekday", "keep"],
  "backup.run": ["name", "scheduled"],
  "backup.restore": ["name"],
  "backup.download": ["name", "size"],
  "backup.offsiteUpdate": ["kind", "endpoint", "bucket", "prefix", "region", "accessKeyId", "keepDaily", "keepWeekly", "keepMonthly", "objectLockDays", "objectLockMode"],
  "backup.offsiteUpload": ["name", "lastOkAt", "lastError"],
  "backup.offsiteRestore": ["name", "data", "safety"],
  "backup.drill": ["dump", "ok", "users", "worklogs", "connections", "migrationHead", "sealedUnreadable", "error", "scheduled"],
  "backup.drillUpdate": ["weekly"],
  "restore.completed": ["name", "safety", "preRestoreLastHash"],
  // Reading other people's time
  "team.overview": ["from", "to"],
  "team.person": ["userId", "from", "to"],
  "team.day": ["userId", "date"],
  // Worklogs: by the user, or by sync (one event per pass)
  "worklog.create": ["issueKey", "connectionId", "seconds", "started"],
  "worklog.update": ["issueKey", "connectionId", "seconds", "started"],
  "worklog.delete": ["issueKey", "connectionId", "seconds"],
  "worklog.restore": ["issueKey", "connectionId", "seconds", "started"],
  "worklog.resolveConflict": ["issueKey", "keep"],
  "worklog.sync": ["connectionId", "imported", "deleted", "upserted", "removed", "initial"],
  "worklog.replay": ["connectionId", "synced", "failed", "remaining"],
  // Feedback (Info > Feedback): ids, types, states and counts, never what was written
  "feedback.create": ["type", "shared"],
  "feedback.comment": ["origin"],
  "feedback.setStatus": ["from", "to"],
  "feedback.export": ["format", "rows", "scope"],
  "feedback.setSharing": ["enabled"],
  "feedback.sendNow": ["sent", "refused", "failed"],
  "feedback.forward": ["sent", "refused", "failed", "updated"],
  // The log itself
  "audit.export": ["format", "rows", "filters"],
  "audit.purge": ["deleted", "before", "retentionDays", "lastPurgedHash"],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (s: string): s is AuditAction => Object.hasOwn(AUDIT_ACTIONS, s);

/** Retention of the log, in days: kept at least this long, whatever is set. */
export const AUDIT_RETENTION_MIN_DAYS = 90;
export const AUDIT_RETENTION_DEFAULT_DAYS = 400;
export const AUDIT_RETENTION_MAX_DAYS = 3650;

/** The hash the first event of a chain points back to. */
export const AUDIT_GENESIS = "0".repeat(64);

/** One event as the API lists it. */
export type AuditEventView = {
  id: number;
  at: number;
  actorUserId: number | null;
  actorLabel: string;
  actorKind: AuditActorKind;
  action: string;
  outcome: AuditOutcome;
  targetType: string | null;
  targetId: string | null;
  targetOwnerUserId: number | null;
  ip: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/** What a walk of the chain found. */
export type AuditVerifyResult =
  | { ok: true; checked: number; anchored: boolean }
  | { ok: false; checked: number; badId: number; reason: "hash" | "link" };

/** The fields changed between before and after (both kept as redacted), for the diff view. */
export function auditDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { field: string; before: unknown; after: unknown }[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return keys
    .map((field) => ({ field, before: before?.[field], after: after?.[field] }))
    .filter((d) => JSON.stringify(d.before) !== JSON.stringify(d.after) || before === null || after === null);
}
