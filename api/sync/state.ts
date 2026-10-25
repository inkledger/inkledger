// Where each sync stream of a connection stands (connection_sync): the
// lease that keeps two processes on one database from syncing the same
// stream at once, the checkpoint, and the wait after a rate limit or a
// failure.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { connections, connectionSync } from "@db/schema";
import type { Stream } from "../providers/types";
import { ProviderError } from "../providers/core/errors";
import { getDb } from "../queries/connection";

/** This process, as a lease holder. */
export const PROCESS_ID = randomUUID();

/** A lease outlives a crashed holder by this much at most. */
export const LEASE_MS = 10 * 60_000;
/** A live holder renews its lease this often (a pass may take longer than LEASE_MS). */
export const HEARTBEAT_MS = LEASE_MS / 4;

/** The stream was taken over by another process (this one's lease ran out): its pass records nothing. */
export class LeaseLostError extends Error {
  constructor(connectionId: number, stream: Stream) {
    super(`Sync lease lost: connection ${connectionId}, ${stream} (another process holds it)`);
    this.name = "LeaseLostError";
  }
}

/** Renews this process's lease on the stream; false when it no longer holds it. */
export async function renew(connectionId: number, stream: Stream, now = Date.now()): Promise<boolean> {
  const rows = await getDb()
    .update(connectionSync)
    .set({ leaseUntil: new Date(now + LEASE_MS) })
    .where(mine(connectionId, stream))
    .returning({ id: connectionSync.connectionId });
  return rows.length > 0;
}

/**
 * After failures in a row: the first is retried at the next pass (one
 * failure is often a blip), then 1, 2, 4… minutes, at most an hour.
 */
export const backoffMs = (failures: number) => (failures <= 1 ? 0 : Math.min(60 * 60_000, 60_000 * 2 ** (failures - 2)));

export type StreamState = typeof connectionSync.$inferSelect;

export async function streamState(connectionId: number, stream: Stream): Promise<StreamState | undefined> {
  const [row] = await getDb()
    .select()
    .from(connectionSync)
    .where(and(eq(connectionSync.connectionId, connectionId), eq(connectionSync.stream, stream)))
    .limit(1);
  return row;
}

/**
 * Takes the stream for this process, unless another holds a live lease or
 * the stream must wait (retryAfter). Returns its state, or why not.
 */
export async function acquire(
  connectionId: number,
  stream: Stream,
  now = Date.now(),
  opts: { ignoreWait?: boolean } = {},
): Promise<{ ok: true; state: StreamState } | { ok: false; reason: "busy" | "waiting"; until: Date }> {
  const db = getDb();
  await db.insert(connectionSync).values({ connectionId, stream }).onConflictDoNothing();
  const [taken] = await db
    .update(connectionSync)
    .set({ leaseOwner: PROCESS_ID, leaseUntil: new Date(now + LEASE_MS) })
    .where(
      and(
        eq(connectionSync.connectionId, connectionId),
        eq(connectionSync.stream, stream),
        sql`(${connectionSync.leaseOwner} is null or ${connectionSync.leaseOwner} = ${PROCESS_ID} or ${connectionSync.leaseUntil} < ${now})`,
        opts.ignoreWait ? sql`true` : sql`(${connectionSync.retryAfter} is null or ${connectionSync.retryAfter} <= ${now})`,
      ),
    )
    .returning();
  if (taken) return { ok: true, state: taken };
  const state = await streamState(connectionId, stream);
  const leased = state?.leaseOwner && state.leaseOwner !== PROCESS_ID && (state.leaseUntil?.getTime() ?? 0) >= now;
  return leased ? { ok: false, reason: "busy", until: state.leaseUntil ?? new Date(now) } : { ok: false, reason: "waiting", until: state?.retryAfter ?? new Date(now) };
}

const mine = (connectionId: number, stream: Stream) =>
  and(eq(connectionSync.connectionId, connectionId), eq(connectionSync.stream, stream), eq(connectionSync.leaseOwner, PROCESS_ID));

/** A pass went through: the lease goes, the checkpoint (when given) is kept, failures reset. Throws when the lease was lost. */
export async function succeeded(connectionId: number, stream: Stream, outcome: { checkpoint?: string | null; full: boolean }, now = new Date()) {
  const done = await getDb()
    .update(connectionSync)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      retryAfter: null,
      failures: 0,
      lastOkAt: now,
      ...(outcome.full ? { lastFullAt: now } : {}),
      ...(outcome.checkpoint !== undefined ? { checkpoint: outcome.checkpoint } : {}),
    })
    .where(mine(connectionId, stream))
    .returning({ id: connectionSync.connectionId });
  // Another process holds it now: its checkpoint stands, this pass is not the stream's.
  if (done.length === 0) throw new LeaseLostError(connectionId, stream);
  await getDb().update(connections).set({ status: "ok" }).where(and(eq(connections.id, connectionId), eq(connections.status, "auth_failed")));
}

/**
 * A pass failed: the lease goes, and the stream waits: the service's
 * Retry-After for a rate limit, a growing backoff for what may pass by
 * itself, nothing for what only the user can fix (refused credentials mark
 * the connection instead). A checkpoint the adapter can't use is dropped:
 * the next pass reads everything again.
 */
export async function failed(connectionId: number, stream: Stream, error: unknown, now = Date.now()) {
  const state = await streamState(connectionId, stream);
  const failures = (state?.failures ?? 0) + 1;
  const kind = error instanceof ProviderError ? error.kind : "unavailable";
  const wait =
    kind === "rateLimit"
      ? Math.max(error instanceof ProviderError ? (error.rateLimit?.retryAfterMs ?? 0) : 0, 60_000)
      : kind === "unavailable" || kind === "timeout" || kind === "incompatible"
        ? backoffMs(failures)
        : 0;
  await getDb()
    .update(connectionSync)
    .set({
      leaseOwner: null,
      leaseUntil: null,
      failures,
      retryAfter: wait > 0 ? new Date(now + wait) : null,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      lastErrorAt: new Date(now),
      ...(kind === "invalidCheckpoint" ? { checkpoint: null } : {}),
    })
    .where(mine(connectionId, stream));
  if (kind === "auth") await getDb().update(connections).set({ status: "auth_failed" }).where(eq(connections.id, connectionId));
}
