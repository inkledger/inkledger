// Buckets narrow the lists to some sources, per device (D8, D9): what the
// device chose, and the condition that keeps an issue (or a notice) in.
import { and, eq, sql, type SQL } from "drizzle-orm";
import { bucketSources, buckets, devicePrefs, issues, notifications } from "@db/schema";
import { getDb } from "./connection";
import { parseQuery } from "@contracts/query";
import { compileIssueQuery } from "./issueQuery";
import { myRemoteIds } from "../providers/connections";

/** The bucket this device has on (null: everything). */
export async function activeBucket(userId: number, deviceId: string | undefined): Promise<number | null> {
  if (!deviceId) return null;
  const [row] = await getDb()
    .select({ bucketId: devicePrefs.bucketId })
    .from(devicePrefs)
    .innerJoin(buckets, eq(buckets.id, devicePrefs.bucketId))
    .where(and(eq(devicePrefs.userId, userId), eq(devicePrefs.deviceId, deviceId), eq(buckets.userId, userId)))
    .limit(1);
  return row?.bucketId ?? null;
}

/** An issue is in the bucket when one of its sources covers its connection (all of it, or its container). */
export const coversIssue = (bucketId: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${bucketSources} s WHERE s.bucket_id = ${bucketId} AND s.connection_id = ${issues.connectionId} AND (s.container_id IS NULL OR s.container_id = ${issues.containerId}))`;

/** A notice is, by its connection (and its issue's container when the issue is in the catalogue). */
const coversNotification = (bucketId: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${bucketSources} s WHERE s.bucket_id = ${bucketId} AND s.connection_id = ${notifications.connectionId} AND (s.container_id IS NULL OR s.container_id = ${issues.containerId}))`;

/** The device's bucket as a condition on issues, or none. */
export async function issuesInBucket(userId: number, deviceId: string | undefined): Promise<SQL | undefined> {
  const id = await activeBucket(userId, deviceId);
  if (id === null) return undefined;
  const narrowed = await bucketQuery(userId, id);
  return narrowed ? and(coversIssue(id), narrowed) : coversIssue(id);
}

/** A bucket's own search, as a condition on issues (none when it has none). */
export async function bucketQuery(userId: number, bucketId: number): Promise<SQL | undefined> {
  const [row] = await getDb().select({ query: buckets.query }).from(buckets).where(eq(buckets.id, bucketId)).limit(1);
  if (!row?.query) return undefined;
  const compiled = compileIssueQuery(parseQuery(row.query).expr, { myRemoteIds: await myRemoteIds(userId), now: new Date() });
  return compiled.where ?? undefined;
}

/** The device's bucket as a condition on notifications (joined with their issue), or none. */
export async function notificationsInBucket(userId: number, deviceId: string | undefined): Promise<SQL | undefined> {
  const id = await activeBucket(userId, deviceId);
  return id === null ? undefined : coversNotification(id);
}
