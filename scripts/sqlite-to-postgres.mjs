#!/usr/bin/env node
// One-off move of inkledger's data from a SQLite file (the old storage) into
// Postgres. The target must be empty (or --wipe); everything happens in one
// transaction, row counts are checked table by table, nothing is half done.
//
//   node scripts/sqlite-to-postgres.mjs --from data/app.db \
//     [--to postgres://…] [--from-secret …] [--to-secret …] [--wipe]
//
// Jira tokens are encrypted with SESSION_SECRET: they are re-encrypted from
// the source's secret (dev default if the source had none) to the target's.
// The old storage kept each account's Jira login on its user row: it becomes
// the account's Jira connection (the server seals its secret again at start).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const ROOT = new URL("..", import.meta.url).pathname;
const DEV_SECRET = "ikl-dev-secret-change-me";

/** Parents before children (foreign keys). */
export const TABLES = [
  "users",
  "connections",
  "sessions",
  "issues",
  "worklogs",
  "timers",
  "settings",
  "outbox",
  "week_locks",
  "issue_notes",
  "pinboards",
  "pinboard_notes",
  "work_schedules",
  "sync_state",
  "notifications",
  "server_settings",
  "server_hosts",
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function envValue(file, key) {
  const p = path.join(ROOT, file);
  if (!existsSync(p)) return undefined;
  return new RegExp(`^${key}=(.+)$`, "m").exec(readFileSync(p, "utf8"))?.[1]?.trim();
}

const keyOf = secret => createHash("sha256").update(secret).digest();

export function reencrypt(payload, fromSecret, toSecret) {
  const [iv, tag, data] = payload.split(".").map(p => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", keyOf(fromSecret), iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(data), d.final()]).toString("utf8");
  const iv2 = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(toSecret), iv2, { authTagLength: 16 });
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv2.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

/** Each account's Jira login, from its old user row, as its Jira connection; returns how many. */
async function legacyConnections(sqlite, client, fromSecret, toSecret) {
  const has = new Set(sqlite.prepare(`PRAGMA table_info("users")`).all().map(c => c.name));
  if (!["site_url", "account_id", "encrypted_token"].every(c => has.has(c))) return 0;
  const col = (c, fallback) => (has.has(c) ? `"${c}"` : fallback);
  const rows = sqlite
    .prepare(
      `SELECT id, site_url, account_id, encrypted_token, ${col("deployment", "'cloud'")} AS deployment, ${col("auth_type", "'basic'")} AS auth_type,
              ${col("email", "''")} AS email, ${col("display_name", "''")} AS display_name, ${col("avatar_url", "NULL")} AS avatar_url, ${col("created_at", "0")} AS created_at
         FROM users WHERE site_url IS NOT NULL AND account_id IS NOT NULL AND encrypted_token IS NOT NULL`,
    )
    .all();
  for (const u of rows) {
    await client.query(
      `INSERT INTO connections (user_id, type, base_url, remote_account_id, display_name, avatar_url, options, encrypted_secret, legacy, created_at)
       VALUES ($1, 'jira', $2, $3, $4, $5, $6, $7, 1, $8)`,
      [u.id, u.site_url, u.account_id, u.display_name, u.avatar_url, JSON.stringify({ deployment: u.deployment, authType: u.auth_type, username: u.email }), reencrypt(u.encrypted_token, fromSecret, toSecret), u.created_at],
    );
  }
  return rows.length;
}

/**
 * Copies every table; returns { table: [sourceRows, targetRows] }. Throws
 * (and rolls back) on any mismatch.
 */
export async function transfer({ sqlite, client, fromSecret, toSecret, wipe = false }) {
  const pgCols = async t =>
    (
      await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [t],
      )
    ).rows.map(r => r.column_name);
  const srcTables = new Set(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name),
  );
  const counts = {};
  await client.query("BEGIN");
  try {
    for (const t of TABLES) {
      const n = Number((await client.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
      if (n > 0 && !wipe) throw new Error(`The target is not empty (${t}: ${n} rows): use --wipe to replace it`);
    }
    if (wipe) await client.query(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      if (t === "connections" && !srcTables.has(t)) {
        const n = await legacyConnections(sqlite, client, fromSecret, toSecret);
        counts[t] = [n, n];
        continue;
      }
      if (!srcTables.has(t)) {
        counts[t] = [0, 0];
        continue;
      }
      const target = new Set(await pgCols(t));
      const source = sqlite.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
      // Columns both sides know; a column the source predates takes its default.
      const cols = source.filter(c => target.has(c));
      const rows = sqlite.prepare(`SELECT ${cols.map(c => `"${c}"`).join(", ")} FROM "${t}"`).all();
      for (let i = 0; i < rows.length; i += 200) {
        const block = rows.slice(i, i + 200);
        const params = [];
        const values = block.map(r => {
          const row = { ...r };
          return `(${cols.map(c => (params.push(row[c]), `$${params.length}`)).join(", ")})`;
        });
        await client.query(`INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES ${values.join(", ")}`, params);
      }
      // Serial ids: the next one follows the copied rows.
      const serial = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id' AND column_default LIKE 'nextval%'`,
        [t],
      );
      if (serial.rows.length) {
        const seq = (await client.query(`SELECT pg_get_serial_sequence('"${t}"', 'id') AS s`)).rows[0].s;
        await client.query(`SELECT setval($1, coalesce((SELECT max(id) FROM "${t}"), 0) + 1, false)`, [seq]);
      }
      const after = Number((await client.query(`SELECT count(*) AS n FROM "${t}"`)).rows[0].n);
      counts[t] = [rows.length, after];
      if (after !== rows.length) throw new Error(`${t}: ${rows.length} rows read, ${after} written`);
    }
    await client.query("COMMIT");
    return counts;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main() {
  const from = arg("from", path.join(ROOT, "data/app.db"));
  const to = arg("to", envValue(".env", "DATABASE_URL"));
  const fromSecret = arg("from-secret", DEV_SECRET);
  const toSecret = arg("to-secret", envValue(".env.docker", "SESSION_SECRET") ?? envValue(".env", "SESSION_SECRET"));
  if (!existsSync(from)) throw new Error(`SQLite file not found: ${from}`);
  if (!to || !toSecret) throw new Error("--to (or DATABASE_URL in .env) and --to-secret (or SESSION_SECRET) are required");
  const sqlite = new Database(from, { readonly: true });
  const client = new pg.Client({ connectionString: to });
  await client.connect();
  // The schema first (same migrations the server applies at start).
  await migrate(drizzle(client), { migrationsFolder: path.join(ROOT, "drizzle") });
  const counts = await transfer({ sqlite, client, fromSecret, toSecret, wipe: process.argv.includes("--wipe") });
  for (const [t, [a, b]] of Object.entries(counts)) console.log(`${t.padEnd(16)} ${String(a).padStart(6)} → ${b}`);
  await client.end();
  sqlite.close();
  console.log("✓ Transfer complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
