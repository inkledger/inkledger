// Which worklogs a view counts (D9): Timesheet and Report follow this
// device's bucket unless "All" is on, and read the search language. The
// day's gaps, placement and overlap never come through here: they always
// see all the time (a bucket filters what is shown, never what is free).
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { bucketSources, issues, worklogs } from "@db/schema";
import { parseQuery } from "@contracts/query";
import { activeBucket, bucketQuery, coversIssue } from "./buckets";
import { compileIssueQuery } from "./issueQuery";
import { myRemoteIds } from "../providers/connections";

/**
 * A worklog's issue: by its link (item_id), or by key for one not linked
 * yet. Two connections with the same key never mix this way.
 */
export const issueOfWorklog = or(
  eq(worklogs.itemId, issues.id),
  and(isNull(worklogs.itemId), eq(worklogs.userId, issues.userId), eq(worklogs.connectionId, issues.connectionId), eq(worklogs.issueKey, issues.key)),
);

export type WorklogScope = { scope?: "bucket" | "all"; search?: string };

/** Conditions on worklogs for a view, and the query terms that couldn't be applied. */
export async function worklogScope(userId: number, deviceId: string | undefined, input: WorklogScope): Promise<{ where: SQL[]; unsupported: string[] }> {
  const where: SQL[] = [];
  const bucket = input.scope === "bucket" ? await activeBucket(userId, deviceId) : null;
  if (bucket !== null) {
    // Its issue in the bucket (and its search); one not in the catalogue counts when the bucket takes its whole tracker and has no search.
    const narrowed = await bucketQuery(userId, bucket);
    const covered = narrowed ? and(coversIssue(bucket), narrowed) : coversIssue(bucket);
    where.push(
      narrowed
        ? sql`EXISTS (SELECT 1 FROM ${issues} WHERE ${issueOfWorklog} AND ${covered})`
        : sql`(EXISTS (SELECT 1 FROM ${issues} WHERE ${issueOfWorklog} AND ${covered}) OR (NOT EXISTS (SELECT 1 FROM ${issues} WHERE ${issueOfWorklog}) AND EXISTS (SELECT 1 FROM ${bucketSources} s WHERE s.bucket_id = ${bucket} AND s.connection_id = ${worklogs.connectionId} AND s.container_id IS NULL)))`,
    );
  }
  const search = input.search?.trim() ?? "";
  if (!search) return { where, unsupported: [] };
  const compiled = compileIssueQuery(parseQuery(search).expr, { myRemoteIds: await myRemoteIds(userId), now: new Date() });
  // The search reads the worklog's issue (a worklog whose issue isn't in the catalogue matches by its key only).
  if (compiled.where) {
    where.push(sql`(EXISTS (SELECT 1 FROM ${issues} WHERE ${and(issueOfWorklog, compiled.where)}) OR (NOT EXISTS (SELECT 1 FROM ${issues} WHERE ${issueOfWorklog}) AND ${worklogs.issueKey} ILIKE ${`%${search.replace(/[%_\\]/g, "\\$&")}%`}))`);
  }
  return { where, unsupported: compiled.unsupported };
}
