// Closures (issue_closures) told to a module once each: claimed per user and
// module, so live and catch-up, two tabs or two devices never tell one twice.
import { and, asc, eq, gte, inArray, notExists } from "drizzle-orm";
import { connections, issueClosures, issues, moduleClosureClaims, type User } from "@db/schema";
import { getDb } from "../queries/connection";
import { contextFor } from "../providers/connections";
import { knownRanks, priorityRanks } from "../jira/priorities";

export type ClaimedClosure = { connectionId: number; issueKey: string; priority: string; priorityRank: number | null };

/** A Jira site's ranks now (a closed issue keeps the rank it was synced with, maybe from an older order). */
async function jiraRanks(user: User, conn: typeof connections.$inferSelect) {
  const known = knownRanks(conn.baseUrl);
  if (known) return known;
  try {
    return await priorityRanks(contextFor(user, conn).creds);
  } catch {
    return null;
  }
}

/** The next closures since `since` (epoch ms) this module was not told yet, oldest first, now claimed. */
export async function claimClosures(user: User, moduleId: string, since: number, limit: number): Promise<ClaimedClosure[]> {
  const db = getDb();
  const told = db
    .select({ one: moduleClosureClaims.closureId })
    .from(moduleClosureClaims)
    .where(and(eq(moduleClosureClaims.userId, user.id), eq(moduleClosureClaims.moduleId, moduleId), eq(moduleClosureClaims.closureId, issueClosures.id)));
  const picked = await db
    .select({ id: issueClosures.id })
    .from(issueClosures)
    .where(and(eq(issueClosures.userId, user.id), gte(issueClosures.closedAt, since), notExists(told)))
    .orderBy(asc(issueClosures.closedAt), asc(issueClosures.id))
    .limit(limit);
  if (picked.length === 0) return [];
  // Another tab claiming the same ones at once: each goes to whoever wrote it first.
  const claimed = await db
    .insert(moduleClosureClaims)
    .values(picked.map((p) => ({ userId: user.id, moduleId, closureId: p.id })))
    .onConflictDoNothing()
    .returning({ id: moduleClosureClaims.closureId });
  if (claimed.length === 0) return [];
  const rows = await db
    .select({ connectionId: issues.connectionId, issueKey: issues.key, priority: issues.priority, priorityRank: issues.priorityRank, conn: connections })
    .from(issueClosures)
    .innerJoin(issues, eq(issues.id, issueClosures.itemId))
    .innerJoin(connections, eq(connections.id, issues.connectionId))
    .where(inArray(issueClosures.id, claimed.map((c) => c.id)))
    .orderBy(asc(issueClosures.closedAt), asc(issueClosures.id));
  const ranks = new Map<number, Map<string, number | null> | null>();
  const out: ClaimedClosure[] = [];
  for (const r of rows) {
    if (r.conn.type === "jira" && !ranks.has(r.conn.id)) ranks.set(r.conn.id, await jiraRanks(user, r.conn));
    const now = r.priority ? ranks.get(r.conn.id)?.get(r.priority) : undefined;
    out.push({ connectionId: r.connectionId, issueKey: r.issueKey, priority: r.priority, priorityRank: now ?? r.priorityRank });
  }
  return out;
}
