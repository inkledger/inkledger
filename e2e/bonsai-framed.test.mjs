// The ported Bonsai (host API v2, framed) end to end, beside the in-page Bonsai (v1) it replaces:
// both built here from the modules repo's sources with esbuild into a scratch folder (never
// committed), signed with a throwaway key (MODULES_TRUST_EXTRA_KEY, as modules-framed does).
// Skipped when those sources are not on this machine (the modules repo is private).
// Screenshots go to $BONSAI_SHOTS when set; $BONSAI_QUIET (ms, default 25 s) is how long a tree
// must stay unchanged to count as drawn (a cold final trace takes about a minute: 60000 waits for it).
//   BONSAI_V2_SRC=<port worktree> BONSAI_V1_SRC=<modules checkout> PROVIDERS_READ_ONLY=1 node --test e2e/bonsai-framed.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const MODS = new URL("../../inkledger-modules/", import.meta.url).pathname;
const V2 = process.env.BONSAI_V2_SRC ?? join(MODS, ".claude/worktrees/port-bonsai");
const V1 = process.env.BONSAI_V1_SRC ?? MODS;
const SHOTS = process.env.BONSAI_SHOTS ?? null;
const meta = src => JSON.parse(readFileSync(join(src, "packages/bonsai/meta.json"), "utf8"));
const ported = src => existsSync(join(src, "packages/bonsai/meta.json")) && meta(src).hostApi?.min === 2;
const skipV2 = ported(V2) ? false : "no ported Bonsai sources (BONSAI_V2_SRC)";
const skipV1 = existsSync(join(V1, "packages/bonsai/meta.json")) && !ported(V1) ? false : "no in-page Bonsai sources (BONSAI_V1_SRC)";

async function install(src, key) {
  const m = meta(src);
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-bonsai-")), "modules");
  const out = join(modulesDir, "bonsai");
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(src, "packages/bonsai/src/index.ts")],
    outfile: join(out, m.entry),
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none",
    logLevel: "silent",
    define: { __LICENSE_ID__: JSON.stringify(`bonsai-${m.version}-e2e`) },
  });
  const manifest = { ...m, files: { [m.entry]: sha256hex(readFileSync(join(out, m.entry))) } };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(out, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", key.privateKey));
  return modulesDir;
}

const watch = () => {
  if (window.top !== window) return;
  const w = window;
  w.__longTasks = [];
  w.__gaps = [];
  new PerformanceObserver(l => w.__longTasks.push(...l.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
  let last = 0;
  const tick = t => {
    if (last) w.__gaps.push([t, t - last]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function withBonsai(src, body, { software = false } = {}) {
  const key = generateKeyPairSync("ed25519");
  const modulesDir = await install(src, key);
  const license = signEnvelope(Buffer.from(JSON.stringify({ id: "L-bonsai", email_hash: "h", product: "inkledger.bonsai", issued: 1, v: 1 })), "inkledger-license-v1\n", key.privateKey);
  const app = await start({
    seed: db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now()),
    env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: key.publicKey.export({ type: "spki", format: "pem" }).toString(), MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1", STORE_URL: "off", WEATHER: "off" },
  });
  const consoleErrors = [];
  app.page.on("console", m => m.type() === "error" && consoleErrors.push(m.text()));
  if (process.env.BONSAI_DEBUG) app.page.on("console", m => console.info(`[console ${m.type()}] ${m.text()}`));
  try {
    await app.context.addInitScript(watch);
    // The page only (a sandboxed frame has no storage).
    if (software) await app.context.addInitScript(() => window.top === window && localStorage.setItem("inkledger-render", "software"));
    await body({ ...app, consoleErrors });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
}

const perfSince = (page, from) =>
  page.evaluate(from => {
    const gaps = window.__gaps.filter(([t]) => t >= from).map(([, g]) => g).sort((a, b) => a - b);
    const at = q => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
    return { frames: gaps.length, p50: at(0.5), p95: at(0.95), worst: gaps.at(-1) ?? 0, longTasks: window.__longTasks.filter(t => t.start + t.duration >= from).map(t => Math.round(t.duration)) };
  }, from);
const now = page => page.evaluate(() => performance.now());
const show = (name, p) => `${name}: ${p.frames} frames, gap p50 ${p.p50.toFixed(1)} / p95 ${p.p95.toFixed(1)} / worst ${p.worst.toFixed(1)} ms, long tasks [${p.longTasks.join(", ")}]`;

const PERCH = '[data-module-slot="dashboard-perch"]';
// The slot itself takes no box (display: contents): the module's box does.
const PERCH_BOX = `${PERCH} [data-module="bonsai"]`;
const PERCH_FRAME = `${PERCH} iframe[data-module-frame="view"]`;
const WIDGET = '[data-module-slot="dashboard-widget"]';
const WIDGET_FRAME = `${WIDGET} iframe[data-module-frame="view"]`;
const SETTINGS_FRAME = '[data-module-slot="settings"] iframe[data-module-frame="view"]';
// The module's own sheet, over its settings' sheet (both dialogs).
const SHEET_FRAME = '[role="dialog"]:not(:has([data-module-slot="settings"])) iframe[data-module-frame="view"]';

/** In `frame` (the page, or a view's frame): the tree's latest picture has pixels, and no new one came for `quietMs` (the final picture). */
async function drawnAndSettled(frame, scope, quietMs = Number(process.env.BONSAI_QUIET ?? 25_000), timeout = 240_000) {
  await frame.waitForFunction(
    ({ scope, quietMs }) => {
      const root = document.querySelector(scope) ?? document.body;
      const w = window;
      if (!w.__treeWatch) {
        w.__treeWatch = { last: performance.now() };
        new MutationObserver(() => (w.__treeWatch.last = performance.now())).observe(root, { childList: true, subtree: true });
      }
      const cv = [...root.querySelectorAll("canvas")].filter(c => c.width && c.getAttribute("aria-hidden") === "true").at(-1);
      if (!cv) return false;
      const t = document.createElement("canvas");
      t.width = 64;
      t.height = 50;
      const g = t.getContext("2d");
      g.drawImage(cv, 0, 0, 64, 50);
      const d = g.getImageData(0, 0, 64, 50).data;
      let on = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) on++;
      return on > 20 && performance.now() - w.__treeWatch.last > quietMs;
    },
    { scope, quietMs },
    { timeout, polling: 500 },
  );
}

async function shot(page, selector, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  // The perch's box with some of the timeline around it.
  const pad = 24;
  await page.screenshot({ path: join(SHOTS, name), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
}

const measured = {};

/** A person at work while the tree traces (it starts a few seconds after the page): scrolling and keys for about 25 s. */
async function workWhileTracing(page) {
  await page.waitForTimeout(4000);
  for (let i = 0; i < 50; i++) {
    await page.mouse.wheel(0, i % 2 ? -240 : 240);
    if (i % 5 === 0) await page.keyboard.press(i % 10 ? "ArrowUp" : "ArrowDown");
    await page.waitForTimeout(500);
  }
}

/** The Store's settings for Bonsai, place chosen: in the page (v1) or in its frame (v2). */
async function choosePlace(page, base, place, framed) {
  await page.goto(base + "/settings/store");
  await page.locator('[data-store-item="bonsai"]').getByRole("button", { name: /: manage Bonsai$/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const scope = framed ? (await page.locator(`${SETTINGS_FRAME}[data-state="live"]`).waitFor(), await (await page.locator(SETTINGS_FRAME).elementHandle()).contentFrame()) : page.mainFrame();
  const radio = scope.locator(`input[type=radio][value="${place}"]:not([disabled])`);
  await radio.first().waitFor();
  await page.waitForTimeout(500);
  await radio.first().click();
  await scope.waitForFunction(p => document.querySelector(`input[type=radio][value="${p}"]`)?.checked === true, place);
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
}

/** The card on the Desk, scrolled into view (offscreen frames are paused), drawn and settled; its screenshot. */
async function cardShot(page, base, framed, name, quietMs = 8000) {
  await page.goto(base + "/");
  const box = page.locator(`${WIDGET} [data-module="bonsai"]`);
  await box.waitFor();
  await box.scrollIntoViewIfNeeded();
  const frame = framed ? (await page.locator(`${WIDGET_FRAME}[data-state="live"]`).waitFor(), await (await page.locator(WIDGET_FRAME).elementHandle()).contentFrame()) : page.mainFrame();
  await drawnAndSettled(frame, framed ? "#ikl-box" : `${WIDGET} [data-module="bonsai"]`, quietMs);
  await shot(page, `${WIDGET} [data-module="bonsai"]`, name);
}

test("in-page Bonsai (v1): the tree on the timeline, the frame gaps to compare with", { skip: skipV1 || skipV2, timeout: 400_000 }, () =>
  withBonsai(V1, async ({ page, base }) => {
    const from = await now(page);
    await page.goto(base + "/");
    await page.locator(PERCH).first().waitFor();
    const traceFrom = await now(page);
    await workWhileTracing(page);
    await drawnAndSettled(page.mainFrame(), PERCH);
    measured.v1 = { load: await perfSince(page, from), trace: await perfSince(page, traceFrom) };
    const idleFrom = await now(page);
    await page.waitForTimeout(3000);
    measured.v1.idle = await perfSince(page, idleFrom);
    await shot(page, PERCH_BOX, "v1-perch.png");
    for (const [k, p] of Object.entries(measured.v1)) console.info(`[bonsai] ${show("v1 " + k, p)}`);
    // The card, to set beside the framed one.
    await choosePlace(page, base, "card", false);
    await cardShot(page, base, false, "v1-card.png");
  }));

test("framed Bonsai (v2): the tree draws on the timeline, the card stays off the Desk, a click opens its settings, the card follows a choice, the film plays in the sheet", { skip: skipV2, timeout: 600_000 }, () =>
  withBonsai(V2, async ({ page, base, consoleErrors }) => {
    const from = await now(page);
    await page.goto(base + "/");
    await page.locator(`${PERCH_FRAME}[data-state="live"]`).waitFor({ timeout: 60_000 });
    const traceFrom = await now(page);
    await workWhileTracing(page);
    const perch = await (await page.locator(PERCH_FRAME).elementHandle()).contentFrame();
    await drawnAndSettled(perch, "#ikl-box");
    measured.v2 = { load: await perfSince(page, from), trace: await perfSince(page, traceFrom) };
    const idleFrom = await now(page);
    await page.waitForTimeout(3000);
    measured.v2.idle = await perfSince(page, idleFrom);
    await shot(page, PERCH_BOX, "v2-perch.png");
    for (const [k, p] of Object.entries(measured.v2)) console.info(`[bonsai] ${show("v2 " + k, p)}`);
    for (const k of ["trace", "idle"]) assert.deepEqual(measured.v2[k].longTasks.filter(d => d > 50), [], `no long task over 50 ms (${k})`);

    // "Quick stats" (the default): the card asked the host to take it off the Desk.
    const card = page.locator(`${WIDGET} [data-module="bonsai"]`);
    await page.waitForFunction(sel => document.querySelector(sel)?.hidden === true, `${WIDGET} [data-module="bonsai"]`, { timeout: 10_000 });
    assert.equal(await card.isVisible(), false, "no empty card on the Desk");

    // A click on the tree opens its settings (the host tests the click against the tree's shape).
    const box = await page.locator(PERCH_BOX).first().boundingBox();
    const at = await perch.evaluate(() => {
      const cv = [...document.querySelectorAll("canvas")].filter(c => c.width && c.getAttribute("aria-hidden") === "true").at(-1);
      const r = cv.getBoundingClientRect();
      const t = document.createElement("canvas");
      t.width = 128;
      t.height = 100;
      const g = t.getContext("2d");
      g.drawImage(cv, 0, 0, 128, 100);
      const d = g.getImageData(0, 0, 128, 100).data;
      // The picture is contained, bottom left: find its most solid column's middle (the trunk).
      const k = Math.min(r.width / cv.width, r.height / cv.height);
      const pw = cv.width * k, ph = cv.height * k;
      let best = null;
      for (let y = 60; y < 95 && !best; y++) for (let x = 20; x < 108 && !best; x++) if (d[(y * 128 + x) * 4 + 3] > 200) best = { x: (x / 128) * pw, y: r.height - ph + (y / 100) * ph };
      return best;
    });
    assert.ok(at, "a solid point of the tree");
    await page.mouse.click(box.x + at.x, box.y + at.y);
    await page.locator(`${SETTINGS_FRAME}[data-state="live"]`).waitFor({ timeout: 15_000 });
    const settings = await (await page.locator(SETTINGS_FRAME).elementHandle()).contentFrame();
    await settings.locator('input[type=radio][value="card"]:not([disabled])').waitFor();
    if (SHOTS) await page.locator('[role="dialog"]').first().screenshot({ path: join(SHOTS, "v2-settings.png") });

    // "On your desk" chosen: the card comes back on the Desk and draws the tree.
    await settings.locator('input[type=radio][value="card"]').check();
    await page.waitForFunction(sel => document.querySelector(sel)?.hidden === false, `${WIDGET} [data-module="bonsai"]`, { timeout: 10_000 });

    // The memory film: from the settings into the module's sheet.
    const filmFrom = await now(page);
    const drawingLine = await settings.locator("p").last().textContent();
    console.info(`[bonsai] settings' drawing line: ${drawingLine}`);
    await settings.getByRole("button", { name: /Watch it grow/ }).click();
    await page.locator(`${SHEET_FRAME}[data-state="live"]`).waitFor({ timeout: 15_000 });
    const sheet = await (await page.locator(SHEET_FRAME).elementHandle()).contentFrame();
    await sheet.locator("canvas").first().waitFor();
    await page.waitForTimeout(2500);
    measured.v2.film = await perfSince(page, filmFrom);
    console.info(`[bonsai] ${show("v2 film", measured.v2.film)}`);
    if (SHOTS) await page.locator(SHEET_FRAME).screenshot({ path: join(SHOTS, "v2-film.png") });
    await page.keyboard.press("Escape");
    await page.locator(SHEET_FRAME).waitFor({ state: "detached", timeout: 10_000 });
    await page.keyboard.press("Escape");

    await cardShot(page, base, true, "v2-card.png");
    assert.deepEqual(consoleErrors, [], "no console errors");
    if (measured.v1) console.info(`[bonsai] gap p95 v1 → v2: trace ${measured.v1.trace.p95.toFixed(1)} → ${measured.v2.trace.p95.toFixed(1)} ms, idle ${measured.v1.idle.p95.toFixed(1)} → ${measured.v2.idle.p95.toFixed(1)} ms`);
  }));

test("framed Bonsai without a graphics card: no tree on the timeline, the card a still picture", { skip: skipV2, timeout: 400_000 }, () =>
  withBonsai(
    V2,
    async ({ page, base }) => {
      await page.goto(base + "/");
      await page.locator(`${PERCH_FRAME}[data-state="live"]`).waitFor({ timeout: 60_000 });
      await page.waitForTimeout(6000);
      const perch = await (await page.locator(PERCH_FRAME).elementHandle()).contentFrame();
      const canvases = await perch.evaluate(() => document.querySelectorAll("canvas[aria-hidden=true]").length);
      assert.equal(canvases, 0, "no tree traced on the timeline");
      await shot(page, PERCH_BOX, "v2-software-perch.png");
      // On the card: drawn on the CPU, in the worker of its frame.
      await choosePlace(page, base, "card", true);
      await cardShot(page, base, true, "v2-software-card.png");
    },
    { software: true },
  ));
