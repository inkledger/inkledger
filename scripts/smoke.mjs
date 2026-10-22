// Boots the production bundle (dist/boot.js) on a free port with a temp
// database and checks health, SPA fallback, asset caching and headers.
// Run after `pnpm build`.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { freePort } from "./freePort.mjs";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Nobody else's (the Docker stacks'), so the checks run against this server.
const port = await freePort();
const dir = mkdtempSync(join(tmpdir(), "ikl-smoke-"));
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ["dist/boot.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: `pglite:${join(dir, "pg")}`,
    SESSION_SECRET: randomBytes(32).toString("hex"),
    // Never write to a real tracker, and no background sync during the check.
    PROVIDERS_READ_ONLY: "1",
    STORE_URL: "off",
    WEATHER: "off",
    SYNC_INTERVAL_MIN: "0",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
let out = "";
server.stdout.on("data", (d) => {
  out += d;
  process.stdout.write(d);
});

function check(cond, msg) {
  if (!cond) throw new Error(`smoke: ${msg}`);
  console.log(`ok - ${msg}`);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("smoke: server did not become healthy");
}

try {
  const health = await waitForHealth();
  check((await health.json()).status === "ok", "/api/health reports ok");

  const page = await fetch(`${base}/timesheet`, { headers: { accept: "text/html" } });
  check(page.ok && (await page.text()).includes('<div id="root">'), "SPA fallback serves index.html");
  check(page.headers.get("cache-control") === "no-cache", "index.html is not cached");
  check(page.headers.get("x-content-type-options") === "nosniff", "security headers present");
  const csp = page.headers.get("content-security-policy") ?? "";
  check(
    /script-src 'self' 'sha256-/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) &&
      /connect-src 'self' ipc: http:\/\/ipc\.localhost/.test(csp),
    "CSP allows inline scripts by hash only",
  );

  // The entry chunk the page loads first, at most 5% over its size after Wave 3 (880.8 KiB,
  // 280.9 KiB gzip; docs/dev/measuring.md). Raising the limit is a deliberate, explained edit.
  const entry = /<script[^>]*type="module"[^>]*src="\/assets\/([^"]+)"/.exec(readFileSync("dist/public/index.html", "utf8"))?.[1];
  const entryBytes = entry ? readFileSync(join("dist/public/assets", entry)) : Buffer.alloc(0);
  const kib = (n) => (n / 1024).toFixed(1);
  check(
    !!entry && entryBytes.length <= 925 * 1024 && gzipSync(entryBytes, { level: 9 }).length <= 295 * 1024,
    `entry chunk within budget (${kib(entryBytes.length)} KiB, ${kib(gzipSync(entryBytes, { level: 9 }).length)} KiB gzip; at most 925 / 295)`,
  );

  const asset = readdirSync("dist/public/assets").find((f) => f.endsWith(".js"));
  const a = await fetch(`${base}/assets/${asset}`);
  check(a.ok && /immutable/.test(a.headers.get("cache-control") ?? ""), "hashed assets cached immutable");

  const moduleFile = await fetch(`${base}/api/modules/x/${"0".repeat(32)}/index.js`);
  check(moduleFile.status === 401, "module code needs a session");

  const api404 = await fetch(`${base}/api/nope`);
  check(api404.status === 404, "unknown API route is 404 JSON");

  const csrf = await fetch(`${base}/api/trpc/auth.logout`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  check(csrf.status === 403, "cross-origin POST rejected");

  // fetch() won't override Host: use node:http to mimic a rebound DNS name.
  const rebound = await new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  check(rebound === 421, "foreign Host header rejected");

  // The page names its build; an app of another build is told to reload (T9).
  const html = await (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const build = /<meta name="app-build" content="([^"]+)"/.exec(html)?.[1];
  check(!!build, "the page names its build");
  const stale = await fetch(`${base}/api/trpc/auth.remembered`, { headers: { "x-app-build": "older-build" } });
  check(stale.status === 409 && (await stale.text()).includes("APP_BUILD_CHANGED"), "an app of another build is told to reload");
  const same = await fetch(`${base}/api/trpc/auth.remembered`, { headers: { "x-app-build": build } });
  check(same.status !== 409, "the same build is served");

  // Webhooks are off until a connection turns them on.
  const hook = await fetch(`${base}/api/hooks/1/${"0".repeat(32)}`, { method: "POST", body: "{}" });
  check(hook.status === 404, "webhooks answer nothing while off");

  // The registry held to the contract at start (a broken adapter stops the server); it writes to no tracker.
  check(/Read-only/.test(out), "the server says it writes to no tracker");
} finally {
  // Gone before its database folder goes; one that doesn't stop is killed.
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  let timer;
  const gone = await Promise.race([exited.then(() => true), new Promise((r) => (timer = setTimeout(r, 5000, false)))]);
  clearTimeout(timer);
  if (!gone && server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
