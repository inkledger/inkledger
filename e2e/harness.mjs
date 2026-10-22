// E2E harness: the production bundle (dist/) on a temporary DB with a seeded
// user, session and issues. Jira is read-only and never synced: these tests
// never reach a real Jira. Run with `pnpm test:e2e` (builds first).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright-core";
import { chromiumPath } from "../scripts/chromium.mjs";
import { freePort } from "../scripts/freePort.mjs";

export const APP = new URL("..", import.meta.url).pathname;

// The tests' own clock reads days as the server and the browser do (both Europe/Rome):
// "today", "yesterday" and midnight are the same day everywhere.
process.env.TZ = "Europe/Rome";

const SECRET = randomBytes(32).toString("hex");
function encrypt(plain) {
  const key = createHash("sha256").update(SECRET).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

/**
 * Starts the app and a browser page logged in as "mrossi". `seed(db)` adds
 * rows before the page opens; `viewport` overrides the 1400×900 default;
 * `env` adds server variables (e.g. ALLOWED_HOSTS); `userAgent` sets the
 * browser's (a phone).
 */
pg.types.setTypeParser(20, v => Number(v));
pg.types.setTypeParser(1700, v => Number(v));

/** The local Postgres (docker compose service "db"): $E2E_DATABASE_URL or the dev .env. */
function adminUrl() {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const env = existsSync(join(APP, ".env")) ? readFileSync(join(APP, ".env"), "utf8") : "";
  const m = /^DATABASE_URL=(.+)$/m.exec(env);
  if (!m) throw new Error("No Postgres for e2e: start `docker compose up -d db` and set DATABASE_URL in .env");
  return m[1].trim();
}

/** Raw SQL with "?" placeholders (as tests are written), rows back. */
function sqlHelper(client) {
  return async (text, ...params) => {
    let n = 0;
    return (await client.query(text.replace(/\?/g, () => `$${++n}`), params)).rows;
  };
}

/** Explicit ids (seeds) leave serial sequences behind: catch them up. */
async function syncSequences(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%'`,
  );
  for (const { table_name: t } of rows) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), coalesce((SELECT max(id) FROM "${t}"), 0) + 1, false)`,
    );
  }
}

/**
 * Starts the app and a browser page logged in as "mrossi". `seed(db)` adds
 * rows before the page opens (db.q(sql, ...params), may be async);
 * `viewport` overrides the 1400×900 default; `env` adds server variables
 * (e.g. ALLOWED_HOSTS); `userAgent` sets the browser's (a phone). Each run
 * has its own Postgres database, dropped at stop().
 */
export async function start({ seed, viewport, env: extraEnv, userAgent, bare = false } = {}) {
  // A port nothing listens on, out of the outgoing-connection range (see freePort.mjs): a
  // random one could be another app's (the Docker stacks'), whose health check would
  // answer for a server still starting.
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "ikl-e2e-"));
  // A database that stops answering fails the test, never holds the whole run.
  const admin = new pg.Client({ connectionString: adminUrl(), connectionTimeoutMillis: 15_000, query_timeout: 60_000 });
  const dbName = `ikl_e2e_${process.pid}_${randomBytes(4).toString("hex")}`;
  let connected = false;
  try {
    await admin.connect();
    connected = true;
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    // No database to work on: nothing left open or behind either (one made after a
    // timeout gave up on it goes too, when the server still answers).
    if (connected) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const dbUrl = new URL(adminUrl());
  dbUrl.pathname = `/${dbName}`;
  const server = spawn(process.execPath, ["dist/boot.js"], {
    cwd: APP,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DATABASE_URL: dbUrl.toString(),
      SESSION_SECRET: SECRET,
      JIRA_READ_ONLY: "1",
      SYNC_INTERVAL_MIN: "0",
      TZ: "Europe/Rome",
      DOWNLOADS_DIR: join(dir, "downloads"),
      MODULES_DIR: join(dir, "modules"),
      // Never the real store Worker; store tests pass their own stub.
      STORE_URL: "off",
      WEATHER: "off",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", d => (log += d));
  server.stderr.on("data", d => (log += d));
  let client = null;
  let browser = null;
  try {
    const base = `http://127.0.0.1:${port}`;
    // Up, or the test fails here (seeding a database still migrating would fail less clearly).
    // Ours: it says it listens on this port (it migrates first), and then answers. A health
    // answer alone could come from another test's server that took the same port first.
    const listening = `Server running on http://localhost:${port}/`;
    for (let i = 0; ; i++) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`the server stopped before it was up:\n${log}`);
      if (log.includes(listening)) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) break;
        } catch {
          // not answering yet
        }
      }
      if (i === 300) throw new Error(`the server did not start in 30 s:\n${log}`);
      await new Promise(r => setTimeout(r, 100));
    }
    // The server has applied the migrations: seed through our own connection.
    client = new pg.Client({ connectionString: dbUrl.toString(), connectionTimeoutMillis: 15_000, query_timeout: 60_000 });
    await client.connect();
    const db = { q: sqlHelper(client) };
    const now = Date.now();
    const cookie = randomBytes(32).toString("base64url");
    // bare: the server as it started (its "admin" with the default password), nobody signed in.
    if (!bare) {
    // Mario, signed in, is the server's admin (in place of the one it starts with).
    await db.q("DELETE FROM users");
    await db.q(
      "INSERT INTO users (id, username, password_hash, role, email, display_name, created_at) VALUES (1,?,?,?,?,?,?)",
      "mrossi", null, "admin", "mrossi", "Mario Rossi", now,
    );
    // His Jira (connection 1): what his issues below live on.
    await db.q(
      "INSERT INTO connections (id, user_id, type, base_url, remote_account_id, display_name, options, encrypted_secret, legacy, created_at) VALUES (1, 1, 'jira', ?, 'mrossi', 'Mario Rossi', ?, ?, 1, ?)",
      "https://jira.example.it", JSON.stringify({ deployment: "server", authType: "basic", username: "mrossi" }), encrypt("x"), now,
    );
    await db.q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?,?,?,?)",
      createHash("sha256").update(cookie).digest("hex"), 1, now + 86400000, now);
    // Jira must look synced, or the app runs a first sync on open.
    await db.q("INSERT INTO sync_state (user_id, last_sync_at, last_full_sync_at) VALUES (1, ?, ?)", now, now);
    const addIssue = (key, summary, favorite = 0) =>
      db.q(
        `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
         VALUES (1, ?, ?, ?, 'To Do', 'To Do', ?, 'Project', 'Task', 'Medium', '[]', 'mrossi', ?, ?, ?)`,
        key, key, summary, key.split("-")[0], `https://jira.example.it/browse/${key}`, now, favorite,
      );
    for (let i = 1; i <= 12; i++) await addIssue(`DEMO-${100 + i}`, `Test task number ${i}`);
    await addIssue("SHOP-7", "Test favorite", 1);
    await db.q("INSERT INTO pinboards (id, user_id, name, position, created_at) VALUES (1, 1, 'My board', 0, ?)", now);
    }
    // Explicit ids above: a test's own rows continue after them.
    await syncSequences(client);
    await seed?.(db);
    await syncSequences(client);

    browser = await chromium.launch({ executablePath: chromiumPath() });
    const context = await browser.newContext({
      viewport: viewport ?? { width: 1400, height: 900 },
      timezoneId: "Europe/Rome",
      locale: "en-US",
      ...(userAgent ? { userAgent, isMobile: true, hasTouch: true } : {}),
    });
    if (!bare) await context.addCookies([{ name: `ikl_session_${port}`, value: cookie, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    return {
      base,
      dir,
      page,
      context,
      db,
      errors,
      log: () => log,
      async stop() {
        await browser.close().catch(() => {});
        const exited = new Promise(r => server.once("exit", r));
        server.kill("SIGTERM");
        let timer;
        const gone = await Promise.race([exited.then(() => true), new Promise(r => (timer = setTimeout(r, 5000, false)))]);
        clearTimeout(timer); // or the test file waits it out

        // A server that outlives its test would hold the whole run open.
        if (!gone && server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
        try {
          await client.end();
          await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } finally {
          // Even when the drop fails (and the test with it): no connection or folder left open.
          await admin.end().catch(() => {});
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      },
    };
  } catch (e) {
    // Whatever fails from here on must not leave the server, the browser or the database behind (the run would hang).
    await browser?.close().catch(() => {});
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Waits, if needed, so a test about "today" runs whole inside one day: not in the
 * last `before` ms of a day, nor in the first `after` ms (a block never starts
 * before midnight). Give such a test a timeout above the longest wait.
 */
export async function awayFromMidnight(before = 2 * 60_000, after = 3 * 60_000) {
  const now = Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const next = new Date(midnight + 36 * 3600_000).setHours(0, 0, 0, 0);
  const until = next - now < before ? next + after : now - midnight < after ? midnight + after : now;
  if (until > now) await new Promise(r => setTimeout(r, until - now));
}


/** Pretends to be the native app's window: records the commands it gets. */
export async function mockNative(context, answers = {}) {
  await context.addInitScript(a => {
    const calls = JSON.parse(sessionStorage.getItem("native-calls") || "[]");
    window.__nativeCalls = calls;
    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          calls.push([cmd, args ?? null]);
          sessionStorage.setItem("native-calls", JSON.stringify(calls));
          return a[cmd];
        },
      },
      event: { listen: async () => () => {} },
    };
  }, answers);
}

/**
 * Answers some tRPC procedures with fixed data (what would come live from
 * Jira, which tests never reach). `fake` maps "issues.description" → data.
 * Works with batched calls: only the named procedures are replaced.
 */
export async function fakeProcedures(page, fake) {
  await page.route(/\/api\/trpc\//, async route => {
    const url = new URL(route.request().url());
    const names = decodeURIComponent(url.pathname.split("/api/trpc/")[1] ?? "").split(",");
    if (!names.some(n => n in fake)) return route.continue();
    const res = await route.fetch().catch(() => null);
    let body = [];
    try {
      body = res ? await res.json() : [];
    } catch {
      body = [];
    }
    const out = names.map((n, i) => (n in fake ? { result: { data: { json: fake[n] } } } : body[i] ?? body));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}
