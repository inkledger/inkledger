import { eq, sql } from "drizzle-orm";
import { serverSettings } from "@db/schema";
import { getDb } from "../queries/connection";

/** A server-wide setting (JSON), or `fallback` when unset or unreadable. */
export async function getServerSetting<T>(key: string, fallback: T): Promise<T> {
  const [row] = await getDb().select().from(serverSettings).where(eq(serverSettings.key, key)).limit(1);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

/**
 * A server-wide setting changed from what it is now, in one step: read and written in one
 * transaction under a lock on the key, so changes made at once (two admins, a poll and a
 * click) never drop each other's. `change` is pure: no calls out while the lock is held.
 */
export async function updateServerSetting<T>(key: string, fallback: T, change: (current: T) => T): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`server-setting:${key}`}))`);
    const [row] = await tx.select().from(serverSettings).where(eq(serverSettings.key, key)).limit(1);
    let current = fallback;
    if (row) {
      try {
        current = JSON.parse(row.value) as T;
      } catch {
        current = fallback;
      }
    }
    const next = change(current);
    const json = JSON.stringify(next);
    await tx
      .insert(serverSettings)
      .values({ key, value: json, updatedAt: new Date() })
      .onConflictDoUpdate({ target: serverSettings.key, set: { value: json, updatedAt: new Date() } });
    return next;
  });
}

export async function setServerSetting(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await getDb()
    .insert(serverSettings)
    .values({ key, value: json, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: json, updatedAt: new Date() } });
}
