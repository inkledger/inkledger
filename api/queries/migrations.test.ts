import { describe, expect, it } from "vitest";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { guardMigrations, markProductionDb, readJournal, type RawQuery } from "./migrationGuard";
import { runDataMigrations } from "./dataMigrations";

const folder = path.resolve(process.cwd(), "drizzle");
const journal = readJournal(folder);
const dev = { production: false, allowProductionDb: false };

async function fresh() {
  const client = new PGlite({ extensions: { pg_trgm } });
  const query: RawQuery = (text, params) => client.query(text, params);
  return { client, query, up: () => migrate(drizzle(client), { migrationsFolder: folder }) };
}

describe("migration guard", () => {
  it("lets any process migrate a fresh database", async () => {
    const { query } = await fresh();
    await expect(guardMigrations(query, journal, dev)).resolves.toBeUndefined();
  });

  it("refuses to migrate a production database from a dev process", async () => {
    const { query, up } = await fresh();
    // A production database one migration behind this build.
    await up();
    await markProductionDb(query);
    await query("delete from drizzle.__drizzle_migrations where created_at = $1", [journal.at(-1)!.when]);
    await expect(guardMigrations(query, journal, dev)).rejects.toThrow(/production database/);
    await expect(guardMigrations(query, journal, { ...dev, allowProductionDb: true })).resolves.toBeUndefined();
    await expect(guardMigrations(query, journal, { ...dev, production: true })).resolves.toBeUndefined();
  });

  it("a production dump restored into another database isn't protected there", async () => {
    const { query, up } = await fresh();
    await up();
    await query("insert into server_settings (key, value, updated_at) values ($1, $2, $3)", [
      "db.owner",
      JSON.stringify({ role: "production", database: "inkledger" }),
      Date.now(),
    ]);
    await query("delete from drizzle.__drizzle_migrations where created_at = $1", [journal.at(-1)!.when]);
    await expect(guardMigrations(query, journal, dev)).resolves.toBeUndefined();
  });

  it("lets a dev process use an up-to-date production database (nothing to apply)", async () => {
    const { query, up } = await fresh();
    await up();
    await markProductionDb(query);
    await expect(guardMigrations(query, journal, dev)).resolves.toBeUndefined();
  });

  it("refuses to start on a database newer than the build", async () => {
    const { query, up } = await fresh();
    await up();
    // The build's newest migration is older than the one applied: the database is ahead of it.
    const older = journal.map((e) => ({ ...e, when: e.when - 1 }));
    await expect(guardMigrations(query, older, { ...dev, production: true })).rejects.toThrow(/newer than this build/);
  });
});

describe("data migrations", () => {
  it("run once, in order, and are recorded", async () => {
    process.env.DATABASE_URL = ":memory:";
    const conn = await import("./connection");
    const db = await conn.resetDbForTests();
    const order: string[] = [];
    const steps = [
      { id: "a", run: async () => void order.push("a") },
      { id: "b", run: async () => void order.push("b") },
    ];
    expect(await runDataMigrations(db, steps)).toEqual(["a", "b"]);
    expect(await runDataMigrations(db, steps)).toEqual([]);
    expect(order).toEqual(["a", "b"]);
    // A new step later runs alone.
    expect(await runDataMigrations(db, [...steps, { id: "c", run: async () => void order.push("c") }])).toEqual(["c"]);
  });

  it("a failing step stops the run and runs again next time", async () => {
    process.env.DATABASE_URL = ":memory:";
    const conn = await import("./connection");
    const db = await conn.resetDbForTests();
    let fail = true;
    const steps = [
      { id: "ok", run: async () => {} },
      {
        id: "flaky",
        run: async () => {
          if (fail) throw new Error("provider unreachable");
        },
      },
      { id: "after", run: async () => {} },
    ];
    await expect(runDataMigrations(db, steps)).rejects.toThrow(/"flaky" failed: provider unreachable/);
    fail = false;
    expect(await runDataMigrations(db, steps)).toEqual(["flaky", "after"]);
  });
});
