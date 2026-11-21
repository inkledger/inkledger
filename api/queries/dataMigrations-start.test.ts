import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// A database kept on disk: the steps must run on a start, where the app has no
// database handle yet (not after initDb, as the other tests run them).
const dir = mkdtempSync(path.join(tmpdir(), "ikl-start-"));
process.env.DATABASE_URL = `pglite:${dir}`;

describe("data migrations at start", () => {
  afterAll(async () => {
    await (await import("./connection")).closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("an upgrade with a legacy Dashboard layout starts, and keeps the hidden sections", async () => {
    const conn = await import("./connection");
    await conn.initDb();
    const [ann] = await conn.q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('ann', 'Ann', 'member', 1) RETURNING id");
    await conn.q("INSERT INTO settings (user_id, dashboard_layout) VALUES (?, ?)", ann.id, JSON.stringify([{ id: "tasks", visible: false }]));
    // As before the upgrade: the step has not run on this database yet.
    const [done] = await conn.q<{ value: string }>("SELECT value FROM server_settings WHERE key = 'data-migrations.done'");
    const ids = (JSON.parse(done.value) as string[]).filter((id) => id !== "dashboard-layout-to-workspace");
    await conn.q("UPDATE server_settings SET value = ? WHERE key = 'data-migrations.done'", JSON.stringify(ids));
    await conn.closeDb();

    await expect(conn.initDb()).resolves.toBeDefined();
    expect(await conn.q("SELECT COUNT(*)::int AS n FROM workspace_revisions WHERE user_id = ?", ann.id)).toEqual([{ n: 2 }]);
  }, 120_000);

  it("a dev process doesn't run a pending data step on a production database: it refuses to start", async () => {
    const conn = await import("./connection");
    await conn.initDb();
    await conn.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('db.owner', json_build_object('role', 'production', 'database', current_database())::text, 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    const [done] = await conn.q<{ value: string }>("SELECT value FROM server_settings WHERE key = 'data-migrations.done'");
    const ids = JSON.parse(done.value) as string[];
    await conn.q("UPDATE server_settings SET value = ? WHERE key = 'data-migrations.done'", JSON.stringify(ids.slice(0, -1)));
    await conn.closeDb();

    await expect(conn.initDb()).rejects.toThrow(/Refusing to run 1 data migration/);
  }, 120_000);
});
