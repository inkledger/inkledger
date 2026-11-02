import { and, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { issues } from "@db/schema";
import { myRemoteIds } from "../providers/connections";
import { issuesInBucket } from "./buckets";
import { CLOSED, compileIssueQuery } from "./issueQuery";
import { onLiveConnection } from "./liveConnections";

/** A tag a pinboard can follow: a label, or a Jira component. */
export type FollowTag = { field: "label" | "component"; value: string; connectionId: number | null };

/**
 * The user's open issues with a tag, as the Issues list shows them by default
 * (assigned to one of the user's accounts, not done, on a live connection, not
 * hidden, in the device's bucket), on one tracker or on every one; with no
 * tag, all of them.
 */
export async function openIssuesTagged(userId: number, deviceId: string | undefined, tag: FollowTag | null): Promise<SQL> {
  return (await openIssuesTagger(userId, deviceId))(tag);
}

/** openIssuesTagged for several tags: what they share (my ids, the device's bucket) read once. */
export async function openIssuesTagger(userId: number, deviceId: string | undefined): Promise<(tag: FollowTag | null) => SQL> {
  const [myIds, inBucket] = await Promise.all([myRemoteIds(userId), issuesInBucket(userId, deviceId)]);
  return (tag) => {
    const tagged = tag ? compileIssueQuery({ kind: "field", field: tag.field, op: "=", value: tag.value }, { myRemoteIds: myIds, now: new Date() }).where : undefined;
    return and(
      eq(issues.userId, userId),
      onLiveConnection,
      eq(issues.hidden, 0),
      notInArray(issues.category, CLOSED),
      inArray(issues.assigneeId, myIds),
      tag?.connectionId ? eq(issues.connectionId, tag.connectionId) : undefined,
      inBucket,
      tagged,
    )!;
  };
}
