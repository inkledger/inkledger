// inkledger's own accounts: who may do what on a server. An admin may do all of it;
// a member what the admin granted. Everyone works on their own issues and time.

/** Server-wide powers an admin can grant; useModules (running the installed add-on modules) is granted by default. */
export const PERMISSIONS = ["manageUsers", "manageStore", "manageBackups", "manageServer", "useModules"] as const;

/** What a new account may do unless the admin says otherwise. */
export const DEFAULT_PERMISSIONS: readonly (typeof PERMISSIONS)[number][] = ["useModules"];
export type Permission = (typeof PERMISSIONS)[number];

export type Role = "admin" | "member";

/** Rules for a new password. */
export const PASSWORD_MIN_LENGTH = 12;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** How long an invite link stays usable. */
export const INVITE_DAYS = 7;

/** The username of the admin a new server starts with. */
export const DEFAULT_ADMIN = "admin";
