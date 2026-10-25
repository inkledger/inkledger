// One stream of one connection, synced: the lease taken (one process at a
// time), a background pass held back while the stream must wait, the
// adapter bound to the connection, its calls spread by the connection's
// budget, the outcome recorded (checkpoint only on success).
import type { TrackerProvider } from "../providers/types";
import { eq, sql } from "drizzle-orm";
import { connections, type Connection } from "@db/schema";
import { getDb } from "../queries/connection";
import type { TrackerType } from "@contracts/providers";
import { bindTracker, type BoundTracker } from "../providers/core/bind";
import { connOf } from "../providers/connections";
import { trackerAdapter, trackerStatus } from "../providers/registry";
import type { Checkpoint, Stream, TrackerProbe } from "../providers/types";
import { budgetOf, type Budget } from "./budget";
import { syncIssues, type IssuePassResult } from "./issues";
import { entriesOf, syncEntries } from "./worklogs";
import { acquire, failed, HEARTBEAT_MS, LeaseLostError, renew, succeeded } from "./state";
import { observePass } from "./observe";
import { insertNotifications } from "../routers/notifications";

export type StreamRun<R> =
  | { ran: true; result: R }
  /** busy: another process holds the stream; waiting: a rate limit or backoff (background passes only) */
  | { ran: false; reason: "busy" | "waiting"; until: Date };

/**
 * Runs `pass` holding the stream. A background pass respects the stream's
 * wait; one the user asked for goes anyway (it may fail the same way, and
 * says so).
 */
export async function withStream<R>(
  conn: Pick<Connection, "id">,
  stream: Stream,
  opts: { full: boolean; background: boolean },
  pass: (checkpoint: Checkpoint | null) => Promise<{ result: R; checkpoint?: Checkpoint | null }>,
): Promise<StreamRun<R>> {
  let got = await acquire(conn.id, stream);
  if (!got.ok && got.reason === "waiting" && !opts.background) got = await acquire(conn.id, stream, Date.now(), { ignoreWait: true });
  if (!got.ok) return { ran: false, reason: got.reason, until: got.until };
  // Kept alive while the pass runs: a long one is never taken over as if its holder had died.
  const beat = setInterval(() => void renew(conn.id, stream).catch(() => undefined), HEARTBEAT_MS);
  try {
    const out = await pass(opts.full ? null : (got.state.checkpoint as Checkpoint | null));
    clearInterval(beat);
    await succeeded(conn.id, stream, { checkpoint: out.checkpoint, full: opts.full });
    return { ran: true, result: out.result };
  } catch (e) {
    clearInterval(beat);
    // Lost to another process: its state stands, nothing of this pass is recorded on it.
    if (!(e instanceof LeaseLostError)) await failed(conn.id, stream, e).catch(() => undefined);
    throw e;
  }
}

/** What the inbox says, in the notifications' words; an assignment the sync already sees, the rest isn't news. */
const INBOX_KIND = { mention: "mentioned", comment: "commented", review: "review", change: "changed" } as const;

/**
 * The tracker's own inbox into the user's notifications, since the last
 * read. The first read only notes where it stands: what was already there
 * isn't news.
 */
export async function syncInbox(conn: Connection, opts: { background: boolean; bound?: BoundTracker }): Promise<number> {
  const b = opts.bound ?? boundTracker(conn);
  if (!b?.inbox) return 0;
  const inbox = b.inbox;
  let added = 0;
  await withStream(conn, "inbox", { full: false, background: opts.background }, async (since) => {
    const meta = { signal: AbortSignal.timeout(30_000), correlationId: `inbox-${conn.id}-${Date.now()}` };
    const read = await inbox(meta, since);
    if (since !== null) {
      const news = read.items.flatMap((i) =>
        i.reason in INBOX_KIND && i.unread
          ? [{ connectionId: conn.id, kind: INBOX_KIND[i.reason as keyof typeof INBOX_KIND], issueKey: i.issue.key ?? "", detail: i.title, dedupe: `inbox:${i.id}:${i.at}` }]
          : [],
      );
      await insertNotifications(conn.userId, news, Date.now());
      added = news.length;
    }
    return { result: undefined, checkpoint: (read.cursor ?? since) as Checkpoint | null };
  });
  return added;
}

/** A probe holds for a day: what is active on the connection, and the call budget it meets. */
const PROBE_TTL_MS = 24 * 3600_000;

/** The probe saved on the connection (Settings → Connections tests it too), else a fresh one, saved. */
async function budgetFor(conn: Connection, b: BoundTracker, signal: AbortSignal): Promise<Budget> {
  const [row] = await getDb().select({ probe: connections.probe, probedAt: connections.probedAt }).from(connections).where(eq(connections.id, conn.id));
  if (row?.probe && row.probedAt && Date.now() - row.probedAt.getTime() < PROBE_TTL_MS) {
    try {
      return budgetOf((JSON.parse(row.probe) as TrackerProbe).rateLimit);
    } catch {
      // unreadable: probed again below
    }
  }
  const probe = await b.probe({ signal, correlationId: `probe-${b.connectionId}-${Date.now()}` });
  await getDb().update(connections).set({ probe: JSON.stringify(probe), probedAt: new Date() }).where(eq(connections.id, conn.id));
  return budgetOf(probe.rateLimit);
}

/** The connection's tracker, bound; null when its adapter isn't built (or is turned off). */
export function boundTracker(conn: Connection): BoundTracker | null {
  const adapter = trackerAdapter(conn.type as TrackerType);
  if (!adapter) return null;
  // An adapter not verified on a real account writes only once the user allows it on this connection.
  const writable = trackerStatus(conn.type as TrackerType) !== "experimental" || conn.writesAllowed === 1;
  // By type: each adapter binds with its own options.
  return bindTracker(adapter as TrackerProvider<TrackerType, unknown>, { ...connOf(conn), writable });
}

/** The issue stream of a connection through the provider contract. */
export async function syncConnectionIssues(
  conn: Connection,
  opts: { full: boolean; background: boolean; signal?: AbortSignal; bound?: BoundTracker },
): Promise<StreamRun<IssuePassResult>> {
  const b = opts.bound ?? boundTracker(conn);
  if (!b) return { ran: false, reason: "waiting", until: new Date(8.64e15) };
  const signal = opts.signal ?? new AbortController().signal;
  return withStream(conn, "issues", opts, async (since) => {
    const budget = await budgetFor(conn, b, signal);
    const meta = { signal, correlationId: `sync-${conn.id}-${Date.now()}` };
    // What the pass changed goes to the issues' activity and the user's news.
    const result = await observePass(conn, () => syncIssues(b, { userId: conn.userId, connectionId: conn.id }, { since, meta, budget }));
    return { result, checkpoint: result.checkpoint };
  });
}

/**
 * The time on a tracker that keeps it (GitLab, YouTrack, Redmine…), from
 * its feed into the registry: entries logged there directly (or from another
 * inkledger) show up here; ones removed there go. Jira has its own
 * (worklogSync.ts). Nothing for a tracker whose time stays in inkledger.
 */
export async function syncConnectionEntries(
  conn: Connection,
  opts: { full: boolean; background: boolean; signal?: AbortSignal; bound?: BoundTracker },
): Promise<StreamRun<{ upserted: number; removed: number }> | null> {
  const b = opts.bound ?? boundTracker(conn);
  if (!b || !entriesOf(b) || !b.worklogs?.changed) return null;
  const signal = opts.signal ?? new AbortController().signal;
  return withStream(conn, "entries", opts, async (since) => {
    const budget = await budgetFor(conn, b, signal);
    const meta = { signal, correlationId: `entries-${conn.id}-${Date.now()}` };
    const r = await syncEntries(b, conn, { since, meta, budget, zone: connOf(conn).timeZone });
    return { result: { upserted: r.upserted, removed: r.removed }, checkpoint: r.checkpoint };
  });
}

/** A connection's saved probe no longer holds (its credentials or options changed): the next pass probes again. All of them with no id (tests). */
export async function forgetProbes(connectionId?: number): Promise<void> {
  await getDb()
    .update(connections)
    .set({ probedAt: null })
    .where(connectionId === undefined ? sql`true` : eq(connections.id, connectionId));
}
