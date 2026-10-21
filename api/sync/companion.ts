// A time sink standing in for one tracker connection (Tempo for its Jira):
// while it is connected and may write, that tracker's new worklogs are filed
// on the sink, which puts them on the tracker itself. The tracker's id of
// each is kept on the worklog, so the tracker's own feed reads it back as
// the same worklog, never a second one. Worklogs from before the sink stay
// the tracker's own and change there. Written through like any other
// (D10): refused, nothing is kept; unreachable, kept here and sent later.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { connections, outbox, worklogs, worklogSinks, type Connection, type Worklog } from "@db/schema";
import { getDb } from "../queries/connection";
import { withDeleteReason } from "../queries/trash";
import { ProviderError } from "../providers/core/errors";
import { boundSink, pushOne, sinksSoon, trackerOfSink } from "./extraSinks";

const meta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `companion-${Date.now()}` });
const transient = (e: unknown) => e instanceof ProviderError && e.transient;

async function reread(id: number): Promise<Worklog> {
  const [row] = await getDb().select().from(worklogs).where(eq(worklogs.id, id));
  return row;
}

function bound(sink: Connection) {
  const b = boundSink(sink);
  if (!b) throw new ProviderError("invalid", `${sink.type} is not a time sink`);
  return b;
}

/** A new worklog on the tracker, filed through the sink standing in for it. */
export async function createViaCompanion(
  sink: Connection,
  tracker: Connection,
  input: { userId: number; issueKey: string; seconds: number; started: Date; comment: string },
): Promise<Worklog> {
  const b = bound(sink);
  const db = getDb();
  const [row] = await db
    .insert(worklogs)
    .values({
      userId: input.userId,
      connectionId: tracker.id,
      issueKey: input.issueKey,
      remoteId: `new-${randomUUID()}`,
      timeSpentSeconds: input.seconds,
      started: input.started,
      comment: input.comment,
      authorAccountId: tracker.remoteAccountId,
      syncedAt: new Date(),
    })
    .returning();
  await db.insert(worklogSinks).values({ worklogId: row.id, sinkConnectionId: sink.id, state: "pending" });
  try {
    await pushOne(b, sink, row, null);
  } catch (e) {
    if (!transient(e)) {
      await withDeleteReason("merged", (tx) => tx.delete(worklogs).where(eq(worklogs.id, row.id)));
      throw e;
    }
    // Kept here, pending on the sink: sent on a later pass.
  }
  return reread(row.id);
}

/** The stand-in sink that filed this worklog and its id there (null id: not there yet), or null: the tracker's own. */
export async function companionEntry(w: Worklog): Promise<{ sink: Connection; remoteId: string | null } | null> {
  if (w.connectionId === null) return null;
  const rows = await getDb()
    .select({ sink: connections, remoteId: worklogSinks.remoteId })
    .from(worklogSinks)
    .innerJoin(connections, eq(connections.id, worklogSinks.sinkConnectionId))
    .where(eq(worklogSinks.worklogId, w.id));
  const own = rows.find((r) => trackerOfSink(r.sink) === w.connectionId);
  return own ? { sink: own.sink, remoteId: own.remoteId } : null;
}

const setState = (worklogId: number, sinkId: number, state: "pending" | "synced") =>
  getDb()
    .update(worklogSinks)
    .set({ state, lastError: null })
    .where(and(eq(worklogSinks.worklogId, worklogId), eq(worklogSinks.sinkConnectionId, sinkId)));

/** A worklog the sink filed, changed: on the sink now, or kept here and sent later. Refused: nothing changes. */
export async function updateViaCompanion(
  entry: { sink: Connection; remoteId: string | null },
  current: Worklog,
  fields: { timeSpentSeconds: number; started: Date; comment: string },
): Promise<Worklog> {
  const next = { ...current, ...fields };
  if (entry.remoteId) {
    try {
      await pushOne(bound(entry.sink), entry.sink, next, entry.remoteId);
    } catch (e) {
      if (!transient(e)) throw e;
      await setState(current.id, entry.sink.id, "pending");
      sinksSoon(current.userId);
    }
  }
  // Not on the sink yet: its pending create sends these values.
  await getDb().update(worklogs).set({ ...fields, syncedAt: new Date() }).where(eq(worklogs.id, current.id));
  return reread(current.id);
}

/** A worklog the sink filed, deleted: gone from the sink now, or queued; to the trash here either way. Refused: kept. */
export async function deleteViaCompanion(entry: { sink: Connection; remoteId: string | null }, current: Worklog): Promise<void> {
  if (entry.remoteId) {
    const b = bound(entry.sink);
    try {
      await b.entries.delete!(meta(), entry.remoteId, {});
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "notFound") {
        // already gone there
      } else if (transient(e)) {
        await getDb()
          .insert(outbox)
          .values({ userId: current.userId, connectionId: entry.sink.id, kind: "delete", issueKey: current.issueKey, remoteId: entry.remoteId, timeSpentSeconds: current.timeSpentSeconds, started: current.started });
        sinksSoon(current.userId);
      } else {
        throw e;
      }
    }
  }
  await withDeleteReason("user", (tx) => tx.delete(worklogs).where(eq(worklogs.id, current.id)));
}
