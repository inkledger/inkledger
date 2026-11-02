// A notification from a tracker's inbox, dismissed here: read on the tracker
// too (best effort: a tracker that can't be reached, or a read-only server,
// leaves it unread there, never fails the dismissal).
import { and, eq, inArray } from "drizzle-orm";
import { connections } from "@db/schema";
import { getDb } from "../queries/connection";
import { boundTracker } from "./engine";
import { callMeta } from "../lib/callMeta";

/** The inbox item a notification's dedupe names (c<connection>:inbox:<id>:<at>), if any. */
export function inboxItemOf(dedupe: string): { connectionId: number; id: string } | null {
  const m = /^c(\d+):inbox:(.+):[^:]+$/.exec(dedupe);
  return m ? { connectionId: Number(m[1]), id: m[2] } : null;
}

export async function markInboxRead(userId: number, dedupes: string[]): Promise<void> {
  const items = dedupes.flatMap((d) => inboxItemOf(d) ?? []);
  if (items.length === 0) return;
  // Their connections read once (the user's only), each bound once.
  const conns = await getDb()
    .select()
    .from(connections)
    .where(and(inArray(connections.id, [...new Set(items.map((i) => i.connectionId))]), eq(connections.userId, userId)));
  const bound = new Map(conns.map((conn) => [conn.id, { conn, b: boundTracker(conn) }]));
  for (const item of items) {
    const found = bound.get(item.connectionId);
    const b = found?.b;
    if (!found || !b?.markRead) continue;
    const { conn } = found;
    await b.markRead(callMeta(`read-${conn.id}`, 15_000), item.id).catch((e: unknown) => {
      console.warn(`[inbox] ${conn.id}: not marked read there (${e instanceof Error ? e.message : String(e)})`);
    });
  }
}
