import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";

const key = (s: string) => createHash("sha256").update(s).digest();
function enc(plain: string, secret: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv, { authTagLength: 16 });
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
function dec(payload: string, secret: string) {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(secret), iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

describe("SQLite → Postgres transfer (scripts/sqlite-to-postgres.mjs)", () => {
  it("copies every row, turns each Jira login into its connection (token re-encrypted), continues ids, and refuses a non-empty target", async () => {
    // An old SQLite database (missing the newest columns and tables).
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, site_url TEXT, deployment TEXT, auth_type TEXT, account_id TEXT, email TEXT, display_name TEXT, avatar_url TEXT, encrypted_token TEXT, created_at INTEGER);
      CREATE TABLE worklogs (id INTEGER PRIMARY KEY, user_id INTEGER, issue_key TEXT, jira_worklog_id TEXT, time_spent_seconds INTEGER, started INTEGER, comment TEXT, author_account_id TEXT, jira_created TEXT, jira_updated TEXT, synced_at INTEGER);
      CREATE TABLE settings (user_id INTEGER PRIMARY KEY, daily_target_seconds INTEGER, weekly_target_seconds INTEGER, timer_alert_minutes INTEGER, notify_enabled INTEGER);
    `);
    sqlite
      .prepare("INSERT INTO users VALUES (7, 'https://j.it', 'server', 'basic', 'mrossi', 'm', 'Mario', NULL, ?, 1)")
      .run(enc("token-123", "old-secret"));
    sqlite.prepare("INSERT INTO worklogs VALUES (41, 7, 'A-1', '9001', 3600, 1760000000000, '', 'mrossi', NULL, NULL, 0)").run();
    sqlite.prepare("INSERT INTO settings VALUES (7, 28800, 144000, 90, 1)").run();

    const { PGlite } = await import("@electric-sql/pglite");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const pgl = new PGlite({ extensions: { pg_trgm }, parsers: { 20: (v: string) => Number(v) } });
    await migrate(drizzle(pgl), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    const client = { query: (t: string, p?: unknown[]) => pgl.query<Record<string, unknown>>(t, p) };

    const { transfer } = await import("../scripts/sqlite-to-postgres.mjs");
    const counts = await transfer({ sqlite, client, fromSecret: "old-secret", toSecret: "new-secret" });
    expect(counts.users).toEqual([1, 1]);
    expect(counts.connections).toEqual([1, 1]);
    expect(counts.worklogs).toEqual([1, 1]);
    expect(counts.timers).toEqual([0, 0]);

    const [c] = (await pgl.query<{ user_id: number; base_url: string; remote_account_id: string; options: string; encrypted_secret: string }>("SELECT user_id, base_url, remote_account_id, options, encrypted_secret FROM connections")).rows;
    expect(c).toMatchObject({ user_id: 7, base_url: "https://j.it", remote_account_id: "mrossi" });
    expect(JSON.parse(c.options)).toEqual({ deployment: "server", authType: "basic", username: "m" });
    expect(dec(c.encrypted_secret, "new-secret")).toBe("token-123");
    // Columns the old database lacked take their defaults.
    expect((await pgl.query("SELECT idle_minutes, allowed_link_domains FROM settings")).rows).toEqual([
      { idle_minutes: 10, allowed_link_domains: "[]" },
    ]);
    // New rows continue after the copied ids.
    await pgl.query("INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (7, 'A-1', 'x', 60, 0, 0)");
    expect((await pgl.query("SELECT max(id) AS m FROM worklogs")).rows).toEqual([{ m: 42 }]);

    // Never over existing data (unless asked to wipe it).
    await expect(transfer({ sqlite, client, fromSecret: "old-secret", toSecret: "new-secret" })).rejects.toThrow(/is not empty/);
    expect((await pgl.query("SELECT count(*)::int AS n FROM worklogs")).rows).toEqual([{ n: 2 }]);
    await pgl.close();
  });
});
