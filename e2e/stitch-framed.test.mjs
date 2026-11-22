// The ported Stitch (host API v2, framed) end to end, beside the in-page Stitch (v1) it replaces:
// both built here from the modules repo's sources with esbuild into a scratch folder (never
// committed), signed with a throwaway key (MODULES_TRUST_EXTRA_KEY, as modules-framed does).
// Skipped when those sources are not on this machine (the modules repo is private).
//   STITCH_V2_SRC=<port worktree> STITCH_V1_SRC=<modules checkout> PROVIDERS_READ_ONLY=1 node --test e2e/stitch-framed.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const MODS = new URL("../../inkledger-modules/", import.meta.url).pathname;
const V2 = process.env.STITCH_V2_SRC ?? join(MODS, ".claude/worktrees/port-stitch");
const V1 = process.env.STITCH_V1_SRC ?? MODS;
const meta = src => JSON.parse(readFileSync(join(src, "packages/stitch/meta.json"), "utf8"));
const ported = src => existsSync(join(src, "packages/stitch/meta.json")) && meta(src).hostApi?.min === 2;
const skipV2 = ported(V2) ? false : "no ported Stitch sources (STITCH_V2_SRC)";
const skipV1 = existsSync(join(V1, "packages/stitch/meta.json")) && !ported(V1) ? false : "no in-page Stitch sources (STITCH_V1_SRC)";

/** Stitch from `src`, bundled as the modules repo bundles it, signed with `key`, in a new modules folder. */
async function install(src, key) {
  const m = meta(src);
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-stitch-")), "modules");
  const out = join(modulesDir, "stitch");
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(src, "packages/stitch/src/index.ts")],
    outfile: join(out, m.entry),
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none",
    logLevel: "silent",
    define: { __LICENSE_ID__: JSON.stringify(`stitch-${m.version}-e2e`) },
  });
  const manifest = { ...m, files: { [m.entry]: sha256hex(readFileSync(join(out, m.entry))) } };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(out, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", key.privateKey));
  return modulesDir;
}

// The page's long tasks and frame gaps (the app page only).
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

async function withStitch(src, body) {
  const key = generateKeyPairSync("ed25519");
  const modulesDir = await install(src, key);
  const license = signEnvelope(Buffer.from(JSON.stringify({ id: "L-stitch", email_hash: "h", product: "inkledger.stitch", issued: 1, v: 1 })), "inkledger-license-v1\n", key.privateKey);
  const app = await start({
    seed: db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now()),
    env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: key.publicKey.export({ type: "spki", format: "pem" }).toString(), MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1", STORE_URL: "off", WEATHER: "off" },
  });
  const consoleErrors = [];
  app.page.on("console", m => m.type() === "error" && consoleErrors.push(m.text()));
  try {
    await app.context.addInitScript(watch);
    await body({ ...app, consoleErrors });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
}

/** Long tasks and frame gaps of the page since `from` (performance.now()). */
const perfSince = (page, from) =>
  page.evaluate(from => {
    const gaps = window.__gaps.filter(([t]) => t >= from).map(([, g]) => g).sort((a, b) => a - b);
    const at = q => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] ?? 0;
    return { frames: gaps.length, p50: at(0.5), p95: at(0.95), worst: gaps.at(-1) ?? 0, longTasks: window.__longTasks.filter(t => t.start + t.duration >= from).map(t => Math.round(t.duration)) };
  }, from);
const now = page => page.evaluate(() => performance.now());
const show = (name, p) => `${name}: ${p.frames} frames, gap p50 ${p.p50.toFixed(1)} / p95 ${p.p95.toFixed(1)} / worst ${p.worst.toFixed(1)} ms, long tasks [${p.longTasks.join(", ")}]`;

const WIDGET = '[data-module-slot="dashboard-widget"] iframe[data-module-frame="view"]';
const SHEET = '[role="dialog"] iframe[data-module-frame="view"]';
const SETTINGS = '[data-module-slot="settings"] iframe[data-module-frame="view"]';
const measured = {};

/** In `frame`: the card's canvas has pixels (it drew). */
const cardDrawn = frame =>
  frame.waitForFunction(() => {
    const cv = document.querySelector("[data-stitch-card] canvas");
    if (!cv || !cv.width || !cv.height) return false;
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) return true;
    return false;
  });

/** The dashboard's card on screen and drawn, idle for 3 s, then its panel opened: what each phase cost the page. */
async function dashboardPhases(page, card, panelOpen) {
  await card.scrollIntoViewIfNeeded();
  await card.waitFor();
  const idleFrom = await now(page);
  await page.waitForTimeout(3000);
  const idle = await perfSince(page, idleFrom);
  const openFrom = await now(page);
  await card.click();
  await panelOpen();
  await page.waitForTimeout(1000);
  const open = await perfSince(page, openFrom);
  return { idle, open };
}

test("in-page Stitch (v1): the frame gaps to compare with", { skip: skipV1 || skipV2, timeout: 300_000 }, () =>
  withStitch(V1, async ({ page, base }) => {
    await page.goto(base + "/");
    const card = page.locator("[data-stitch-card]").first();
    await card.scrollIntoViewIfNeeded();
    await cardDrawn(page.mainFrame());
    measured.v1 = await dashboardPhases(page, card, () => page.locator("[data-stitch-panel]").waitFor());
    console.info(`[stitch] ${show("v1 idle", measured.v1.idle)}`);
    console.info(`[stitch] ${show("v1 panel", measured.v1.open)}`);
  }));

test("framed Stitch (v2): the card draws, the panel opens in the host's sheet, a large PNG downloads, settings take their content height", { skip: skipV2, timeout: 300_000 }, () =>
  withStitch(V2, async ({ page, base, consoleErrors }) => {
    await page.goto(base + "/");
    await page.locator(WIDGET).scrollIntoViewIfNeeded();
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    const widget = page.frameLocator(WIDGET);
    const card = widget.locator("[data-stitch-card]");
    // The card draws: its canvas has pixels.
    await card.waitFor();
    await cardDrawn(await (await page.locator(WIDGET).elementHandle()).contentFrame());

    measured.v2 = await dashboardPhases(page, card, () => page.locator(`${SHEET}[data-state="live"]`).waitFor());
    console.info(`[stitch] ${show("v2 idle", measured.v2.idle)}`);
    console.info(`[stitch] ${show("v2 panel", measured.v2.open)}`);
    for (const [phase, p] of Object.entries(measured.v2)) assert.deepEqual(p.longTasks.filter(d => d > 50), [], `no long task over 50 ms (${phase})`);

    // The panel draws in the host's sheet, and its PNG comes down whole through the host.
    const panel = page.frameLocator(SHEET).locator("[data-stitch-panel]");
    await panel.waitFor();
    const exportFrom = await now(page);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), panel.locator('[data-stitch-download="hero"]').click()]);
    const file = await download.path();
    const bytes = statSync(file).size;
    const head = readFileSync(file).subarray(0, 8);
    const exported = await perfSince(page, exportFrom);
    console.info(`[stitch] export: ${download.suggestedFilename()} ${(bytes / 1e6).toFixed(2)} MB; ${show("v2 export", exported)}`);
    assert.match(download.suggestedFilename(), /^stitch-.+\.png$/);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
    assert.ok(bytes > 1024 * 1024, `a picture over the old 1 MB cap (${bytes} B)`);
    assert.deepEqual(exported.longTasks.filter(d => d > 50), [], "no long task over 50 ms (export)");

    // Closed: the sheet's frame is parked while its cleanup runs, then goes; nothing left parked.
    await page.evaluate(() => {
      const shelf = document.querySelector("[data-module-runtimes]");
      window.__parked = { canMove: "moveBefore" in Element.prototype, in: null, out: null };
      new MutationObserver(records => {
        for (const r of records) {
          if ([...r.addedNodes].some(n => n.dataset?.moduleFrame === "view")) window.__parked.in = performance.now();
          if ([...r.removedNodes].some(n => n.dataset?.moduleFrame === "view")) window.__parked.out = performance.now();
        }
      }).observe(shelf, { childList: true });
    });
    await page.keyboard.press("Escape");
    await page.locator(SHEET).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelectorAll('[data-module-runtimes] iframe[data-module-frame="view"]').length === 0, null, { timeout: 2000 });
    const parked = await page.evaluate(() => window.__parked);
    console.info(`[stitch] sheet closed: parked ${parked.in !== null}, gone after ${parked.in !== null && parked.out !== null ? (parked.out - parked.in).toFixed(0) : "-"} ms`);
    if (parked.canMove) assert.ok(parked.in !== null && parked.out !== null, "parked for its cleanup, then removed");

    // Its settings in the Store: the frame takes the height of what it holds, not a default.
    await page.goto(base + "/settings/store");
    await page.locator('[data-store-item="stitch"]').getByRole("button", { name: /^Manage Stitch/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.locator(`${SETTINGS}[data-state="live"]`).waitFor();
    const settings = await (await page.locator(SETTINGS).elementHandle()).contentFrame();
    await settings.locator("[data-stitch-settings] input[type=checkbox]").first().waitFor();
    await page.waitForFunction(sel => (document.querySelector(sel)?.getBoundingClientRect().height ?? 0) > 0, SETTINGS);
    await page.waitForTimeout(300);
    const height = await page.locator(SETTINGS).evaluate(el => el.getBoundingClientRect().height);
    // Its content measured on its own: from the root's top to its last row's bottom (the root itself fills the frame).
    const inside = await settings.evaluate(() => {
      const root = document.querySelector("[data-stitch-settings]");
      const top = root.getBoundingClientRect().top - root.scrollTop;
      const bottom = Math.max(...[...root.children].map(c => c.getBoundingClientRect().bottom));
      return { content: bottom - top + parseFloat(getComputedStyle(root).paddingBottom), scrolls: root.scrollHeight > root.clientHeight + 1 };
    });
    console.info(`[stitch] settings frame ${height} px; content ${inside.content.toFixed(1)} px`);
    assert.notEqual(height, 150, "not the browser's default frame height");
    assert.ok(Math.abs(height - inside.content) <= 2, `the frame is as tall as its content (${height} vs ${inside.content})`);
    assert.equal(inside.scrolls, false, "nothing of it hidden behind a scroll");

    assert.deepEqual(consoleErrors, [], "no console errors");
    if (measured.v1) console.info(`[stitch] gap p95 v1 → v2: idle ${measured.v1.idle.p95.toFixed(1)} → ${measured.v2.idle.p95.toFixed(1)} ms, panel ${measured.v1.open.p95.toFixed(1)} → ${measured.v2.open.p95.toFixed(1)} ms`);
  }));
