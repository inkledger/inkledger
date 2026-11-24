// An account and everything it owns removed (users.erase), in one transaction and a fixed
// order: connection_id foreign keys don't cascade, so its connections are archived first
// (no sync picks them up meanwhile), then each table's rows of the person go, children
// before the tables they point at, then the connections (their own rows cascade), then the
// audit rows naming the person are pseudonymised, and the account goes last.
import { and, count, eq, getTableName, isNull } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { connections, users } from "@db/schema";
import type { getDb } from "../queries/connection";
import { pseudonymiseAudit } from "../lib/audit";
import { USER_DATA, columnOf, tableOf } from "./policy";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** A foreign key that holds a delete back (no cascade, no set null). */
const blocks = (onDelete: string | undefined) => onDelete === undefined || onDelete === "no action" || onDelete === "restrict";

/**
 * The person's tables (by user_id) in the order they are emptied: a table whose rows point
 * at another one's without cascading comes before it. Derived from the schema, so a new
 * reference reorders it by itself.
 */
export function eraseOrder(): string[] {
  const names = Object.entries(USER_DATA)
    .filter(([, p]) => p.kind === "user")
    .map(([n]) => n)
    .sort();
  const set = new Set(names);
  const before = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const n of names) {
    for (const fk of getTableConfig(tableOf(n)).foreignKeys) {
      const target = getTableName(fk.reference().foreignTable);
      // n points at target: n's rows go first.
      if (target !== n && set.has(target) && blocks(fk.onDelete)) before.get(target)?.add(n);
    }
  }
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (n: string) => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "visiting") throw new Error(`gdpr: delete order has a cycle at ${n}`);
    state.set(n, "visiting");
    for (const m of [...(before.get(n) ?? [])].sort()) visit(m);
    state.set(n, "done");
    out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}

async function deleteRows(tx: Tx, table: PgTable, column: string, userId: number): Promise<number> {
  const col = columnOf(table, column).column;
  const [{ n }] = await tx.select({ n: count() }).from(table).where(eq(col, userId));
  if (n > 0) await tx.delete(table).where(eq(col, userId));
  return n;
}

/** What an erasure removed: rows per table, and how many audit rows it pseudonymised. */
export type Erased = { rows: Record<string, number>; connections: number; auditPseudonymised: number };

/**
 * Everything of account `userId` deleted, inside `tx` (the caller holds the owners' lock and
 * has checked who may). Its audit rows stay, pseudonymised (api/lib/audit.ts).
 */
export async function eraseUser(tx: Tx, userId: number, now = new Date()): Promise<Erased> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!user) throw new Error("gdpr: no such account");
  await tx.update(connections).set({ archivedAt: now }).where(and(eq(connections.userId, userId), isNull(connections.archivedAt)));
  const rows: Record<string, number> = {};
  for (const name of eraseOrder()) {
    const n = await deleteRows(tx, tableOf(name), "user_id", userId);
    if (n > 0) rows[name] = n;
  }
  const gone = await deleteRows(tx, connections, "user_id", userId);
  const auditPseudonymised = await pseudonymiseAudit(tx, userId, [user.username ?? "", user.displayName, user.email], now.getTime());
  await tx.delete(users).where(eq(users.id, userId));
  return { rows, connections: gone, auditPseudonymised };
}
