// Sync rules shared by the server and the app: what a connection's sync
// status can be and what each state means. No imports: the app's first-load
// code pulls this in. The predicates take plain text: the tRPC contract
// carries the status as a string.

export const SYNC_STATES = ["ok", "auth_failed", "unreadable", "unreachable"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

/** Credentials refused or no longer readable: the user has to reconnect. */
export const needsReconnect = (s: string): boolean => s !== "ok" && s !== "unreachable";
/** Out of reach SYNC_GIVE_UP_AFTER times in a row: said to the user; the background keeps retrying within its backoff. */
export const isPaused = (s: string): boolean => s === "unreachable";
/** Syncing normally. */
export const isWorking = (s: string): boolean => s === "ok";

/**
 * Failures in a row of a service out of reach after which a connection is
 * "unreachable": the background tries it again within its backoff (the
 * user's own Sync at once), and a pass that goes through makes it "ok".
 */
export const SYNC_GIVE_UP_AFTER = 3;

/** The kinds a failure is recorded with (the providers' error kinds). */
export const FAILURE_KINDS = ["auth", "forbidden", "invalid", "rateLimit", "conflict", "notFound", "invalidCheckpoint", "unavailable", "readOnly", "cancelled", "timeout", "incompatible"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** How Jira's refusal of the sign-in itself (a CAPTCHA) starts: a browser sign-in clears it, not the password. */
export const SIGN_IN_DENIED = "Jira refused the sign-in";

/**
 * A recorded failure's kind and status (last_error reads "kind (status): words"):
 * the app says it in the user's language. null: text without them (older rows).
 */
export function failureOf(text: string): { kind: FailureKind; status?: number; signInDenied: boolean } | null {
  const m = /^(\w+)(?: \((\d{3})\))?(?:: ([\s\S]*))?$/.exec(text);
  const kind = FAILURE_KINDS.find(k => k === m?.[1]);
  if (!m || !kind) return null;
  return { kind, ...(m[2] ? { status: Number(m[2]) } : {}), signInDenied: kind === "auth" && (m[3] ?? "").startsWith(SIGN_IN_DENIED) };
}
