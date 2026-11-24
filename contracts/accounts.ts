// inkledger's own accounts: who may do what on a server. An admin may do all of it;
// a member what the admin granted. Everyone works on their own issues and time;
// viewTeamTime alone lets someone read everyone's logged hours (the team report).

/**
 * Server-wide powers an admin can grant. useModules runs add-on modules: the ones
 * granted to the account one by one (some are heavy on PCs without a usable GPU).
 * viewTeamTime reads, never changes, every active account's logged time. viewAudit reads
 * the audit log (who did what, from where); exportAudit downloads it as CSV or JSON.
 */
export const PERMISSIONS = ["manageUsers", "manageStore", "manageBackups", "manageServer", "viewTeamTime", "useModules", "viewAudit", "exportAudit"] as const;

/** What a new account may do unless the admin says otherwise: nothing beyond its own work, no modules. */
export const DEFAULT_PERMISSIONS: readonly (typeof PERMISSIONS)[number][] = [];
export type Permission = (typeof PERMISSIONS)[number];

export type Role = "admin" | "member";

/** Rules for a new password. */
export const PASSWORD_MIN_LENGTH = 12;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** How long an invite link stays usable. */
export const INVITE_DAYS = 7;

/** The username of the admin a new server starts with. */
export const DEFAULT_ADMIN = "admin";
