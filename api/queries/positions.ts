// A manual order written in one statement (UPDATE … FROM VALUES) instead of
// one update per row.
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./connection";

/**
 * Each row (by `id`) to its new `position`, only where `where` holds. An id
 * given twice takes its last position, as one update after another would.
 */
export async function setPositions(
  tx: Pick<Db, "execute">,
  table: PgTable,
  columns: { id: PgColumn; position: PgColumn },
  order: Iterable<readonly [id: number, position: number]>,
  where?: SQL,
): Promise<void> {
  const last = new Map(order);
  if (last.size === 0) return;
  const values = sql.join([...last].map(([id, position]) => sql`(${id}::bigint, ${position}::bigint)`), sql`, `);
  await tx.execute(
    sql`UPDATE ${table} SET ${sql.identifier(columns.position.name)} = v.position FROM (VALUES ${values}) AS v(id, position) WHERE ${columns.id} = v.id${where ? sql` AND ${where}` : sql``}`,
  );
}
