import path from "node:path";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";
import { runDataMigrations } from "./dataMigrations";
import { resealCredentials } from "./credentials";
import { guardMigrations, markProductionDb, readJournal, type RawQuery } from "./migrationGuard";

const fullSchema = { ...schema, ...relations };

/** The app's database: Postgres (shared by the container and the dev server), PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof fullSchema>;

// Epoch milliseconds live in bigint columns, and sum()/count() return
// bigint/numeric: read them as numbers (all well below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/** drizzle-kit migrations (db/schema.ts → drizzle/); next to dist/ in the image. */
function migrationsFolder(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle");
}

/** When the newest migration this build knows was made (its journal's `when`). */
export function newestMigration(): number {
  return readJournal(migrationsFolder()).at(-1)?.when ?? 0;
}

let instance: Db | undefined;
let close: (() => Promise<void>) | undefined;
let pending: Promise<Db> | undefined;
let remigrate: (() => Promise<void>) | undefined;

type Opened = { db: Db; close: () => Promise<void>; migrate: () => Promise<void> };

/**
 * Schema migrations (guarded: see migrationGuard.ts), then the data
 * migrations. Also run again after a restore replaced the schema.
 */
function migrator(db: Db, query: RawQuery, schemaUp: () => Promise<unknown>) {
  return async () => {
    const folder = migrationsFolder();
    await guardMigrations(query, readJournal(folder), {
      production: env.isProduction,
      allowProductionDb: env.allowMigrateProductionDb,
    });
    await schemaUp();
    if (env.isProduction) await markProductionDb(query);
    await runDataMigrations(db);
    const resealed = await resealCredentials(db);
    if (resealed > 0) console.log(`[credentials] ${resealed} connection secret(s) sealed again with the current key`);
  };
}

async function open(url: string): Promise<Opened> {
  // Under the tests only an in-process database: a test must never write to a real one.
  if (process.env.VITEST && !(url === ":memory:" || url.startsWith("pglite:"))) {
    throw new Error(`Tests may only use an in-process database, not ${url.replace(/\/\/[^@]*@/, "//***@")}`);
  }
  // Tests: an in-process Postgres (":memory:" kept for the existing test setup).
  if (url === ":memory:" || url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dir = url.startsWith("pglite:") && url !== "pglite:memory" ? url.slice("pglite:".length) : undefined;
    const client = new PGlite({ dataDir: dir, extensions: { pg_trgm }, parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) } });
    const db = drizzle(client, { schema: fullSchema }) as unknown as Db;
    const query: RawQuery = (text, params) => client.query(text, params);
    const up = migrator(db, query, () => migrate(drizzle(client), { migrationsFolder: migrationsFolder() }));
    await up();
    return { db, close: () => client.close(), migrate: up };
  }
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema: fullSchema }) as unknown as Db;
  const query: RawQuery = (text, params) => pool.query(text, params);
  const up = migrator(db, query, () => migrate(drizzle(pool), { migrationsFolder: migrationsFolder() }));
  await up();
  return { db, close: () => pool.end(), migrate: up };
}

/** Connects and applies pending migrations (once). The server awaits it at start. */
export function initDb(): Promise<Db> {
  if (instance) return Promise.resolve(instance);
  pending ??= open(env.databaseUrl).then((o) => {
    instance = o.db;
    close = o.close;
    remigrate = o.migrate;
    return o.db;
  });
  return pending;
}

/** Applies pending schema and data migrations again (after a restore replaced the schema). */
export async function migrateDb(): Promise<void> {
  await remigrate?.();
}

export function getDb(): Db {
  if (!instance) throw new Error("Database not initialized: await initDb() at startup");
  return instance;
}

/** Liveness probe: a trivial query. */
export async function pingDb(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Delete expired sessions; returns how many were removed. */
export async function purgeExpiredSessions(): Promise<number> {
  const gone = await getDb()
    .delete(schema.sessions)
    .where(sql`${schema.sessions.expiresAt} <= ${Date.now()}`)
    .returning({ id: schema.sessions.id });
  return gone.length;
}

/** Close the connections (graceful shutdown). */
export async function closeDb() {
  const c = close;
  instance = undefined;
  pending = undefined;
  close = undefined;
  remigrate = undefined;
  await c?.();
}

/** Test helper: a fresh, migrated database (DATABASE_URL=":memory:"). */
export async function resetDbForTests(): Promise<Db> {
  await closeDb();
  return initDb();
}

/**
 * Test helper: raw SQL with "?" placeholders (as the tests were written for
 * SQLite), rows back. Never used by the app.
 */
export async function q<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
  let n = 0;
  const pgText = text.replace(/\?/g, () => `$${++n}`);
  const db = getDb() as unknown as { $client: { query: (t: string, p: unknown[]) => Promise<{ rows: T[] }> } };
  return (await db.$client.query(pgText, params)).rows;
}
