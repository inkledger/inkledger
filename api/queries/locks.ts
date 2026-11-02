// Transaction-scoped advisory locks: held until the transaction that took
// them ends. The keys are the ones each caller always used (never change one:
// a running server and a new one must take the same lock).
import { sql } from "drizzle-orm";
import type { Db } from "./connection";

/** A transaction, or the database itself (a lock outside a transaction ends with its statement). */
type Executor = Pick<Db, "execute">;

/** Holds `key`, one 64-bit lock (hashtextextended(key, 0)). */
export async function xactLock(tx: Executor, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Holds `id` within the namespace `ns`, two 32-bit keys (hashtext(ns), id). */
export async function xactLockIn(tx: Executor, ns: string, id: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ns}), ${id})`);
}
