// The worklog trash (worklog_trash, filled by the database on every delete):
// why a delete happens, told to the database, and what is kept 30 days.
import { lt, sql } from "drizzle-orm";
import { worklogTrash } from "@db/schema";
import { getDb } from "./connection";
import { purgeMarkdownNotes } from "./notes";

/** How long deleted worklogs can be restored. */
export const TRASH_DAYS = 30;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Tells the database why the worklog deletes of this transaction happen:
 * "user" (deleted in inkledger: to the trash, as such), "merged" (a duplicate
 * folded into its twin: no trace). Without it a delete counts as gone from
 * the service.
 */
export async function deletingAs(tx: Tx, reason: "user" | "merged") {
  await tx.execute(sql`select set_config('inkledger.delete_reason', ${reason}, true)`);
}

/** Runs `fn` in a transaction whose worklog deletes have `reason`. */
export function withDeleteReason<T>(reason: "user" | "merged", fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await deletingAs(tx, reason);
    return fn(tx);
  });
}

/** Worklog trash and Markdown notes older than TRASH_DAYS go for good. */
export async function purgeTrash(now: number = Date.now()): Promise<number> {
  const gone = await getDb()
    .delete(worklogTrash)
    .where(lt(worklogTrash.deletedAt, new Date(now - TRASH_DAYS * 86_400_000)))
    .returning({ id: worklogTrash.id });
  const notes = await purgeMarkdownNotes(now);
  return gone.length + notes;
}
