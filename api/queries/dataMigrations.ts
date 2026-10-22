import { eq, sql } from "drizzle-orm";
import { serverSettings } from "@db/schema";
import type { Db } from "./connection";

/**
 * Data migrations: the work a SQL migration can't do (re-encrypting secrets,
 * resolving rows through a provider's API). Each step runs once, after the
 * schema migrations, at start and again after a restore (a restored database
 * may predate a step). Steps must be idempotent: a crash halfway runs the
 * step again on the next start. A failing step stops the start, so the app
 * never runs on half-migrated data.
 */
export type DataMigration = { id: string; run: (db: Db) => Promise<void> };

/** The steps, in order. Ids are permanent: never rename or reorder one that shipped. */
export const DATA_MIGRATIONS: DataMigration[] = [
  {
    // useModules is a permission now, granted by default: accounts from before keep running modules.
    id: "use-modules-granted",
    run: async (db) => {
      await db.execute(sql`UPDATE users SET permissions = (permissions::jsonb || '["useModules"]'::jsonb)::text WHERE role <> 'admin' AND NOT (permissions::jsonb ? 'useModules')`);
    },
  },
  {
    // Jira components are kept now: the next background sync reads every issue again
    // (full), so the ones synced before have theirs without waiting for the hourly full one.
    id: "issue-components-full-sync",
    run: async (db) => {
      // What makes a background pass full (syncScheduler's needsFullSync): never the first-sync state.
      await db.execute(sql`UPDATE sync_state SET last_full_sync_at = NULL`);
    },
  },
];

const DONE_KEY = "data-migrations.done";

async function done(db: Db): Promise<string[]> {
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, DONE_KEY)).limit(1);
  if (!row) return [];
  try {
    const ids = JSON.parse(row.value) as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function record(db: Db, ids: string[]) {
  const value = JSON.stringify(ids);
  await db
    .insert(serverSettings)
    .values({ key: DONE_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value, updatedAt: new Date() } });
}

/** Runs the steps not run yet on this database; returns the ids it ran. */
export async function runDataMigrations(db: Db, steps: DataMigration[] = DATA_MIGRATIONS): Promise<string[]> {
  const ran: string[] = [];
  let ids = await done(db);
  for (const step of steps) {
    if (ids.includes(step.id)) continue;
    try {
      await step.run(db);
    } catch (e) {
      throw new Error(`Data migration "${step.id}" failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    ids = [...ids, step.id];
    await record(db, ids);
    ran.push(step.id);
  }
  return ran;
}
