import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { clientContainers, clients, containers, issues, type Connection, type User } from "@db/schema";
import { boundTracker } from "../sync/engine";
import { formatQuery, parseQuery, queryText } from "@contracts/query";
import { providerName } from "@contracts/providerNames";
import type { RemoteIssue } from "../providers/types";
import { ProviderError } from "../providers/core/errors";
import { t } from "@contracts/i18n";

function isKeyQuery(query: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(query.trim());
}

/** JQL for free-text global search: exact key, or full-text match. */
export function buildSearchJql(query: string): string {
  const q = query.trim();
  if (isKeyQuery(q)) {
    return `key = ${q.toUpperCase()}`;
  }
  // Lucene/JQL operators in free text break the query: blank them out.
  const escaped = q.replace(/[+\-&|!(){}[\]^~*?:\\"]/g, " ");
  return `text ~ "${escaped}" ORDER BY updated DESC`;
}

/**
 * A tracker's answers of the last minute, by user, connection and query (a tracker isn't asked
 * twice for the same). Only what the tracker said: whether the user has an issue here, or
 * watches it, is read afresh on every search (an import or a watch shows at once).
 */
const searchCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof askTracker>> }>();
const SEARCH_TTL_MS = 60_000;

export async function searchConnection(user: User, conn: Connection, query: string) {
  const key = `${user.id}|${conn.id}|${query}`;
  const hit = searchCache.get(key);
  let said = hit && Date.now() - hit.at < SEARCH_TTL_MS ? hit.value : undefined;
  if (!said) {
    said = await askTracker(conn, query);
    if (!said.failed) searchCache.set(key, { at: Date.now(), value: said });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!);
  }
  return withLocalState(user, conn, said);
}

/**
 * One tracker's answer to a search: a key or link is found directly; the
 * rest is said in the tracker's own query language (translate), or as its
 * words only; what it can't say is named in `unsupported`.
 */
async function askTracker(conn: Connection, query: string) {
  const label = conn.label || conn.displayName || providerName(conn.type);
  const b = boundTracker(conn);
  const none = { label, canWatch: !!b?.watch, found: [] as RemoteIssue[], unsupported: [] as string[], failed: null as { connectionId: number; label: string; message: string } | null };
  if (!b) return none;
  const parsed = parseQuery(query);
  let found: RemoteIssue[] = [];
  let unsupported: string[] = [];
  try {
    const handle = b.parseRef(query.trim());
    const direct = handle ? await b.findIssue(callMeta(), handle) : { kind: "none" as const };
    if (direct.kind === "found") found = [direct.issue];
    else if (direct.kind === "ambiguous") found = direct.candidates;
    else if (handle) found = [];
    else if (b.translate && b.query) {
      const said = b.translate(parsed.expr, new Date());
      unsupported = said.unsupported;
      found = said.query ? (await b.query(callMeta(), said.query, 25)).items : [];
    } else if (b.searchText) {
      // Words only: the operators are named as not applied.
      const words = queryText(parsed.expr);
      unsupported = formatQuery(parsed.expr, "en") !== words ? [formatQuery(parsed.expr, "en")] : [];
      found = words ? (await b.searchText(callMeta(), words, 25)).items : [];
    }
  } catch (e) {
    // The tracker's refusal in its words, as the other calls show it; any other fault in
    // general words, its details in the log.
    if (!(e instanceof ProviderError)) console.error(e);
    return { ...none, failed: { connectionId: conn.id, label, message: e instanceof ProviderError ? e.message : t("server.internal.error") } };
  }
  return { ...none, found, unsupported };
}

/** The tracker's answer as the user sees it: which issues are already here, watched, and whose client. */
async function withLocalState(user: User, conn: Connection, said: Awaited<ReturnType<typeof askTracker>>) {
  const none = { connectionId: conn.id, results: [] as SearchResult[], unsupported: said.unsupported, failed: said.failed };
  const { found, label } = said;
  if (found.length === 0) return none;
  const db = getDb();
  const local = await db
    .select({ remoteId: issues.remoteId, watching: issues.watching })
    .from(issues)
    .where(and(eq(issues.userId, user.id), eq(issues.connectionId, conn.id), inArray(issues.remoteId, found.map((i) => i.remoteId))));
  const known = new Map(local.map((l) => [l.remoteId, l]));
  // The client of each project, for the badge.
  const owners = await db
    .select({ key: containers.key, client: clients.name })
    .from(containers)
    .innerJoin(clientContainers, eq(clientContainers.containerId, containers.id))
    .innerJoin(clients, eq(clients.id, clientContainers.clientId))
    .where(and(eq(containers.connectionId, conn.id), inArray(containers.key, [...new Set(found.map((i) => i.container.key))])));
  const clientOf = new Map(owners.map((o) => [o.key, o.client]));
  const results: SearchResult[] = found.map((issue) => {
    const mine = known.get(issue.remoteId);
    return {
      connectionId: conn.id,
      connectionLabel: label,
      key: issue.key,
      remoteId: issue.remoteId,
      summary: issue.title,
      status: issue.status.name,
      category: issue.status.category,
      projectKey: issue.container.key,
      client: clientOf.get(issue.container.key) ?? null,
      assignee: issue.assignees[0]?.name ?? null,
      isMine: conn.remoteAccountId !== "" && issue.assignees.some((p) => p.remoteId === conn.remoteAccountId),
      imported: mine !== undefined,
      watching: mine?.watching === 1,
      canWatch: said.canWatch,
      url: issue.url,
      updatedAt: issue.updatedAt ?? null,
    };
  });
  return { ...none, results };
}

type SearchResult = {
  connectionId: number;
  connectionLabel: string;
  key: string;
  remoteId: string;
  summary: string;
  status: string;
  category: string;
  projectKey: string;
  client: string | null;
  assignee: string | null;
  isMine: boolean;
  imported: boolean;
  watching: boolean;
  canWatch: boolean;
  url: string;
  updatedAt: number | null;
};

export const callMeta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `ui-${Date.now()}` });
