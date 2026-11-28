// Who may chat with whom about which issue (contracts/chat.ts). A thread is about an issue on
// one tracker; each member reaches it through their own connection to that tracker. Only a
// teammate (someone sharing a team) with a connection to the same tracker may be asked in, and
// only once the tracker, asked with *their* connection, shows them the issue: a chat never shows
// an issue's words to someone the tracker wouldn't. Reads only: nothing here writes to a tracker.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { connections, issues, itemAliases, users, type Connection } from "@db/schema";
import type { ChatCandidate } from "@contracts/chat";
import { getDb } from "../queries/connection";
import { membersOf, teamsOf } from "../queries/accounts";
import { boundTracker } from "../sync/engine";
import { callMeta } from "../lib/callMeta";
import { ProviderError } from "../providers/core/errors";
import type { RemoteIssue } from "../providers/types";

/** The tracker an issue lives on, as a thread names it. */
export type TrackerOf = { trackerType: string; trackerBase: string };

/** The people who share a team with `userId` (not themselves), with the teams they share. */
export async function teammates(userId: number): Promise<Map<number, string[]>> {
  const mine = (await teamsOf([userId])).get(userId) ?? [];
  const ids = (await membersOf(mine.map((t) => t.teamId))).filter((id) => id !== userId);
  const theirs = await teamsOf(ids);
  const shared = new Set(mine.map((t) => t.teamId));
  return new Map(ids.map((id) => [id, (theirs.get(id) ?? []).filter((t) => shared.has(t.teamId)).map((t) => t.name)]));
}

/**
 * Each user's connection to a tracker (live ones only): the one whose catalogue has the issue
 * when they hold several accounts there, else their oldest.
 */
export async function connectionsTo(userIds: number[], tracker: TrackerOf, remoteId: string | null): Promise<Map<number, Connection>> {
  const out = new Map<number, Connection>();
  if (userIds.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(connections)
    .where(and(inArray(connections.userId, userIds), eq(connections.type, tracker.trackerType), eq(connections.baseUrl, tracker.trackerBase), isNull(connections.archivedAt)))
    .orderBy(asc(connections.id));
  const holding = new Set<number>();
  if (remoteId !== null && rows.length > 0) {
    const has = await getDb()
      .select({ connectionId: issues.connectionId })
      .from(issues)
      .where(and(inArray(issues.connectionId, rows.map((r) => r.id)), eq(issues.remoteId, remoteId)));
    for (const h of has) holding.add(h.connectionId);
  }
  for (const r of rows) {
    const had = out.get(r.userId);
    if (!had || (!holding.has(had.id) && holding.has(r.id))) out.set(r.userId, r);
  }
  return out;
}

/** Teammates as the picker shows them, each with why they can't be asked in (null: they can). */
export async function candidates(userId: number, tracker: TrackerOf, remoteId: string | null): Promise<ChatCandidate[]> {
  const mates = await teammates(userId);
  const ids = [...mates.keys()];
  if (ids.length === 0) return [];
  const people = await getDb()
    .select({ id: users.id, name: users.displayName, username: users.username, avatarUrl: users.avatarUrl, disabledAt: users.disabledAt })
    .from(users)
    .where(inArray(users.id, ids));
  const conns = await connectionsTo(ids, tracker, remoteId);
  return people
    .map((p) => ({
      id: p.id,
      name: p.name || p.username || "",
      avatarUrl: p.avatarUrl,
      teams: mates.get(p.id) ?? [],
      ineligible: p.disabledAt ? ("disabled" as const) : conns.has(p.id) ? null : ("noConnection" as const),
    }))
    .sort((a, b) => Number(a.ineligible !== null) - Number(b.ineligible !== null) || a.name.localeCompare(b.name));
}

/** What the tracker said when asked, with someone's own connection, whether they see an issue. */
export type Reach = "ok" | "noAccess" | "reconnect" | "unreachable" | "unsupported";

/** Whether `conn`'s account sees the issue on its tracker, and the issue when it does: one read, nothing written. */
export async function lookIssue(conn: Connection, ref: { remoteId: string; key: string }): Promise<{ reach: Reach; issue: RemoteIssue | null }> {
  const b = boundTracker(conn);
  if (!b) return { reach: "unsupported", issue: null };
  try {
    const issue = await b.getIssue(callMeta("chat", 15_000), ref);
    return issue ? { reach: "ok", issue } : { reach: "noAccess", issue: null };
  } catch (e) {
    if (e instanceof ProviderError) {
      if (e.kind === "notFound" || e.kind === "forbidden") return { reach: "noAccess", issue: null };
      if (e.kind === "auth") return { reach: "reconnect", issue: null };
    }
    return { reach: "unreachable", issue: null };
  }
}

/** A user's own issue row for a thread's issue: by the tracker's id (when known), else by its key, else by an old key it had. */
export async function ownIssueRow(userId: number, connectionId: number, remoteId: string | null, key: string) {
  const db = getDb();
  const cols = { id: issues.id, key: issues.key, remoteId: issues.remoteId, summary: issues.summary, status: issues.status, category: issues.category, hidden: issues.hidden };
  if (remoteId !== null) {
    const [byId] = await db
      .select(cols)
      .from(issues)
      .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.remoteId, remoteId)))
      .limit(1);
    if (byId) return byId;
  }
  const [byKey] = await db
    .select(cols)
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.key, key)))
    .limit(1);
  if (byKey) return byKey;
  const [byAlias] = await db
    .select(cols)
    .from(itemAliases)
    .innerJoin(issues, eq(issues.id, itemAliases.itemId))
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(itemAliases.key, key)))
    .limit(1);
  return byAlias ?? null;
}
