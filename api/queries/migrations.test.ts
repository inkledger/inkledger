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

  it("components kept: the next background sync is full, and only that changes", async () => {
    process.env.DATABASE_URL = ":memory:";
    const conn = await import("./connection");
    const db = await conn.resetDbForTests();
    const [u] = await conn.q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('c', 'C', 1) RETURNING id");
    await conn.q("INSERT INTO sync_state (user_id, last_sync_at, last_full_sync_at) VALUES (?, 5, 7)", u.id);
    const { DATA_MIGRATIONS } = await import("./dataMigrations");
    const { needsFullSync } = await import("../syncScheduler");
    for (const id of ["issue-components-full-sync", "issue-components-resync"]) {
      await conn.q("UPDATE sync_state SET last_full_sync_at = 7 WHERE user_id = ?", u.id);
      await DATA_MIGRATIONS.find((s) => s.id === id)!.run(db);
      expect(await needsFullSync(u.id)).toBe(true);
      const [row] = await conn.q<{ last_sync_at: number | null }>("SELECT last_sync_at FROM sync_state WHERE user_id = ?", u.id);
      expect(Number(row.last_sync_at)).toBe(5);
    }
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

describe("migrations over a draft of 0010", () => {
  it("a database that took the draft 0010 (claimed_at only) still migrates to the end", async () => {
    const { query, up } = await fresh();
    await up();
    // As a dev database left by the draft: the column there, the lease table and the final 0010 not.
    const w10 = journal.find(e => e.tag === "0010_write_claims")!.when;
    await query('DROP TABLE "write_leases"');
    await query('ALTER TABLE "module_storage" DROP COLUMN "revision"');
    await query('DROP TABLE "markdown_note_versions"');
    await query('DROP TABLE "markdown_notes"');
    await query("delete from drizzle.__drizzle_migrations where created_at >= $1", [w10]);
    await query("insert into drizzle.__drizzle_migrations (hash, created_at) values ('draft', $1)", [w10 - 1]);
    await expect(up()).resolves.toBeUndefined();
    const t = await query("select to_regclass('write_leases') as t");
    expect((t.rows[0] as { t: string | null }).t).toBe("write_leases");
  });
});
