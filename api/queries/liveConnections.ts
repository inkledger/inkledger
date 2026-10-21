// What the lists show: issues of the user's live connections only, and only
// those still there (gone: deleted, out of reach, or in a repository the user
// left out). An archived connection's issues leave every list; time stays
// where time is counted (worklogs, reports, totals).
import { sql, type SQL } from "drizzle-orm";
import { connections, issues, notifications } from "@db/schema";

/**
 * The issue is still there, on a live (not archived) connection, and shown
 * once: the same issue reached by two connections of one service (two
 * GitHub accounts following one repository, two logins on one Jira site)
 * is the same item (§4.5, dedup by ref): the first connection shows it.
 */
export const onLiveConnection: SQL = sql`(${issues.goneAt} IS NULL AND ${issues.connectionId} IN (SELECT ${connections.id} FROM ${connections} WHERE ${connections.archivedAt} IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM ${issues} twin
      JOIN ${connections} tc ON tc.id = twin.connection_id
      JOIN ${connections} mc ON mc.id = ${issues.connectionId}
     WHERE twin.user_id = ${issues.userId} AND twin.jira_id = ${issues.remoteId} AND twin.connection_id < ${issues.connectionId}
       AND twin.gone_at IS NULL AND tc.archived_at IS NULL AND tc.type = mc.type AND tc.base_url = mc.base_url))`;

/** A notification's connection is live (one with no connection stays). */
export const notificationOnLiveConnection: SQL = sql`(${notifications.connectionId} IS NULL OR ${notifications.connectionId} IN (SELECT ${connections.id} FROM ${connections} WHERE ${connections.archivedAt} IS NULL))`;
