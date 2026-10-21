// What a pass of a connection changed, seen from the catalogue: every
// difference in status, assignee, priority or title goes to the issue's
// activity, and the user's news (assigned to me, a priority raised, a due
// date close…) to the notifications, the same rules as Jira's own pass.
// The first pass only records: an empty catalogue has nothing to compare.
import { and, eq } from "drizzle-orm";
import { activity, issues, type Connection } from "@db/schema";
import { getDb } from "../queries/connection";
import { detectNotifications, insertNotifications, snapshotIssues } from "../routers/notifications";

/** The fields a difference is noted for, as the activity names them. */
const WATCHED = ["status", "assigneeName", "priority", "summary"] as const;
const FIELD: Record<(typeof WATCHED)[number], string> = { status: "status", assigneeName: "assignee", priority: "priority", summary: "summary" };

async function rows(conn: Pick<Connection, "id" | "userId">) {
  const list = await getDb()
    .select({ id: issues.id, status: issues.status, assigneeName: issues.assigneeName, priority: issues.priority, summary: issues.summary })
    .from(issues)
    .where(and(eq(issues.userId, conn.userId), eq(issues.connectionId, conn.id)));
  return new Map(list.map((r) => [r.id, r]));
}

/** Runs a pass of the connection, then records what it changed. */
export async function observePass<R>(conn: Pick<Connection, "id" | "userId" | "remoteAccountId">, pass: () => Promise<R>): Promise<R> {
  const startedAt = Date.now();
  const before = await rows(conn);
  const snapshot = await snapshotIssues(conn.userId, conn.id);
  const result = await pass();
  if (before.size === 0) return result;
  const after = await rows(conn);
  const at = new Date();
  const changes: (typeof activity.$inferInsert)[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) continue;
    for (const f of WATCHED) {
      if ((was[f] ?? "") !== (now[f] ?? "")) changes.push({ itemId: id, connectionId: conn.id, at, field: FIELD[f], fromValue: was[f] || null, toValue: now[f] || null });
    }
  }
  if (changes.length > 0) await getDb().insert(activity).values(changes);
  await insertNotifications(conn.userId, detectNotifications(snapshot, await snapshotIssues(conn.userId, conn.id), conn.remoteAccountId, conn.id, startedAt, { watch: false }), Date.now());
  return result;
}
