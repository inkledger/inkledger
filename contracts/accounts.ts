// inkledger's own accounts: who may do what on a server. An owner may do all of it;
// anyone else what their role and their own grants hold. Everyone works on their own
// issues and time; viewTeamTime alone lets someone read other people's logged hours (the
// team report): everyone's when held server-wide, their teams' when held as a team lead.

/**
 * Powers on the server, a closed list. useModules runs add-on modules: the ones granted
 * to the account one by one (some are heavy on PCs without a usable GPU). viewTeamTime
 * reads, never changes, other accounts' logged time. viewAudit reads the audit log (who
 * did what, from where); exportAudit downloads it as CSV or JSON. Backups: running them
 * (and their schedule), restoring one (owners only besides: its accounts come back), and
 * downloading a dump (whoever reaches the server's disk gets one anyway). manageAuth:
 * how people sign in; manageTeams: teams and who is in them; manageRetention: how long
 * the audit log is kept; exportUserData / eraseUserData: a person's data on request.
 * acquireModules browses the Store's whole catalogue and buys or requests a module not
 * on the server yet (granted then to whoever acquired it, only); without it, useModules
 * sees in the Store just the modules granted to the account, to turn on or off and set up.
 */
export const PERMISSIONS = [
  "manageUsers",
  "manageAuth",
  "manageTeams",
  "manageStore",
  "acquireModules",
  "manageServer",
  "runBackups",
  "restoreBackups",
  "downloadBackups",
  "manageRetention",
  "viewTeamTime",
  "useModules",
  "viewAudit",
  "exportAudit",
  "exportUserData",
  "eraseUserData",
] as const;

/** What a new account may do unless the admin says otherwise: nothing beyond its own work, no modules. */
export const DEFAULT_PERMISSIONS: readonly (typeof PERMISSIONS)[number][] = [];
export type Permission = (typeof PERMISSIONS)[number];

/** Holding the key means holding these too: whoever manages the Store also buys and requests modules. */
export const IMPLIED_PERMISSIONS: Readonly<Partial<Record<Permission, readonly Permission[]>>> = {
  manageStore: ["acquireModules"],
};

/** users.role, kept for older builds: "admin" is the owner role. */
export type Role = "admin" | "member";

/** The roles every server starts with (seeded, read-only). */
export const SYSTEM_ROLES = ["owner", "it-admin", "team-lead", "auditor", "member"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Where a role applies: on the whole server, or within the teams it is held for. */
export type RoleScope = "server" | "team";

/** Only an owner gives, takes or edits these: whoever holds them could take the server over. */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = ["manageUsers", "manageAuth"];

/** A team member's place in it: a lead reads its members' time (the team-lead role). */
export type TeamRole = "member" | "lead";

/** Rules for a new password. */
export const PASSWORD_MIN_LENGTH = 12;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** How long an invite link stays usable. */
export const INVITE_DAYS = 7;

/** The username of the admin a new server starts with. */
export const DEFAULT_ADMIN = "admin";
