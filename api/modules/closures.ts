// Closures (issue_closures) told to a module once each: claimed per user and
// module, so live and catch-up, two tabs or two devices never tell one twice.
import { and, asc, eq, gte, inArray, notExists, type SQL } from "drizzle-orm";
import { connections, issueClosures, issues, moduleClosureClaims, moduleStorage, type User } from "@db/schema";
import { getDb } from "../queries/connection";
import { contextFor } from "../providers/connections";
import { knownRanks, priorityRanks } from "../jira/priorities";

// A host key (modules can't write "__" keys): from when this module hears closures.
const FROM = "__closures";

/**
 * From when (epoch ms) the module hears closures: when it first asked, so the closures from before
 * (the catalogue's past) are never told on their own; releaseClosuresFrom tells them on purpose.
 */
async function closuresFrom(userId: number, moduleId: string): Promise<number> {
  const db = getDb();
  const at = Date.now();
  await db.insert(moduleStorage).values({ userId, moduleId, key: FROM, value: String(at), updatedAt: new Date(at) }).onConflictDoNothing();
  const [row] = await db
    .select({ value: moduleStorage.value })
    .from(moduleStorage)
    .where(and(eq(moduleStorage.userId, userId), eq(moduleStorage.moduleId, moduleId), eq(moduleStorage.key, FROM)))
    .limit(1);
  return Number(row?.value ?? at) || at;
}

/** Not told yet to the module: its claims don't hold this closure. */
const untold = (userId: number, moduleId: string) =>
  notExists(
    getDb()
      .select({ one: moduleClosureClaims.closureId })
      .from(moduleClosureClaims)
      .where(and(eq(moduleClosureClaims.userId, userId), eq(moduleClosureClaims.moduleId, moduleId), eq(moduleClosureClaims.closureId, issueClosures.id))),
  );

export type Release = { deliver: number; golden: number; skipped: ClaimedClosure[]; applied: boolean };

const isHigh = (c: ClaimedClosure) => c.priorityRank !== null && c.priorityRank <= 1;

/**
 * The module hears the closures assigned to the user from `from` on (never before it started
 * counting) it was not told yet: what it would hear, how many golden (rank 0–1). `already`: that
 * many it counted live before closures came from the server, skipped as the most recent plain
 * ones (the live count never gave a golden one), so its totals end up exact. Written only with
 * `apply`: the skipped ones claimed first, then the window opened.
 */
export async function releaseClosuresFrom(user: User, moduleId: string, from: number, opts: { already?: number; apply?: boolean } = {}): Promise<Release> {
  const db = getDb();
  const userId = user.id;
  const [since] = await db
    .select({ value: moduleStorage.value })
    .from(moduleStorage)
    .where(and(eq(moduleStorage.userId, userId), eq(moduleStorage.moduleId, moduleId), eq(moduleStorage.key, "__since")))
    .limit(1);
  const waiting = await ranked(
    user,
    and(eq(issueClosures.userId, userId), eq(issueClosures.assigned, 1), gte(issueClosures.closedAt, Math.max(from, Number(since?.value ?? 0) || 0)), untold(userId, moduleId)),
  );
  const already = Math.max(0, Math.floor(opts.already ?? 0));
  const skip = new Set(already > 0 ? waiting.filter((c) => !isHigh(c)).slice(-already).map((c) => c.id) : []);
  const deliver = waiting.filter((c) => !skip.has(c.id));
  if (opts.apply) {
    if (skip.size > 0) await db.insert(moduleClosureClaims).values([...skip].map((closureId) => ({ userId, moduleId, closureId }))).onConflictDoNothing();
    await db
      .insert(moduleStorage)
      .values({ userId, moduleId, key: FROM, value: String(from), updatedAt: new Date() })
      .onConflictDoUpdate({ target: [moduleStorage.userId, moduleStorage.moduleId, moduleStorage.key], set: { value: String(from), updatedAt: new Date() } });
  }
  return { deliver: deliver.length, golden: deliver.filter(isHigh).length, skipped: waiting.filter((c) => skip.has(c.id)).map(told), applied: opts.apply === true };
}

const told = (c: ClaimedClosure): ClaimedClosure => ({ connectionId: c.connectionId, issueKey: c.issueKey, priority: c.priority, priorityRank: c.priorityRank });

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

/** Closures as told, oldest first: the issue's key now, its rank by its site's order now. */
async function ranked(user: User, where: SQL | undefined): Promise<(ClaimedClosure & { id: number })[]> {
  const rows = await getDb()
    .select({ id: issueClosures.id, connectionId: issues.connectionId, issueKey: issues.key, priority: issues.priority, priorityRank: issues.priorityRank, conn: connections })
    .from(issueClosures)
    .innerJoin(issues, eq(issues.id, issueClosures.itemId))
    .innerJoin(connections, eq(connections.id, issues.connectionId))
    .where(where)
    .orderBy(asc(issueClosures.closedAt), asc(issueClosures.id));
  const ranks = new Map<number, Map<string, number | null> | null>();
  const out: (ClaimedClosure & { id: number })[] = [];
  for (const r of rows) {
    if (r.conn.type === "jira" && !ranks.has(r.conn.id)) ranks.set(r.conn.id, await jiraRanks(user, r.conn));
    const now = r.priority ? ranks.get(r.conn.id)?.get(r.priority) : undefined;
    out.push({ id: r.id, connectionId: r.connectionId, issueKey: r.issueKey, priority: r.priority, priorityRank: now ?? r.priorityRank });
  }
  return out;
}

/** The next closures since `since` (epoch ms, and since closuresFrom) this module was not told yet, oldest first, now claimed. */
export async function claimClosures(user: User, moduleId: string, since: number, limit: number): Promise<ClaimedClosure[]> {
  const db = getDb();
  const from = Math.max(since, await closuresFrom(user.id, moduleId));
  const picked = await db
    .select({ id: issueClosures.id })
    .from(issueClosures)
    // Only the user's own (assigned to them when it closed): a teammate's closure is no carrot.
    .where(and(eq(issueClosures.userId, user.id), eq(issueClosures.assigned, 1), gte(issueClosures.closedAt, from), untold(user.id, moduleId)))
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
  return (await ranked(user, inArray(issueClosures.id, claimed.map((c) => c.id)))).map(told);
}
