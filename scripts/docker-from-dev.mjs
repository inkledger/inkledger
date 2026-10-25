#!/usr/bin/env node
// Makes the inkledger Docker stack (deploy/staging.yml) start from the dev
// server's state: its database (DATABASE_URL in .env) and its installed mods
// (data/modules). The stack's own database is backed up first and replaced.
// The instance key is not copied: a copied database is not a copied server
// (api/modules/instance.ts), so mod licences are activated for this one.
//
//   pnpm docker:from-dev --yes      backup + replace
//   pnpm docker:from-dev --dry-run  print the steps, change nothing
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const COMPOSE = ["compose", "-p", "inkledger", "-f", join(ROOT, "deploy/staging.yml")];
const APP = "inkledger";
const DB = "inkledger-db";
const HEALTH = "http://127.0.0.1:47824/api/health";
const BACKUPS = process.env.INKLEDGER_BACKUP_DIR ?? join(homedir(), "Backups/inkledger");
// The dev database lives in the old stack's Postgres: only read from, with pg_dump.
const DEV_PG = process.env.DEV_PG_CONTAINER ?? "jtt-db";
const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
if (!dry && !args.has("--yes")) {
  console.error("docker-from-dev: replaces the stack's database (after a backup). Run with --yes, or --dry-run.");
  process.exit(2);
}

const devUrl = new URL(/^DATABASE_URL=(.+)$/m.exec(readFileSync(join(ROOT, ".env"), "utf8"))?.[1].trim() ?? "");
const devDb = devUrl.pathname.slice(1);
const devUser = decodeURIComponent(devUrl.username);
if (!devDb || devDb === "jtt") throw new Error(`docker-from-dev: refusing to read database "${devDb}" (not a dev database)`);

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}${opts.in ? ` < ${opts.in}` : ""}${opts.out ? ` > ${opts.out}` : ""}`);
  if (dry) return;
  const fdIn = opts.in ? openSync(opts.in, "r") : "ignore";
  // Dumps are this user's only: they hold password hashes and sealed credentials.
  const fdOut = opts.out ? openSync(opts.out, "w", 0o600) : "inherit";
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: [fdIn, fdOut, "inherit"] });
  if (typeof fdIn === "number") closeSync(fdIn);
  if (typeof fdOut === "number") closeSync(fdOut);
  if (r.status !== 0) throw new Error(`docker-from-dev: ${cmd} ${argv.slice(0, 2).join(" ")} failed (${r.status ?? r.signal})`);
  if (opts.out && statSync(opts.out).size === 0) throw new Error(`docker-from-dev: ${opts.out} is empty`);
}
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const psql = (sql) => ["exec", DB, "psql", "-v", "ON_ERROR_STOP=1", "-U", "inkledger", "-d", "postgres", "-c", sql];

const t = stamp();
if (!dry) mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
const before = join(BACKUPS, `inkledger-${t}.dump`);
const fromDev = join(BACKUPS, `dev-${devDb}-${t}.dump`);

// 1. Both dumps first: nothing changes until each exists.
run("docker", ["exec", DB, "pg_dump", "-U", "inkledger", "-Fc", "inkledger"], { out: before });
run("docker", ["exec", DEV_PG, "pg_dump", "-U", devUser, "-Fc", "--no-owner", "--no-acl", devDb], { out: fromDev });

// 2. The app stops, so nothing writes while the database is replaced.
run("docker", [...COMPOSE, "stop", APP]);
run("docker", psql("DROP DATABASE IF EXISTS inkledger WITH (FORCE)"));
run("docker", psql("CREATE DATABASE inkledger OWNER inkledger"));
run("docker", ["exec", "-i", DB, "pg_restore", "-U", "inkledger", "-d", "inkledger", "--no-owner", "--no-acl", "--exit-on-error"], { in: fromDev });

// 3. The mods dev has installed (files on disk, the database names them).
const modules = join(ROOT, "data/modules");
if (existsSync(modules)) run("docker", ["cp", modules, `${APP}:/app/data/`]);

// 4. Up again: migrations and the credential re-seal run at boot.
run("docker", [...COMPOSE, "up", "-d", "--no-deps", "--no-build", APP]);
if (existsSync(modules)) run("docker", ["exec", "-u", "root", APP, "chown", "-R", "node:node", "/app/data/modules"]);
if (dry) process.exit(0);

const t0 = Date.now();
let healthy = false;
while (Date.now() - t0 < 120_000 && !healthy) {
  healthy = await fetch(HEALTH).then((r) => r.ok, () => false);
  if (!healthy) await new Promise((r) => setTimeout(r, 250));
}
// What the server said about the copied state. Unreadable credentials show only once a
// tracker is used (the first sync or page), so the log is read a little after boot.
if (healthy) await new Promise((r) => setTimeout(r, 15_000));
const log = spawnSync("docker", ["logs", "--since", `${Math.ceil((Date.now() - t0) / 1000) + 5}s`, APP], { encoding: "utf8" });
const notes = [...new Set(`${log.stdout}${log.stderr}`.split("\n").filter((l) => /\[credentials\]|UnreadableCredentials|migrat|licen/i.test(l)).map((l) => l.trim()))];
for (const l of notes) console.log(`  ${l}`);
if (notes.some((l) => /UnreadableCredentials/.test(l))) {
  console.log("! Some tracker credentials don't open with this stack's keys: CREDENTIALS_KEY_OLD in .env.inkledger must open dev's (sha256 hex of dev's SESSION_SECRET when dev has no CREDENTIALS_KEY).");
}
if (!healthy) {
  console.error(`✗ Not healthy in 120 s. The stack's previous database: pg_restore --clean from ${before}`);
  process.exit(1);
}
console.log(`✓ inkledger now runs on dev's state (${devDb}) · previous database saved in ${before}`);
