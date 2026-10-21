#!/usr/bin/env node
// Moves an older inkledger database into a new one whose schema is already
// in place (start the new server once on the empty database, then stop it).
// Table by table, column by column: what both schemas have is copied as is,
// ids kept, parents before children; nothing is named here but what the
// schemas say. One rule beyond that: a schema from before connections kept
// each account's Jira login on its user row, which becomes the account's Jira
// connection, and every row of that account belongs to it. Its secret is
// copied sealed as it was: the new server opens it with CREDENTIALS_KEY_OLD
// (the old SESSION_SECRET) and seals it again at start.
//
//   node scripts/pg-import.mjs <source-url> <target-url> [--dry-run]
//
// Everything happens in one transaction; the report compares rows per table
// and, per user, the worklogs' count, seconds and first/last start. Any
// difference: nothing is kept, the exit code says so.
import pg from "pg";

const BATCH = 500;
/** Bookkeeping that never moves: the target has its own. */
const SKIP = new Set(["__drizzle_migrations"]);

const q = (client, text, params = []) => client.query(text, params).then(r => r.rows);

/** Tables with their columns (name → { nullable, hasDefault, type }). */
async function schemaOf(client) {
  const rows = await q(
    client,
    `SELECT table_name, column_name, is_nullable = 'YES' AS nullable, column_default IS NOT NULL AS has_default, data_type
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const tables = new Map();
  for (const r of rows) {
    if (SKIP.has(r.table_name)) continue;
    const cols = tables.get(r.table_name) ?? new Map();
    cols.set(r.column_name, { nullable: r.nullable, hasDefault: r.has_default, type: r.data_type });
    tables.set(r.table_name, cols);
  }
  return tables;
}

/** The target's tables, parents first (foreign keys). */
async function orderOf(client, tables) {
  const fks = await q(
    client,
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  const deps = new Map([...tables.keys()].map(t => [t, new Set()]));
  for (const { child, parent } of fks) if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  const out = [];
  const seen = new Set();
  const visit = t => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of deps.get(t)) visit(p);
    out.push(t);
  };
  for (const t of [...tables.keys()].sort()) visit(t);
  return out;
}

const ident = name => `"${name.replace(/"/g, '""')}"`;

/** A schema from before connections: its users carry the Jira login. */
const legacyLogins = (src, dst) => !src.has("connections") && dst.has("connections") && src.get("users")?.has("site_url");

/** Each legacy account's Jira login as its connection; user id → connection id. */
async function connectionsFromUsers(source, target) {
  const users = await q(source, `SELECT * FROM users WHERE site_url IS NOT NULL AND site_url <> '' AND encrypted_token IS NOT NULL ORDER BY id`);
  const map = new Map();
  for (const u of users) {
    const options = { deployment: u.deployment ?? "cloud", authType: u.auth_type ?? "basic", username: u.email ?? u.username };
    const [made] = await q(
      target,
      `INSERT INTO connections (user_id, type, base_url, remote_account_id, display_name, options, encrypted_secret, created_at)
       VALUES ($1, 'jira', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [u.id, u.site_url, u.account_id ?? "", u.display_name ?? "", JSON.stringify(options), u.encrypted_token, u.created_at ?? Date.now()],
    );
    map.set(Number(u.id), made.id);
  }
  return map;
}

async function copyTable(source, target, table, srcCols, dstCols, connectionOfUser) {
  const shared = [...dstCols.keys()].filter(c => srcCols.has(c));
  // A required column the source doesn't have: a row's connection is its user's (legacy logins); anything else can't be guessed.
  const missing = [...dstCols.entries()].filter(([c, d]) => !srcCols.has(c) && !d.nullable && !d.hasDefault).map(([c]) => c);
  const byUser = missing.includes("connection_id") && dstCols.has("user_id") && srcCols.has("user_id");
  const unknown = missing.filter(c => !(c === "connection_id" && byUser));
  if (unknown.length) throw new Error(`${table}: required ${unknown.join(", ")} not in the source`);
  const cols = byUser ? [...shared, "connection_id"] : shared;
  const rows = await q(source, `SELECT ${shared.map(ident).join(", ")} FROM ${ident(table)} ORDER BY 1`);
  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).flatMap(r => {
      if (!byUser) return [shared.map(c => r[c])];
      const conn = connectionOfUser.get(Number(r.user_id));
      // A row of an account with no Jira login has no connection to belong to: left out, and said.
      return conn === undefined ? [] : [[...shared.map(c => r[c]), conn]];
    });
    if (batch.length === 0) continue;
    const values = batch.map((row, n) => `(${row.map((_, k) => `$${n * cols.length + k + 1}`).join(", ")})`).join(", ");
    await target.query(`INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES ${values}`, batch.flat());
    copied += batch.length;
  }
  return { source: rows.length, copied };
}

/** Sequences follow the ids copied. */
async function resyncSequences(target) {
  const seqs = await q(
    target,
    `SELECT t.relname AS table_name, a.attname AS column_name, pg_get_serial_sequence(quote_ident(t.relname), a.attname) AS seq
       FROM pg_class t JOIN pg_attribute a ON a.attrelid = t.oid
      WHERE t.relnamespace = 'public'::regnamespace AND t.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND pg_get_serial_sequence(quote_ident(t.relname), a.attname) IS NOT NULL`,
  );
  for (const s of seqs) {
    await target.query(`SELECT setval($1, GREATEST((SELECT coalesce(max(${ident(s.column_name)}), 0) FROM ${ident(s.table_name)}), 1))`, [s.seq]);
  }
}

/** Per user: worklogs, their seconds, first and last start. */
const timeOf = client =>
  q(client, `SELECT user_id, count(*)::int AS n, coalesce(sum(time_spent_seconds), 0)::bigint AS seconds, min(started) AS first, max(started) AS last FROM worklogs GROUP BY user_id ORDER BY user_id`).then(rows =>
    rows.map(r => ({ user: Number(r.user_id), n: r.n, seconds: Number(r.seconds), first: Number(r.first), last: Number(r.last) })),
  );

/**
 * Copies `source` into `target` (empty, its schema in place) in one
 * transaction. The report lists rows per table and the time per user on
 * both sides; with `dryRun` (or any difference in the time) nothing stays.
 */
export async function importDatabase(sourceUrl, targetUrl, { dryRun = false, log = console.log } = {}) {
  const source = new pg.Client({ connectionString: sourceUrl });
  const target = new pg.Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();
  try {
    const [src, dst] = [await schemaOf(source), await schemaOf(target)];
    const order = await orderOf(target, dst);
    for (const t of order) {
      if (!src.has(t)) continue;
      const [{ n }] = await q(target, `SELECT count(*)::int AS n FROM ${ident(t)}`);
      // The new server's first start makes its admin and settings: those go, the source's come.
      if (n > 0 && t !== "users" && t !== "settings" && t !== "server_settings") throw new Error(`${t} is not empty in the target`);
    }
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query("BEGIN");
    // The new server's own accounts (its admin) stay, after the source's: kept aside, back with new ids.
    const own = dst.has("users") ? await q(target, "SELECT * FROM users ORDER BY id") : [];
    for (const t of ["server_settings", "settings", "sessions", "users"]) if (dst.has(t) && src.has(t)) await target.query(`DELETE FROM ${ident(t)}`);
    const tables = [];
    let connectionOfUser = new Map();
    for (const t of order) {
      if (t === "connections" && legacyLogins(src, dst)) {
        connectionOfUser = await connectionsFromUsers(source, target);
        tables.push({ table: t, source: 0, copied: connectionOfUser.size, note: "from the users' Jira logins" });
        continue;
      }
      if (!src.has(t)) continue;
      const r = await copyTable(source, target, t, src.get(t), dst.get(t), connectionOfUser);
      tables.push({ table: t, ...r });
      // Users come before connections: the legacy logins are read once users are in.
      if (t === "users" && legacyLogins(src, dst) && !order.includes("connections")) throw new Error("connections table missing in the target");
    }
    if (own.length) {
      const [{ top }] = await q(target, "SELECT coalesce(max(id), 0)::int AS top FROM users");
      const cols = [...dst.get("users").keys()].filter(c => c !== "id");
      for (const [n, u] of own.entries()) {
        await target.query(
          `INSERT INTO users (id, ${cols.map(ident).join(", ")}) VALUES (${[top + n + 1, ...cols].map((_, k) => `$${k + 1}`).join(", ")})`,
          [top + n + 1, ...cols.map(c => u[c])],
        );
      }
      tables.push({ table: "users (the new server's own)", source: 0, copied: own.length, note: "kept, new ids" });
    }
    await resyncSequences(target);
    const [before, after] = [await timeOf(source), await timeOf(target)];
    const same = JSON.stringify(before) === JSON.stringify(after);
    for (const r of tables) log(`${r.table.padEnd(24)} ${String(r.source).padStart(7)} → ${String(r.copied).padStart(7)}${r.note ? `  (${r.note})` : r.copied !== r.source ? "  ≠" : ""}`);
    log("");
    log("time per user (worklogs, seconds, first, last):");
    for (const b of before) {
      const a = after.find(x => x.user === b.user);
      const ok = a && a.n === b.n && a.seconds === b.seconds && a.first === b.first && a.last === b.last;
      log(`  user ${b.user}: ${b.n} / ${b.seconds} s / ${new Date(b.first).toISOString()} … ${new Date(b.last).toISOString()}  ${ok ? "= same" : `≠ ${JSON.stringify(a ?? null)}`}`);
    }
    if (!same || dryRun) {
      await target.query("ROLLBACK");
      log(same ? "\ndry run: nothing kept" : "\nTIME DIFFERS: nothing kept");
    } else {
      await target.query("COMMIT");
      log("\ncopied: the time is the same");
    }
    await source.query("COMMIT");
    return { tables, before, after, same, kept: same && !dryRun };
  } catch (e) {
    await target.query("ROLLBACK").catch(() => undefined);
    await source.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await source.end();
    await target.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourceUrl, targetUrl] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  if (!sourceUrl || !targetUrl) {
    console.error("usage: node scripts/pg-import.mjs <source-url> <target-url> [--dry-run]");
    process.exit(2);
  }
  importDatabase(sourceUrl, targetUrl, { dryRun: process.argv.includes("--dry-run") })
    .then(r => process.exit(r.same ? 0 : 1))
    .catch(e => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    });
}
