import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@db/schema";

/**
 * db/schema.ts and the migrations (drizzle/) must agree: a schema change
 * without `pnpm db:generate` would leave the database behind the code.
 */
describe("schema drift", () => {
  it("the last migration snapshot is the current schema", async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const dir = path.resolve(process.cwd(), "drizzle/meta");
    const journal = JSON.parse(readFileSync(path.join(dir, "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const last = journal.entries.at(-1)!;
    const snapshot = JSON.parse(
      readFileSync(path.join(dir, `${String(last.idx).padStart(4, "0")}_snapshot.json`), "utf8"),
    ) as Parameters<typeof generateMigration>[0];
    const current = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(snapshot, current)).toEqual([]);
  });

  it("the migrations build the database the app uses", async () => {
    process.env.DATABASE_URL = ":memory:";
    const conn = await import("./connection");
    await conn.resetDbForTests();
    const tables = await conn.q<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    // Every table the schema declares, and no other: derived from db/schema.ts,
    // so a new table is checked without editing this list.
    const declared = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((v) => getTableName(v as PgTable))
      .sort();
    expect(tables.map((t) => t.table_name)).toEqual(declared);
    expect(declared).toContain("worklogs");
  });
});
