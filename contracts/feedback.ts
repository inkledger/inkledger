// User feedback about the app (the Feedback page): what a person sends, the states an admin
// moves it through, and what of it may leave this server. Shared by the page and the API.

/** What a feedback is about. */
export const FEEDBACK_TYPES = ["problem", "idea", "improvement"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/**
 * Where a feedback stands, driven by whoever holds manageFeedback (or by inkledger's
 * developers for one shared with them): new, being discussed, accepted, being worked on,
 * done; or rejected, with a reason.
 */
export const FEEDBACK_STATUSES = ["new", "discussion", "accepted", "in_progress", "implemented", "rejected"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Who wrote a line of a feedback's thread: its author, an admin, inkledger's developers, or a change of state. */
export const FEEDBACK_ORIGINS = ["user", "admin", "upstream", "status"] as const;
export type FeedbackOrigin = (typeof FEEDBACK_ORIGINS)[number];

/** Sharing with inkledger's developers: waiting to go, sent, or refused by the Store for good. */
export const FEEDBACK_SHARE_STATES = ["queued", "sent", "refused"] as const;
export type FeedbackShareState = (typeof FEEDBACK_SHARE_STATES)[number];

export const FEEDBACK_TITLE_MAX = 200;
export const FEEDBACK_BODY_MAX = 20_000;
export const FEEDBACK_COMMENT_MAX = 5_000;
/** A screenshot: an image the person picked or pasted, at most this many bytes. */
export const FEEDBACK_SCREENSHOT_MAX_BYTES = 1024 * 1024;
export const FEEDBACK_SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type FeedbackScreenshotType = (typeof FEEDBACK_SCREENSHOT_TYPES)[number];

export const isFeedbackType = (s: string): s is FeedbackType => (FEEDBACK_TYPES as readonly string[]).includes(s);
export const isFeedbackStatus = (s: string): s is FeedbackStatus => (FEEDBACK_STATUSES as readonly string[]).includes(s);

/** A segment that names a thing (an issue key, a number, an id, a date): never part of a route's shape. */
const NAMED = /^(?:[A-Z][A-Z0-9_]+-\d+|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{4}-\d{2}-\d{2})$/i;
/** The app's own words in a path (its routes' fixed segments): anything else is a name of something. */
const FIXED = /^[a-z][a-z-]{0,30}$/;

/**
 * The shape of a page's path, as it may leave this server: fixed segments kept, every
 * other one (an issue key, an id, a note, a date) replaced by ":id"; no query, no hash.
 * "/issues/ABC-12?q=x" → "/issues/:id".
 */
export function routePattern(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? "";
  const parts = bare
    .split("/")
    .filter(Boolean)
    .slice(0, 6)
    .map((p) => (NAMED.test(p) || !FIXED.test(p) ? ":id" : p));
  return "/" + parts.join("/");
}
