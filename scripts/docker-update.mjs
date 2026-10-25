#!/usr/bin/env node
// Updates the inkledger Docker stack (deploy/staging.yml) to the current checkout:
// backs up its database, builds a new image, swaps the app container and waits
// for it to be healthy, rolling back to the previous image if it is not.
// The old jtt stack is never touched.
//
//   pnpm docker:update              backup + build + swap
//   pnpm docker:update --dry-run    print the steps, change nothing
//   pnpm docker:update --no-backup  skip the pg_dump
//   pnpm docker:update --rehearse-rollback  update, then roll back as after a failed health check
//
// Rollback: when the new image migrated the database, the previous image can't run on it
// (it refuses a newer schema): the database goes back to this run's dump first. Without a
// dump the script stops there and says how to recover, never claiming a rollback.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PROJECT = "inkledger";
const COMPOSE = join(ROOT, "deploy/staging.yml");
const APP = "inkledger";
const DB = "inkledger-db";
const IMAGE = "inkledger";
const HEALTH = "http://127.0.0.1:47824/api/health";
const BACKUPS = process.env.INKLEDGER_BACKUP_DIR ?? join(homedir(), "Backups/inkledger");
const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");

// The old stack's names: this script must never reach them.
for (const name of [PROJECT, APP, DB, IMAGE]) {
  if (/^jtt/.test(name)) throw new Error(`docker-update: refusing to touch ${name}`);
}
if (!existsSync(join(ROOT, ".env.inkledger"))) throw new Error("docker-update: .env.inkledger is missing (see .env.example)");

const out = (cmd, argv) => spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8" }).stdout?.trim() ?? "";
function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}`);
  if (dry) return;
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`docker-update: ${cmd} ${argv[0]} failed (${r.status ?? r.signal})`);
}
const compose = (...argv) => ["compose", "-p", PROJECT, "-f", COMPOSE, ...argv];
// Local time, as the backups already there are named.
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function waitHealthy(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(HEALTH)).ok) return Date.now() - t0;
    } catch {
      // not answering yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const startedAt = Date.now();
/** Migrations the database has applied (the new image applies its own at boot). */
const migrations = () => out("docker", ["exec", DB, "psql", "-U", "inkledger", "-d", "inkledger", "-Atc", "select count(*) from drizzle.__drizzle_migrations"]);
/** This run's dump, if it made one. */
const thisRunsDump = () =>
  existsSync(BACKUPS)
    ? readdirSync(BACKUPS)
        .filter((f) => /^inkledger-\d{8}-\d{6}\.dump$/.test(f))
        .map((f) => join(BACKUPS, f))
        .filter((f) => statSync(f).mtimeMs >= startedAt - 1000 && statSync(f).size > 0)
        .sort()
        .at(-1)
    : undefined;
const psql = (sql) => ["exec", DB, "psql", "-v", "ON_ERROR_STOP=1", "-U", "inkledger", "-d", "postgres", "-c", sql];

const sha = out("git", ["rev-parse", "--short", "HEAD"]);
if (out("git", ["status", "--porcelain"])) console.log("! The working tree has uncommitted changes: they go into the image too.");
const previous = out("docker", ["image", "inspect", "-f", "{{.Id}}", `${IMAGE}:latest`]);

// 1. Backup (the database the new image migrates at boot).
if (!args.has("--no-backup")) {
  const file = join(BACKUPS, `inkledger-${stamp()}.dump`);
  console.log(`$ docker exec ${DB} pg_dump -U inkledger -Fc inkledger > ${file}`);
  if (!dry) {
    mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
    // This user's only: a dump holds password hashes and sealed credentials.
    const fd = openSync(file, "w", 0o600);
    const r = spawnSync("docker", ["exec", DB, "pg_dump", "-U", "inkledger", "-Fc", "inkledger"], { stdio: ["ignore", fd, "inherit"] });
    closeSync(fd);
    if (r.status !== 0 || statSync(file).size === 0) throw new Error("docker-update: backup failed, nothing changed");
    console.log(`✓ Backup ${file} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

// 2. Keep the running image for a rollback.
if (previous) run("docker", ["tag", `${IMAGE}:latest`, `${IMAGE}:prev`]);

// 3. Build.
const b0 = Date.now();
run("docker", ["build", "-t", `${IMAGE}:${sha}`, "-t", `${IMAGE}:latest`, "."]);
const buildMs = Date.now() - b0;

// 4. Swap the app container (the database keeps running).
const migratedBefore = dry ? "" : migrations();
const u0 = Date.now();
run("docker", compose("up", "-d", "--no-deps", "--no-build", APP));
if (dry) process.exit(0);

// 5. Healthy, or back to the previous image (and, when it migrated, the previous database).
const rehearse = args.has("--rehearse-rollback");
const healthyMs = await waitHealthy(120_000);
if (healthyMs === null || rehearse) {
  if (healthyMs === null) {
    console.error("✗ Not healthy in 120 s. Last log lines:");
    spawnSync("docker", ["logs", "--tail", "40", APP], { stdio: "inherit" });
  } else console.error("↩ Rehearsing the rollback (the new image was healthy)");
  if (!previous) {
    console.error("✗ No previous image to go back to: the stack is left as it is.");
    process.exit(1);
  }
  const migrated = migrations() !== migratedBefore;
  if (migrated) {
    const dump = thisRunsDump();
    run("docker", compose("stop", APP));
    if (!dump) {
      console.error(
        [
          "✗ The new image migrated the database and this run made no dump: the previous image can't run on it.",
          "  The app is stopped. To recover: restore a dump made before the update, then start the previous image:",
          `    docker exec ${DB} psql -U inkledger -d postgres -c "DROP DATABASE inkledger WITH (FORCE)" -c "CREATE DATABASE inkledger OWNER inkledger"`,
          `    docker exec -i ${DB} pg_restore -U inkledger -d inkledger --no-owner < <dump>`,
          `    docker tag ${IMAGE}:prev ${IMAGE}:latest && docker compose -p ${PROJECT} -f ${COMPOSE} up -d --no-deps ${APP}`,
        ].join("\n"),
      );
      process.exit(1);
    }
    // Anything the new version wrote after the dump goes with it (it was unhealthy: little or nothing).
    console.error(`↩ The new image migrated the database: back to ${dump}`);
    run("docker", psql("DROP DATABASE IF EXISTS inkledger WITH (FORCE)"));
    run("docker", psql("CREATE DATABASE inkledger OWNER inkledger"));
    const fd = openSync(dump, "r");
    try {
      run("docker", ["exec", "-i", DB, "pg_restore", "-U", "inkledger", "-d", "inkledger", "--no-owner", "--exit-on-error"], { stdio: [fd, "inherit", "inherit"] });
    } finally {
      closeSync(fd);
    }
  }
  console.error(`↩ Back to ${IMAGE}:prev`);
  run("docker", ["tag", `${IMAGE}:prev`, `${IMAGE}:latest`]);
  run("docker", compose("up", "-d", "--no-deps", "--no-build", APP));
  const back = await waitHealthy(120_000);
  if (back === null) {
    console.error("✗ The previous image is not healthy either: see `docker logs inkledger`. Not rolled back.");
    process.exit(1);
  }
  console.error(`✓ Rolled back: ${IMAGE}:prev${migrated ? " on the database as it was before the update" : ""}`);
  process.exit(1);
}

const size = Number(out("docker", ["image", "inspect", "-f", "{{.Size}}", `${IMAGE}:latest`]));
console.log(`✓ ${IMAGE}:${sha} up on ${HEALTH.replace("/api/health", "")}`);
console.log(`  build ${seconds(buildMs)} · container up to healthy ${seconds(Date.now() - u0)} (health polling ${seconds(healthyMs)}) · image ${(size / 1024 / 1024).toFixed(0)} MB`);
