/**
 * What /api/events tells a user's open pages, shared by the server (which
 * publishes) and the pages (which listen): each names what changed, the data
 * comes from the usual queries.
 *   hello      — the stream (re)opened: the server's build and clock, and
 *                whether the page missed more than can be replayed (`resync`)
 *   timers     — a timer changed
 *   schedule   — the work schedule or a day's hours changed
 *   bucket     — a device switched its bucket
 *   notes      — a Markdown note changed
 * Every event but hello may carry `origin`: the page (x-client-id) that caused it.
 */
export type UserEvent =
  | { type: "timers"; epoch: number }
  | { type: "schedule" }
  | { type: "bucket"; deviceId: string }
  | { type: "notes"; id: string; change: "create" | "content" | "move" | "issue" | "delete" | "restore" | "version" };

export type LiveEventType = UserEvent["type"] | "hello";

/** Every event a page listens to (EventSource needs each name). */
export const LIVE_EVENTS: readonly LiveEventType[] = ["hello", "timers", "schedule", "bucket", "notes"];

/** The first event of a stream. */
export type Hello = { build: string | null; serverNow: number; resync: boolean };
