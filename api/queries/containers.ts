// Containers (projects, repositories, boards…) of a connection, found by
// their id on the service; one known only by its key (from before
// containers, or the Jira path) is taken over and gets its real id.
import { and, eq, like } from "drizzle-orm";
import { containers } from "@db/schema";
import type { ContainerRef } from "../providers/types";
import { getDb } from "./connection";

export async function ensureContainer(connectionId: number, c: ContainerRef): Promise<number> {
  const db = getDb();
  const fields = { key: c.key, name: c.name, kind: c.kind, avatarUrl: c.avatarUrl ?? null, ...(c.group !== undefined ? { groupName: c.group } : {}) };
  const [known] = await db
    .update(containers)
    .set(fields)
    .where(and(eq(containers.connectionId, connectionId), eq(containers.remoteId, c.remoteId)))
    .returning({ id: containers.id });
  if (known) return known.id;
  const [byKey] = await db
    .update(containers)
    .set({ ...fields, remoteId: c.remoteId })
    .where(and(eq(containers.connectionId, connectionId), eq(containers.key, c.key), like(containers.remoteId, "key:%")))
    .returning({ id: containers.id });
  if (byKey) return byKey.id;
  const [made] = await db
    .insert(containers)
    .values({ connectionId, remoteId: c.remoteId, ...fields })
    .onConflictDoUpdate({ target: [containers.connectionId, containers.remoteId], set: fields })
    .returning({ id: containers.id });
  return made.id;
}
