import { and, asc, eq, isNull } from "drizzle-orm";
import { connections } from "@db/schema";
import { getDb } from "./connection";

/**
 * The connection a user's Jira data belongs to while it is the only one
 * (the one made from their login): the oldest live one.
 */
export async function primaryConnectionId(userId: number): Promise<number> {
  const [row] = await getDb()
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, userId), isNull(connections.archivedAt)))
    .orderBy(asc(connections.id))
    .limit(1);
  if (!row) throw new Error(`User ${userId} has no connection`);
  return row.id;
}
