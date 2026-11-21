import { readFileSync } from "node:fs";
import path from "node:path";

/** Raw SQL on whichever client is open (node-postgres pool or PGlite): both answer `{ rows }`. */
export type RawQuery = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * The setting a production server leaves on its database, so a dev server
 * never migrates it by accident. It names the database it was written in: a
 * production dump restored into a dev database doesn't carry the protection.
 */
const DB_OWNER_KEY = "db.owner";

type Owner = { role: "production"; database: string };

type JournalEntry = { tag: string; when: number };

/** The migrations this build ships (drizzle/meta/_journal.json), oldest first. */
export function readJournal(folder: string): JournalEntry[] {
  const raw = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return [...raw.entries].sort((a, b) => a.when - b.when);
}

/** Postgres "no such table" or "no such schema": what a fresh database answers. */
const notThereYet = (e: unknown) => ["42P01", "3F000"].includes(String((e as { code?: unknown }).code));

/**
 * A query on something that may not exist yet (a fresh database): no rows then.
 * Any other failure (no permission, a timeout) is thrown: read as "not marked",
 * it would let a dev process migrate a production database.
 */
async function rowsOrNone(query: RawQuery, text: string): Promise<Record<string, unknown>[]> {
  try {
    return (await query(text)).rows;
  } catch (e) {
    if (notThereYet(e)) return [];
    throw e;
  }
}

/** The production server's mark on this very database (see DB_OWNER_KEY). */
async function markedProduction(query: RawQuery): Promise<boolean> {
  const [owner] = await rowsOrNone(query, `select value from server_settings where key = '${DB_OWNER_KEY}'`);
  const [here] = await rowsOrNone(query, "select current_database() as name");
  let marked: Partial<Owner> = {};
  try {
    marked = typeof owner?.value === "string" ? (JSON.parse(owner.value) as Partial<Owner>) : {};
  } catch {
    /* unreadable: not marked */
  }
  return marked.role === "production" && marked.database === here?.name;
}

export type GuardOptions = {
  production: boolean;
  /** Lets a non-production process migrate a production database anyway (ALLOW_MIGRATE_PRODUCTION_DB=1). */
  allowProductionDb: boolean;
};

/**
 * Checked before migrating. Refuses to start when the database is ahead of
 * this build (an older image on a migrated database would run against a
 * schema it doesn't know), and refuses to migrate a production database from
 * a dev or test process (they used to share one: a dev start applied new
 * migrations under the running production server).
 */
export async function guardMigrations(query: RawQuery, journal: JournalEntry[], opts: GuardOptions): Promise<void> {
  const [last] = await rowsOrNone(query, "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1");
  const applied = last ? Number(last.created_at) : 0;
  const newest = journal.at(-1)?.when ?? 0;
  if (applied > newest) {
    throw new Error(
      `The database schema is newer than this build (applied migration from ${new Date(applied).toISOString()}, ` +
        `newest known ${new Date(newest).toISOString()}). Run a newer inkledger, or restore a backup taken with this version.`
    );
  }
  const pending = journal.filter((e) => e.when > applied);
  if (pending.length === 0 || opts.production || opts.allowProductionDb) return;
  if (await markedProduction(query)) {
    throw new Error(
      `Refusing to apply ${pending.length} migration(s) (${pending.map((e) => e.tag).join(", ")}) to a production database ` +
        `from a non-production process. Point DATABASE_URL at a dev database, or set ALLOW_MIGRATE_PRODUCTION_DB=1.`
    );
  }
}

/**
 * A production database opened by a dev or test process: it may use it as it
 * is, but runs no data step on it and seals none of its secrets again (those are
 * migrations too, and the production server's to run).
 */
export async function productionDbOfAnotherProcess(query: RawQuery, opts: GuardOptions): Promise<boolean> {
  if (opts.production || opts.allowProductionDb) return false;
  return markedProduction(query);
}

/** A production server marks its database as its own (after migrating, so the table exists). */
export async function markProductionDb(query: RawQuery): Promise<void> {
  const { rows } = await query("select current_database() as name");
  const name = rows[0]?.name;
  const owner: Owner = { role: "production", database: typeof name === "string" ? name : "" };
  await query(
    "insert into server_settings (key, value, updated_at) values ($1, $2, $3) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at",
    [DB_OWNER_KEY, JSON.stringify(owner), Date.now()]
  );
}
