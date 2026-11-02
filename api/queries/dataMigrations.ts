import { and, eq, isNull, sql } from "drizzle-orm";
import { markdownNotes, serverSettings, settings, users } from "@db/schema";
import { normalizeDashboardLayout } from "@contracts/dashboard";
import { dayKey } from "@contracts/time";
import { parseStringList } from "../lib/json";
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
  {
    // The full sync above left untouched issues without components (a row was rewritten
    // only when Jira changed it); now a different list rewrites it, so once more.
    id: "issue-components-resync",
    run: async (db) => {
      await db.execute(sql`UPDATE sync_state SET last_full_sync_at = NULL`);
    },
  },
  {
    // Notes have a day of their own now: the ones from before take the day they were
    // written. Local days, so in JS (the database's clock may be UTC, the app's is the host's).
    id: "note-noted-on",
    run: async (db) => {
      for (;;) {
        const rows = await db
          .select({ id: markdownNotes.id, createdAt: markdownNotes.createdAt })
          .from(markdownNotes)
          .where(and(isNull(markdownNotes.notedOn), eq(markdownNotes.kind, "note")))
          .limit(500);
        if (rows.length === 0) return;
        for (const row of rows) await db.update(markdownNotes).set({ notedOn: dayKey(row.createdAt) }).where(eq(markdownNotes.id, row.id));
      }
    },
  },
  {
    // The Dashboard layout lives in the workspace now: who hid sections before keeps them hidden.
    id: "dashboard-layout-to-workspace",
    run: async (db) => {
      const { seedLegacyDashboard } = await import("../workspace/service");
      const rows = await db.select({ userId: settings.userId, layout: settings.dashboardLayout }).from(settings);
      for (const row of rows) {
        let saved: unknown = null;
        try {
          saved = row.layout ? JSON.parse(row.layout) : null;
        } catch {
          saved = null;
        }
        const hidden = normalizeDashboardLayout(saved).filter(item => !item.visible).map(item => `dashboard.${item.id}`);
        await seedLegacyDashboard(row.userId, hidden);
      }
    },
  },
  {
    // Modules are granted one by one now: members already running them keep the ones installed today.
    id: "module-grants-for-existing",
    run: async (db) => {
      const { installedIds } = await import("../modules/registry");
      const ids = JSON.stringify(installedIds());
      await db
        .update(users)
        .set({ moduleGrants: ids })
        .where(sql`${users.role} <> 'admin' AND ${users.permissions}::jsonb ? 'useModules' AND ${users.moduleGrants} = '[]'`);
    },
  },
];

const DONE_KEY = "data-migrations.done";

async function done(db: Db): Promise<string[]> {
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.key, DONE_KEY)).limit(1);
  return row ? parseStringList(row.value) : [];
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
