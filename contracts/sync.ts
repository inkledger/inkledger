// Sync rules shared by the server and the app: what a connection's sync
// status can be and what each state means. No imports: the app's first-load
// code pulls this in. The predicates take plain text: the tRPC contract
// carries the status as a string.

export const SYNC_STATES = ["ok", "auth_failed", "unreadable", "unreachable"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** Credentials refused or no longer readable: the user has to reconnect. */
export const needsReconnect = (s: string): boolean => s !== "ok" && s !== "unreachable";
/** Out of reach SYNC_GIVE_UP_AFTER times in a row: background sync paused until the user's own Sync. */
export const isPaused = (s: string): boolean => s === "unreachable";
/** Syncing normally. */
export const isWorking = (s: string): boolean => s === "ok";

/**
 * Failures in a row of a service out of reach after which the background
 * sync stops trying a connection ("unreachable"): it waits for the user's
 * own Sync, which tries it anyway and on success makes it "ok" again.
 */
export const SYNC_GIVE_UP_AFTER = 3;
