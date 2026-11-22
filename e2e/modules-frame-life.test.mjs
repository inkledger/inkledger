// Framed modules (host API v2) as the ported ones use the page: six at once
// (a runtime and two views each) within the frame budget and smooth, a strip
// on the panel's edge, a pill on the phone's tab bar, and a view's cleanup
// running where nothing can park its frame (no moveBefore, as in WebKit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const TEMPLATE = readFileSync(new URL("./fixtures/modules/life/index.js", import.meta.url), "utf8");
const PHONE = { viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };

function install(modulesDir, id, slots, capabilities) {
  const code = Buffer.from(TEMPLATE.replace('id: "life"', `id: "${id}"`));
  const manifest = { id, product: `inkledger.${id}`, entry: "index.js", name: { en: id, it: id }, files: { "index.js": sha256hex(code) }, version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities, slots };
  mkdirSync(join(modulesDir, id), { recursive: true });
  writeFileSync(join(modulesDir, id, "index.js"), code);
  writeFileSync(join(modulesDir, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, id, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = id =>
  signEnvelope(Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

// The page's own long tasks and frame gaps, and when the first module frame appeared (the app page only).
const watch = () => {
  if (window.top !== window) return;
  const w = window;
  w.__longTasks = [];
  w.__gaps = [];
  w.__frameAt = null;
  new PerformanceObserver(l => w.__longTasks.push(...l.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
  new MutationObserver(() => {
    if (w.__frameAt === null && document.querySelector("iframe[data-module-frame]")) w.__frameAt = performance.now();
  }).observe(document, { childList: true, subtree: true });
  let last = 0;
  const tick = t => {
    if (last) w.__gaps.push([t, t - last]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/** `mods`: id → [slots, capabilities]. */
async function withLife(mods, body, { device = {}, before } = {}) {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-life-")), "modules");
  for (const [id, [slots, caps]] of Object.entries(mods)) install(modulesDir, id, slots, caps);
  const seed = db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(Object.keys(mods).map(license)), Date.now());
  const app = await start({ seed, ...device, env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" } });
  try {
    await app.context.addInitScript(watch);
    await before?.(app);
    await app.page.goto(app.base + "/");
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
}

const LIVE = 'iframe[data-module-frame][data-state="live"]';

test("six framed modules, a runtime and two views each: all within the budget, and smooth", () => {
  const mods = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`life${n}`, [["dashboard-widget", "panel-edge"], ["runtime"]]]));
  return withLife(mods, async ({ page }) => {
    await page.waitForFunction(sel => document.querySelectorAll(sel).length === 18, LIVE, { timeout: 30_000 });
    assert.equal(await page.locator('[data-module-runtimes] iframe[data-module-frame="runtime"]').count(), 6);
    await page.waitForTimeout(1500);
    const perf = await page.evaluate(() => {
      const from = window.__frameAt;
      const gaps = window.__gaps.filter(([t]) => t >= from).map(([, g]) => g).sort((a, b) => a - b);
      return {
        longTasks: window.__longTasks.filter(t => t.start + t.duration >= from),
        worstGap: gaps.at(-1) ?? 0,
        p95Gap: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
      };
    });
    console.info(`[frame budget] 18 frames: worst frame gap ${perf.worstGap.toFixed(1)} ms, p95 ${perf.p95Gap.toFixed(1)} ms, long tasks ${perf.longTasks.map(t => Math.round(t.duration)).join(",") || "none"}`);
    assert.deepEqual(perf.longTasks.filter(t => t.duration > 50), [], "no long task while 18 frames mount");
  });
});

test("the panel's edge: a strip along it that only its shape makes clickable, no Tab stop of the host's", () =>
  withLife({ edge1: [["panel-edge"], []] }, async ({ page }) => {
    const sel = '[data-module-slot="panel-edge"] [data-module="edge1"]';
    await page.locator(`${sel} ${LIVE}`).waitFor();
    const strip = await page.locator(`${sel} iframe`).boundingBox();
    const main = await page.locator("main").boundingBox();
    const near = (a, b) => Math.abs(a - b) <= 2;
    assert.ok(near(strip.x, main.x) && near(strip.width, main.width), JSON.stringify({ strip, main }));
    assert.ok(near(strip.height, 84) && near(strip.y + strip.height, main.y + main.height + 10), JSON.stringify({ strip, main }));
    assert.equal(await page.locator(`${sel} iframe`).evaluate(el => getComputedStyle(el).pointerEvents), "none");
    // Beside the burrow the page keeps the click; on it, the module gets it.
    const footY = strip.y + strip.height - 10 - 20;
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-module]") ?? null, { x: strip.x + 120, y: footY }), null);
    await page.mouse.click(strip.x + 20, footY);
    await page.frameLocator(`${sel} iframe`).getByTestId("life-edge").filter({ hasText: "edge hit" }).waitFor();
    assert.deepEqual(await page.locator(sel).evaluate(el => [el.getAttribute("tabindex"), el.getAttribute("role")]), [null, null]);
  }));

test("the phone's dock: room for the pill above the tab bar, the pointer only while it shows", () =>
  withLife(
    { dock1: [["mobile-dock"], ["dock"]] },
    async ({ page }) => {
      const sel = '[data-module-slot="mobile-dock"] [data-module="dock1"]';
      await page.locator(`${sel}[data-docked] ${LIVE}`).waitFor();
      const box = await page.locator(`${sel} iframe`).boundingBox();
      const bar = await page.locator("[data-tab-bar]").boundingBox();
      assert.ok(Math.abs(box.height - 52) <= 1 && Math.abs(box.width - 260) <= 1 && Math.abs(box.y + box.height - bar.y) <= 1, JSON.stringify({ box, bar }));
      assert.equal(await page.locator(sel).evaluate(el => getComputedStyle(el).pointerEvents), "auto");
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dock-h").trim()), "0px", "the page keeps its last row clear");
      // A tap where the pill shows reaches it (Playwright checks nothing else is hit there).
      const pill = page.frameLocator(`${sel} iframe`).getByTestId("life-pill");
      await pill.filter({ hasText: "playing" }).tap();
      await pill.filter({ hasText: "stopped" }).waitFor();
      await page.locator(`${sel}:not([data-docked])`).waitFor();
      assert.equal(await page.locator(sel).evaluate(el => getComputedStyle(el).pointerEvents), "none");
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dock-h").trim()), "0px");
    },
    { device: PHONE },
  ));

test("no moveBefore (WebKit): a view removed with its box still runs its cleanup, as its document goes", () =>
  withLife(
    { gone1: [["dashboard-widget"], []] },
    async ({ page }) => {
      const said = [];
      page.on("console", m => said.push(m.text()));
      const card = page.locator('[data-module-slot="dashboard-widget"] [data-module="gone1"]');
      await card.scrollIntoViewIfNeeded();
      await card.locator(LIVE).waitFor({ state: "attached" });
      assert.equal(await page.evaluate(() => "moveBefore" in Element.prototype), false);
      // Away from the Dashboard: its card, and the frame in it, leave the page.
      await page.evaluate(() => {
        history.pushState({}, "", "/board");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await page.locator('[data-module="gone1"]').waitFor({ state: "detached" });
      await page.waitForTimeout(300);
      // (What it asks of the host from there is lost: the frame's document is going.)
      assert.ok(said.includes("life cleanup ran: gone1"), JSON.stringify(said));
    },
    { before: app => app.context.addInitScript(() => delete Element.prototype.moveBefore) },
  ));
