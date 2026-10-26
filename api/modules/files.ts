import { and, asc, eq, lt, sql } from "drizzle-orm";
import { moduleFiles } from "@db/schema";
import { FILES_MAX_COUNT, FILES_MAX_IDLE_MS, FILES_MAX_TOTAL_BYTES } from "@contracts/modules";
import { getDb } from "../queries/connection";

/**
 * Module files: a per-user cache of what a module made (the Bonsai's renders,
 * drawn on one device and reused on the others). Never allowed to pile up:
 * - per user and module, at most FILES_MAX_COUNT files and FILES_MAX_TOTAL_BYTES,
 *   the least recently used going first when a new one comes in;
 * - files unread for FILES_MAX_IDLE_MS go (purgeIdleModuleFiles, with the other purges);
 * - an uninstalled module's files go with it (removeModuleFiles).
 */

const own = (userId: number, moduleId: string) => and(eq(moduleFiles.userId, userId), eq(moduleFiles.moduleId, moduleId));

export async function getModuleFile(userId: number, moduleId: string, key: string) {
  const db = getDb();
  const where = and(own(userId, moduleId), eq(moduleFiles.key, key));
  const [row] = await db.select({ data: moduleFiles.data, contentType: moduleFiles.contentType }).from(moduleFiles).where(where).limit(1);
  if (!row) return null;
  await db.update(moduleFiles).set({ usedAt: new Date() }).where(where);
  return row;
}

export async function putModuleFile(userId: number, moduleId: string, key: string, contentType: string, data: Buffer) {
  const now = new Date();
  // Write and trim as one step per user and module: parallel writes never leave more than the caps.
  await getDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`module-files:${moduleId}`}), ${userId})`);
    await tx
      .insert(moduleFiles)
      .values({ userId, moduleId, key, contentType, data, size: data.length, updatedAt: now, usedAt: now })
      .onConflictDoUpdate({
        target: [moduleFiles.userId, moduleFiles.moduleId, moduleFiles.key],
        set: { contentType, data, size: data.length, updatedAt: now, usedAt: now },
      });
    // Over the caps: the least recently used go, never the one just written.
    const rows = await tx
      .select({ key: moduleFiles.key, size: moduleFiles.size })
      .from(moduleFiles)
      .where(own(userId, moduleId))
      .orderBy(asc(moduleFiles.usedAt));
    let count = rows.length;
    let total = rows.reduce((a, r) => a + r.size, 0);
    for (const r of rows) {
      if (count <= FILES_MAX_COUNT && total <= FILES_MAX_TOTAL_BYTES) break;
      if (r.key === key) continue;
      await tx.delete(moduleFiles).where(and(own(userId, moduleId), eq(moduleFiles.key, r.key)));
      count -= 1;
      total -= r.size;
    }
  });
}

export async function deleteModuleFile(userId: number, moduleId: string, key: string) {
  await getDb().delete(moduleFiles).where(and(own(userId, moduleId), eq(moduleFiles.key, key)));
}

/** Every user's files of a module (it was uninstalled). */
export async function removeModuleFiles(moduleId: string) {
  await getDb().delete(moduleFiles).where(eq(moduleFiles.moduleId, moduleId));
}

/** Files nobody read for a month. */
export async function purgeIdleModuleFiles(now = Date.now()) {
  await getDb().delete(moduleFiles).where(lt(moduleFiles.usedAt, new Date(now - FILES_MAX_IDLE_MS)));
}

/** How much a user's module keeps (tests, diagnostics). */
export async function moduleFilesUsage(userId: number, moduleId: string) {
  const [r] = await getDb()
    .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${moduleFiles.size}), 0)::int` })
    .from(moduleFiles)
    .where(own(userId, moduleId));
  return r ?? { count: 0, bytes: 0 };
}
