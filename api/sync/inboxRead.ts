// A notification from a tracker's inbox, dismissed here: read on the tracker
// too (best effort: a tracker that can't be reached, or a read-only server,
// leaves it unread there, never fails the dismissal).
import { and, eq } from "drizzle-orm";
import { connections } from "@db/schema";
import { getDb } from "../queries/connection";
import { boundTracker } from "./engine";

/** The inbox item a notification's dedupe names (c<connection>:inbox:<id>:<at>), if any. */
export function inboxItemOf(dedupe: string): { connectionId: number; id: string } | null {
  const m = /^c(\d+):inbox:(.+):[^:]+$/.exec(dedupe);
  return m ? { connectionId: Number(m[1]), id: m[2] } : null;
}

export async function markInboxRead(userId: number, dedupes: string[]): Promise<void> {
  for (const d of dedupes) {
    const item = inboxItemOf(d);
    if (!item) continue;
    const [conn] = await getDb()
      .select()
      .from(connections)
      .where(and(eq(connections.id, item.connectionId), eq(connections.userId, userId)))
      .limit(1);
    const b = conn ? boundTracker(conn) : null;
    if (!b?.markRead) continue;
    await b.markRead({ signal: AbortSignal.timeout(15_000), correlationId: `read-${conn.id}-${Date.now()}` }, item.id).catch((e: unknown) => {
      console.warn(`[inbox] ${conn.id}: not marked read there (${e instanceof Error ? e.message : String(e)})`);
    });
  }
}
