import { eq } from "drizzle-orm";
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

export async function setServerSetting(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await getDb()
    .insert(serverSettings)
    .values({ key, value: json, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: json, updatedAt: new Date() } });
}
