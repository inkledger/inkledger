// What every estimate of a user depends on (docs/work/ideas/estimates.md R-3.15).
// Raised by the triggers of migration 0018 on every write that changes an
// estimate, and by the history job; always the one atomic statement of
// inkledger_raise_estimate_revision, never read-then-write here.
import { eq, sql } from "drizzle-orm";
import { estimateRevisions } from "@db/schema";
import { getDb, type Db } from "./connection";

/** Raises the user's revision, within the caller's transaction when given one. */
export async function raiseEstimateRevision(db: Pick<Db, "execute">, userId: number): Promise<void> {
  await db.execute(sql`SELECT inkledger_raise_estimate_revision(${userId})`);
}

/** The user's revision (0 before any raise), as a bigint: compared as such, keyed by its decimal string. */
export async function estimateRevision(userId: number): Promise<bigint> {
  const [row] = await getDb().select({ revision: estimateRevisions.revision }).from(estimateRevisions).where(eq(estimateRevisions.userId, userId)).limit(1);
  return row?.revision ?? 0n;
}
