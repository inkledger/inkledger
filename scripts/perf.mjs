#!/usr/bin/env node
// Measures the production builds: durations and resources, the side the
// counts of docs/dev/measuring.md leave out. Read-only towards every tracker.
//
//   pnpm perf [server|page|docker|app|all]   (default: all)
//
// server + page  dist/ on a temp Postgres DB (e2e harness) seeded with a year of
//                data: boot, memory, idle CPU, page metrics per route, then the
//                tRPC calls the pages made, replayed (latency, bytes, gzip)
// docker         the inkledger stack on :47824 (no login): image, idle stats, latency
// app            release/<version>/ sizes and the macOS app's processes, idle
//
// Writes perf/<date>-<sha>.json and prints a Markdown summary. Run `pnpm build`
// (server, page) and `pnpm dist` (app) first. Numbers vary between machines:
// compare runs on the same one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { start, APP } from "../e2e/harness.mjs";
import { freePort } from "./freePort.mjs";

const ROOT = APP;
const what = process.argv[2] ?? "all";
const has = (k) => what === "all" || what === k || (k === "page" && what === "server");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const kib = (n) => r1(n / 1024);
const mib = (n) => r1(n / 1024 / 1024);
const sh = (cmd, argv) => spawnSync(cmd, argv, { encoding: "utf8" }).stdout?.trim() ?? "";

/** RSS (KiB) and cumulative CPU seconds of some processes, from ps. */
function procStats(pids) {
  if (!pids.length) return { rssKiB: 0, cpuSec: 0 };
  const rows = sh("ps", ["-o", "rss=,time=", "-p", pids.join(",")]).split("\n").filter(Boolean);
  const cpu = (t) => t.split(/[:.]/).map(Number).reduce((s, n, i, a) => (i === a.length - 1 ? s + n / 100 : s * 60 + n), 0);
  return rows.reduce((s, row) => {
    const [rss, time] = row.trim().split(/\s+/);
    return { rssKiB: s.rssKiB + Number(rss), cpuSec: s.cpuSec + cpu(time) };
  }, { rssKiB: 0, cpuSec: 0 });
}
/** Average CPU % of some processes over a window. */
async function idleCpu(pids, ms) {
  const a = procStats(pids).cpuSec;
  await sleep(ms);
  const b = procStats(pids);
  return { cpuPct: r1(((b.cpuSec - a) / (ms / 1000)) * 100), rssMiB: r1(b.rssKiB / 1024) };
}
const listenerPid = (port) => Number(sh("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).split("\n")[0]) || null;

/** One request: time to the last byte, bytes, and what gzip would make of them. */
async function timed(url, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { headers });
  const body = Buffer.from(await res.arrayBuffer());
  return { ms: performance.now() - t0, status: res.status, bytes: body.length, gzip: gzipSync(body).length, encoding: res.headers.get("content-encoding"), body };
}
const strip = ({ body: _, ...rest }) => rest;

/** `n` requests per worker, `conc` workers at once. */
async function load(url, headers, n, conc) {
  const times = [];
  let last;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      for (let i = 0; i < n; i++) {
        last = await timed(url, headers);
        times.push(last.ms);
      }
    }),
  );
  return { p50: r1(pct(times, 50)), p95: r1(pct(times, 95)), max: r1(Math.max(...times)), status: last.status, kib: kib(last.bytes), gzipKiB: kib(last.gzip), encoding: last.encoding, body: last.body };
}

// ── Seed: a year of one person's work ────────────────────────────────────────
const ISSUES = 500;
const WORKLOGS = 1200;
async function seed(db) {
  const now = Date.now();
  await db.q(
    `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
     SELECT 1, 'PERF-' || g, 'PERF-' || g, 'Performance task number ' || g || ' with a longer summary like real ones',
            (ARRAY['To Do','In Progress','Done'])[1 + g % 3], (ARRAY['To Do','In Progress','Done'])[1 + g % 3],
            'PERF', 'Performance', 'Task', 'Medium', '[]', 'mrossi', 'https://jira.example.it/browse/PERF-' || g, ?, CASE WHEN g % 50 = 0 THEN 1 ELSE 0 END
       FROM generate_series(1, ${ISSUES}) g`,
    now,
  );
  // Four entries a day, 09:00 to 17:00, going back 300 days (started: epoch ms).
  await db.q(
    `INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at)
     SELECT 1, 1, 'PERF-' || (1 + g % ${ISSUES}), 'pw-' || g,
            (extract(epoch from date_trunc('day', to_timestamp(? / 1000.0)) - ((g / 4) || ' days')::interval + ((9 + (g % 4) * 2) || ' hours')::interval) * 1000)::bigint,
            3600 + (g % 3) * 1800, 'Work on the task', 1
       FROM generate_series(0, ${WORKLOGS - 1}) g`,
    now,
  );
}

// ── Page metrics ─────────────────────────────────────────────────────────────
const ROUTES = ["/", "/issues", "/issues/PERF-1", "/timesheet", "/board", "/reports", "/settings"];
const observe = () => {
  window.__perf = { lcp: 0, longTasks: 0, longTaskMs: 0 };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.lcp = e.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__perf.longTasks++;
      window.__perf.longTaskMs += e.duration;
    }
  }).observe({ type: "longtask", buffered: true });
};
async function measurePage(context, url, settleMs) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const trpc = [];
  let requests = 0;
  page.on("request", (r) => {
    requests++;
    if (r.method() === "GET" && r.url().includes("/api/trpc/")) trpc.push(r.url());
  });
  await page.goto(url, { waitUntil: "load" });
  await sleep(settleMs);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]));
    const res = performance.getEntriesByType("resource");
    return {
      ttfb: nav.responseStart,
      fcp: paint["first-contentful-paint"] ?? null,
      lcp: window.__perf.lcp || null,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      transferKiB: (nav.transferSize + res.reduce((s, r) => s + (r.transferSize || 0), 0)) / 1024,
      longTasks: window.__perf.longTasks,
      longTaskMs: window.__perf.longTaskMs,
    };
  });
  const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  await page.close();
  return {
    ttfb: r1(m.ttfb), fcp: r1(m.fcp), lcp: r1(m.lcp), dcl: r1(m.dcl), load: r1(m.load),
    transferKiB: r1(m.transferKiB), requests, longTasks: m.longTasks, longTaskMs: r1(m.longTaskMs),
    scriptMs: r1(metrics.ScriptDuration * 1000), layoutMs: r1(metrics.LayoutDuration * 1000),
    styleMs: r1(metrics.RecalcStyleDuration * 1000), taskMs: r1(metrics.TaskDuration * 1000),
    heapMiB: mib(metrics.JSHeapUsedSize), nodes: metrics.Nodes, trpc,
  };
}

async function serverAndPage() {
  const s0 = performance.now();
  const app = await start({ seed, env: { PROVIDERS_READ_ONLY: "1" } });
  const startMs = performance.now() - s0;
  const out = { harnessStartMs: Math.round(startMs), seed: { issues: ISSUES, worklogs: WORKLOGS } };
  try {
    const port = new URL(app.base).port;
    const pid = listenerPid(port);
    out.serverIdle = await idleCpu([pid], 10_000);

    // Boot of a second process on the same, migrated database (the usual restart).
    const [{ db: dbName }] = await app.db.q("SELECT current_database() AS db");
    const env = readFileSync(join(ROOT, ".env"), "utf8");
    const dbUrl = new URL(process.env.E2E_DATABASE_URL ?? /^DATABASE_URL=(.+)$/m.exec(env)[1].trim());
    dbUrl.pathname = `/${dbName}`;
    const boots = [];
    for (let i = 0; i < 3; i++) {
      const p2 = await freePort();
      const t0 = performance.now();
      const child = spawn(process.execPath, ["dist/boot.js"], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: "production", PORT: String(p2), DATABASE_URL: dbUrl.toString(), SESSION_SECRET: "x".repeat(64), PROVIDERS_READ_ONLY: "1", SYNC_INTERVAL_MIN: "0", STORE_URL: "off", WEATHER: "off" },
        stdio: "ignore",
      });
      for (;;) {
        try {
          if ((await fetch(`http://127.0.0.1:${p2}/api/health`)).ok) break;
        } catch {
          // not up yet
        }
        if (performance.now() - t0 > 30_000) break;
        await sleep(20);
      }
      boots.push(performance.now() - t0);
      const rss = procStats([child.pid]).rssKiB;
      if (i === 0) out.serverRssAtBootMiB = r1(rss / 1024);
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    out.bootToHealthyMs = { p50: Math.round(pct(boots, 50)), all: boots.map(Math.round) };

    // Pages: cold (new context, empty cache) then warm (same context, cached assets).
    await app.context.addInitScript(observe);
    const browser = app.context.browser();
    const cookies = await app.context.cookies();
    out.pages = {};
    const calls = new Set();
    for (const route of ROUTES) {
      const cold = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: "Europe/Rome", locale: "en-US" });
      await cold.addCookies(cookies);
      await cold.addInitScript(observe);
      const c = await measurePage(cold, app.base + route, 3000);
      const w = await measurePage(cold, app.base + route, 3000);
      await cold.close();
      c.trpc.forEach((u) => calls.add(u));
      delete c.trpc;
      delete w.trpc;
      out.pages[route] = { cold: c, warm: w };
    }

    // The same tRPC calls, replayed straight to the server.
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers = { cookie };
    out.api = {};
    for (const url of calls) {
      const name = decodeURIComponent(new URL(url).pathname.replace("/api/trpc/", ""));
      const { body, ...c1 } = await load(url, headers, 20, 1);
      const { body: _, ...c10 } = await load(url, headers, 5, 10);
      // A batch answers with one result per procedure: which of them weighs.
      const parts = name.split(",");
      const each = JSON.parse(body.toString("utf8"));
      const kibEach = Array.isArray(each) ? parts.map((p, i) => [p, kib(Buffer.byteLength(JSON.stringify(each[i])))]) : [];
      out.api[name] = { c1, c10, ...(kibEach.length > 1 ? { kibEach } : {}) };
    }
    const html = await fetch(app.base + "/").then((r) => r.text());
    const entry = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    out.static = {
      index: strip(await load(app.base + "/", { accept: "text/html" }, 20, 1)),
      entry: strip(await load(app.base + entry, {}, 10, 1)),
    };
    out.serverAfterLoad = await idleCpu([pid], 5000);
  } finally {
    await app.stop();
  }
  return out;
}

// ── Docker stack ─────────────────────────────────────────────────────────────
async function docker() {
  const base = "http://127.0.0.1:47824";
  const stats = [];
  for (let i = 0; i < 6; i++) {
    const line = sh("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", "inkledger", "inkledger-db"]).split("\n");
    stats.push(line.map((l) => l.split("|")));
    await sleep(4000);
  }
  const cpu = (i) => r1(stats.reduce((s, row) => s + parseFloat(row[i][0]), 0) / stats.length);
  const html = await fetch(base + "/", { headers: { accept: "text/html" } }).then((r) => r.text());
  const entry = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  return {
    image: { mib: mib(Number(sh("docker", ["image", "inspect", "-f", "{{.Size}}", "inkledger:latest"]))), id: sh("docker", ["image", "inspect", "-f", "{{.Id}}", "inkledger:latest"]).slice(7, 19) },
    idle: { appCpuPct: cpu(0), appMem: stats.at(-1)[0][1], dbCpuPct: cpu(1), dbMem: stats.at(-1)[1][1] },
    health: strip(await load(base + "/api/health", {}, 30, 1)),
    index: strip(await load(base + "/", { accept: "text/html", "accept-encoding": "gzip, br" }, 20, 1)),
    entry: strip(await load(base + entry, { "accept-encoding": "gzip, br" }, 10, 1)),
  };
}

// ── Native app ───────────────────────────────────────────────────────────────
async function nativeApp() {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; // one version for the server and the apps (tauri.conf.json reads it too)
  const manifest = join(ROOT, "release", version, "manifest.json");
  if (!existsSync(manifest)) return { skipped: "no release build: run pnpm dist" };
  const files = JSON.parse(readFileSync(manifest, "utf8")).files.map((f) => ({ file: f.file, mib: mib(f.size), ...(f.unpacked ? { installedMiB: mib(f.unpacked) } : {}) }));
  const bin = join(ROOT, "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/inkledger.app/Contents/MacOS/inkledger");
  if (!existsSync(bin)) return { files, run: "skipped: no .app" };
  if (sh("pgrep", ["-x", "inkledger"])) return { files, run: "skipped: inkledger is already running (single instance)" };
  // WebKit's helper processes are launchd's children, not the app's: the ones that
  // appear after the launch are taken as the app's (keep Safari closed meanwhile).
  const webkit = () => new Set(sh("pgrep", ["-f", "com.apple.WebKit"]).split("\n").filter(Boolean).map(Number));
  const before = webkit();
  const t0 = performance.now();
  const child = spawn(bin, [], { stdio: "ignore" });
  let firstWebContentMs = null;
  while (performance.now() - t0 < 20_000) {
    if (firstWebContentMs === null && [...webkit()].some((p) => !before.has(p))) firstWebContentMs = Math.round(performance.now() - t0);
    await sleep(100);
  }
  const pids = [child.pid, ...[...webkit()].filter((p) => !before.has(p))];
  const cpu0 = pids.map((p) => procStats([p]).cpuSec);
  const idle = await idleCpu(pids, 15_000);
  const perProcess = pids.map((p, i) => {
    const { rssKiB, cpuSec } = procStats([p]);
    return { proc: sh("ps", ["-o", "comm=", "-p", String(p)]).split("/").pop(), rssMiB: r1(rssKiB / 1024), cpuPct: r1(((cpuSec - cpu0[i]) / 15) * 100) };
  });
  child.kill("SIGTERM");
  return { files, run: { firstWebContentMs, processes: perProcess, idle } };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const report = { at: new Date().toISOString(), commit: sha, node: process.version };
if (has("server")) report.server = await serverAndPage();
if (has("docker")) report.docker = await docker();
if (has("app")) report.app = await nativeApp();
mkdirSync(join(ROOT, "perf"), { recursive: true });
const file = join(ROOT, "perf", `${report.at.slice(0, 19).replace(/[:T]/g, "-")}-${sha}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));

// Markdown summary.
const lines = [`# perf ${sha} (${report.at})`];
const s = report.server;
if (s) {
  lines.push("", `Server: boot to healthy p50 ${s.bootToHealthyMs.p50} ms · RSS at boot ${s.serverRssAtBootMiB} MiB · idle ${s.serverIdle.cpuPct}% CPU, ${s.serverIdle.rssMiB} MiB · after load ${s.serverAfterLoad.rssMiB} MiB`);
  lines.push("", "| Route | TTFB | FCP | LCP | load | KiB moved | req | long tasks (ms) | script ms | heap MiB | nodes | warm LCP | warm KiB |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [r, { cold: c, warm: w }] of Object.entries(s.pages)) lines.push(`| ${r} | ${c.ttfb} | ${c.fcp} | ${c.lcp} | ${c.load} | ${c.transferKiB} | ${c.requests} | ${c.longTasks} (${c.longTaskMs}) | ${c.scriptMs} | ${c.heapMiB} | ${c.nodes} | ${w.lcp} | ${w.transferKiB} |`);
  lines.push("", "| tRPC call | p50 ms | p95 ms | p95 ms ×10 | KiB | KiB gzip |", "|---|---:|---:|---:|---:|---:|");
  for (const [n, a] of Object.entries(s.api).sort((x, y) => y[1].c1.p50 - x[1].c1.p50)) lines.push(`| ${n.length > 70 ? n.slice(0, 67) + "…" : n} | ${a.c1.p50} | ${a.c1.p95} | ${a.c10.p95} | ${a.c1.kib} | ${a.c1.gzipKiB} |`);
  const heavy = Object.values(s.api).flatMap((a) => a.kibEach ?? []).filter(([, k]) => k >= 20).sort((x, y) => y[1] - x[1]);
  if (heavy.length) lines.push("", `Heaviest results: ${[...new Map(heavy).entries()].map(([p, k]) => `${p} ${k} KiB`).join(" · ")}`);
  lines.push("", `Static: index ${s.static.index.p50} ms ${s.static.index.kib} KiB · entry ${s.static.entry.p50} ms ${s.static.entry.kib} KiB (gzip would be ${s.static.entry.gzipKiB}; served ${s.static.entry.encoding ?? "uncompressed"})`);
}
const d = report.docker;
if (d) lines.push("", `Docker: image ${d.image.mib} MiB · idle app ${d.idle.appCpuPct}% ${d.idle.appMem} · db ${d.idle.dbCpuPct}% ${d.idle.dbMem} · health p50 ${d.health.p50} ms · entry ${d.entry.p50} ms ${d.entry.kib} KiB (${d.entry.encoding ?? "uncompressed"})`);
const a = report.app;
if (a) lines.push("", `App: ${a.skipped ?? a.files.map((f) => `${f.file} ${f.mib} MiB${f.installedMiB ? ` (installed ${f.installedMiB})` : ""}`).join(" · ")}`, typeof a.run === "object" ? `App run: first WebContent ${a.run.firstWebContentMs} ms · idle ${a.run.idle.cpuPct}% CPU, ${a.run.idle.rssMiB} MiB (${a.run.processes.map((p) => `${p.proc} ${p.rssMiB} MiB ${p.cpuPct}%`).join(", ")})` : `App run: ${a.run ?? "-"}`);
lines.push("", `→ ${file.slice(ROOT.length)}`);
console.log(lines.join("\n"));
