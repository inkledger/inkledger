// scripts/pg-import.mjs on a database with the schema the production server
// runs (e2e/fixtures/pre-platform-schema.sql): every row and every second of time
// arrives; each account's Jira login becomes its connection; the new
// server's admin stays. Real Postgres, like the browser tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { APP } from "./harness.mjs";
import { importDatabase } from "../scripts/pg-import.mjs";


function adminUrl() {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const env = existsSync(join(APP, ".env")) ? readFileSync(join(APP, ".env"), "utf8") : "";
  return /^DATABASE_URL=(.+)$/m.exec(env)[1].trim();
}

async function database(admin, name) {
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/** The legacy schema, as its own migrations made it (kept as a fixture: the history it came from is archived). */
async function legacySchema(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  for (const stmt of readFileSync(join(APP, "e2e/fixtures/pre-platform-schema.sql"), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await c.query(stmt);
  return c;
}

test("an older database moves in whole: rows, time to the second, Jira logins as connections, the admin kept", async () => {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const tag = `${process.pid}_${randomBytes(3).toString("hex")}`;
  const names = [`ikl_e2e_old_${tag}`, `ikl_e2e_new_${tag}`];
  try {
    const oldUrl = await database(admin, names[0]);
    const newUrl = await database(admin, names[1]);
    const old = await legacySchema(oldUrl);
    const now = Date.UTC(2026, 9, 14, 8);
    await old.query(
      `INSERT INTO users (id, site_url, deployment, auth_type, account_id, email, display_name, encrypted_token, created_at) VALUES
       (1, 'https://jira.example.it', 'server', 'basic', 'mrossi', 'mrossi', 'Mario Rossi', 'iv.tag.data', $1),
       (2, 'https://acme.atlassian.net', 'cloud', 'basic', 'acc-2', 'anna@acme.it', 'Anna', 'iv2.tag2.data2', $1)`,
      [now],
    );
    await old.query(`INSERT INTO issues (user_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (1, '10', 'APP-1', 'First', 'To Do', 'APP', 'App', 'u', $1), (2, '20', 'ACM-1', 'Acme', 'To Do', 'ACM', 'Acme', 'u', $1)`, [now]);
    const logs = [];
    for (let i = 0; i < 30; i++) logs.push(`(${1 + (i % 2)}, '${i % 2 ? "ACM-1" : "APP-1"}', 'wl-${i}', ${600 + i * 60}, ${now + i * 3_600_000}, '', $1)`);
    await old.query(`INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES ${logs.join(", ")}`, [now]);
    await old.query(`INSERT INTO outbox (user_id, kind, issue_key, jira_worklog_id, time_spent_seconds, started, comment, created_at) VALUES (1, 'update', 'APP-1', 'wl-0', 900, $1, '', $1)`, [now]);
    await old.query(`INSERT INTO notifications (user_id, kind, issue_key, detail, dedupe, created_at) VALUES (1, 'assigned', 'APP-1', '', 'a1', $1)`, [now]);
    await old.query(`INSERT INTO settings (user_id, daily_target_seconds) VALUES (1, 25200)`);
    await old.end();

    // The new server's schema, and its admin from the first start.
    const fresh = new pg.Client({ connectionString: newUrl });
    await fresh.connect();
    await migrate(drizzle(fresh), { migrationsFolder: join(APP, "drizzle") });
    await fresh.query(`INSERT INTO users (username, password_hash, role, display_name, created_at) VALUES ('admin', 'hash', 'admin', 'Admin', $1)`, [now]);
    await fresh.end();

    const lines = [];
    const dry = await importDatabase(oldUrl, newUrl, { dryRun: true, log: l => lines.push(l) });
    assert.equal(dry.same, true, lines.join("\n"));
    assert.equal(dry.kept, false);
    const done = await importDatabase(oldUrl, newUrl, { log: () => undefined });
    assert.equal(done.kept, true);

    const check = new pg.Client({ connectionString: newUrl });
    await check.connect();
    const one = async (sql, p = []) => (await check.query(sql, p)).rows;
    assert.deepEqual(await one("SELECT user_id, type, base_url, remote_account_id, encrypted_secret, options FROM connections ORDER BY user_id"), [
      { user_id: 1, type: "jira", base_url: "https://jira.example.it", remote_account_id: "mrossi", encrypted_secret: "iv.tag.data", options: JSON.stringify({ deployment: "server", authType: "basic", username: "mrossi" }) },
      { user_id: 2, type: "jira", base_url: "https://acme.atlassian.net", remote_account_id: "acc-2", encrypted_secret: "iv2.tag2.data2", options: JSON.stringify({ deployment: "cloud", authType: "basic", username: "anna@acme.it" }) },
    ]);
    // Every row on its account's connection; the time the same to the second.
    assert.deepEqual(await one("SELECT count(*)::int AS n FROM worklogs w JOIN connections c ON c.id = w.connection_id AND c.user_id = w.user_id"), [{ n: 30 }]);
    assert.deepEqual(await one("SELECT user_id, sum(time_spent_seconds)::int AS s FROM worklogs GROUP BY user_id ORDER BY user_id"), [
      { user_id: 1, s: logs.filter((_, i) => i % 2 === 0).reduce((a, _, k) => a + 600 + k * 2 * 60, 0) },
      { user_id: 2, s: logs.filter((_, i) => i % 2 === 1).reduce((a, _, k) => a + 600 + (k * 2 + 1) * 60, 0) },
    ]);
    // Synced worklogs are linked to their tracker; the queued edit points at its worklog.
    assert.deepEqual(await one("SELECT count(*)::int AS n FROM worklog_sinks WHERE state = 'synced'"), [{ n: 30 }]);
    assert.deepEqual(await one("SELECT count(*)::int AS n FROM outbox WHERE worklog_id IS NOT NULL AND connection_id IS NOT NULL"), [{ n: 1 }]);
    // The admin stays, after the accounts moved in; new rows get new ids.
    assert.deepEqual(await one("SELECT id, username, role FROM users ORDER BY id"), [
      { id: 1, username: null, role: "member" },
      { id: 2, username: null, role: "member" },
      { id: 3, username: "admin", role: "admin" },
    ]);
    const [{ id }] = await one("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) SELECT 1, id, 'APP-1', 'wl-new', 60, 1, 1 FROM connections WHERE user_id = 1 RETURNING id");
    assert.ok(id > 30);
    await check.end();

    // A second run finds the target full: refused, nothing touched.
    await assert.rejects(importDatabase(oldUrl, newUrl, { log: () => undefined }), /not empty/);
  } finally {
    for (const n of names) await admin.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
});
