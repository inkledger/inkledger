// Sync rules shared by the server and the app; no schema library here, the app's first load imports it.

/**
 * Failures in a row of a service out of reach after which the background
 * sync stops trying a connection ("unreachable"): it waits for the user's
 * own Sync, which tries it anyway and on success makes it "ok" again.
 */
export const SYNC_GIVE_UP_AFTER = 3;
