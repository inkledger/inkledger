import { and, eq, type AnyColumn, type SQL } from "drizzle-orm";
import { issues } from "@db/schema";

/** An issue row by its key on one connection, as the user's. Columns work too, for joins. */
export const issueAt = (userId: number | AnyColumn, connectionId: number | AnyColumn, key: string | AnyColumn): SQL =>
  and(eq(issues.userId, userId), eq(issues.connectionId, connectionId), eq(issues.key, key)) as SQL;
