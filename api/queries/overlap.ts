import { TRPCError } from "@trpc/server";
import { and, eq, gte, lt } from "drizzle-orm";
import { worklogs } from "@db/schema";
import { MAX_WORKLOG_SECONDS } from "@contracts/time";
import { conflictMessage, occupiedId, overlapping } from "@contracts/placement";
import { t } from "@contracts/i18n";
import { getDb } from "./connection";
import { getSettings } from "../routers/settings";

/**
 * With the "block" policy, time is never logged twice: refuse a block that
 * covers another worklog of the user (local copy: last sync plus what the
 * app logged).
 */
export async function assertNoOverlap(
  userId: number,
  block: { start: Date; seconds: number },
  /** The entry being edited, by `occupiedId` (a remote id alone may be on two trackers) */
  exceptId?: string,
  /** Refused whatever the policy (time said to be free: a timer counted from a gap's start). */
  always = false,
): Promise<void> {
  // Parallel work is allowed by default (D12): only "block" refuses it; the app warns.
  if (!always && (await getSettings(userId)).overlapPolicy !== "block") return;
  const from = new Date(block.start.getTime() - MAX_WORKLOG_SECONDS * 1000);
  const to = new Date(block.start.getTime() + block.seconds * 1000);
  const near = await getDb()
    .select({
      connectionId: worklogs.connectionId,
      remoteId: worklogs.remoteId,
      issueKey: worklogs.issueKey,
      started: worklogs.started,
      seconds: worklogs.timeSpentSeconds,
    })
    .from(worklogs)
    .where(and(eq(worklogs.userId, userId), gte(worklogs.started, from), lt(worklogs.started, to)));
  const hits = overlapping(
    block,
    near.map((w) => ({ start: w.started, seconds: w.seconds, id: occupiedId(w), label: w.issueKey })),
    exceptId,
  );
  if (hits.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: t("server.worklogs.overlapHint", { message: conflictMessage(hits) }),
    });
  }
}
