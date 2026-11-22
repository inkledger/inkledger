// The framed modules' watchdog end to end: a module that hogs the thread is
// held to a smaller budget, paused, then stopped for the session, while a
// well-behaved framed module beside it (same process) keeps running and the
// page itself stays smooth.
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
const fixture = id => readFileSync(new URL(`./fixtures/modules/${id}/index.js`, import.meta.url));

const MANIFESTS = {
  framed: { version: "2.0.0", hostApi: { min: 1, max: 2 }, runtime: "frame", capabilities: ["runtime"], slots: ["dashboard-widget", "dashboard-overlay"] },
  hog: { version: "2.0.0", hostApi: { min: 1, max: 2 }, runtime: "frame", capabilities: [], slots: ["dashboard-widget"] },
};

function install(modulesDir, id) {
  const code = fixture(id);
  const manifest = { id, product: `inkledger.${id}`, entry: "index.js", name: { en: id, it: id }, files: { "index.js": sha256hex(code) }, ...MANIFESTS[id] };
  mkdirSync(join(modulesDir, id), { recursive: true });
  writeFileSync(join(modulesDir, id, "index.js"), code);
  writeFileSync(join(modulesDir, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, id, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = id =>
  signEnvelope(
    Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })),
    "inkledger-license-v1\n",
    KEY.privateKey,
  );
const seed = db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(Object.keys(MANIFESTS).map(license)), Date.now());

// The page's long tasks and frame gaps from the first module frame on, and every ladder step of a module frame.
const watch = () => {
  if (window.top !== window) return;
  const w = window;
  w.__longTasks = [];
  w.__gaps = [];
  w.__frameAt = null;
  w.__steps = [];
  new PerformanceObserver(l => w.__longTasks.push(...l.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
  new MutationObserver(records => {
    if (w.__frameAt === null && document.querySelector("iframe[data-module-frame]")) w.__frameAt = performance.now();
    for (const r of records) {
      if (r.type !== "attributes" || !(r.target instanceof HTMLIFrameElement)) continue;
      const id = r.target.closest("[data-module]")?.dataset.module ?? "runtime";
      w.__steps.push([id, r.target.dataset.watch]);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-watch"] });
  let last = 0;
  const tick = t => {
    if (last) w.__gaps.push([t, t - last]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const view = id => `[data-module-slot="dashboard-widget"] [data-module="${id}"] iframe[data-module-frame="view"]`;

test("a module that hogs the thread is demoted, paused and stopped; the page and its neighbour carry on", async () => {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-watchdog-")), "modules");
  for (const id of Object.keys(MANIFESTS)) install(modulesDir, id);
  const app = await start({ seed, env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" } });
  const warnings = [];
  const errors = [];
  app.page.on("console", m => (m.type() === "warning" ? warnings : m.type() === "error" ? errors : []).push(m.text()));
  try {
    await app.context.addInitScript(watch);
    await app.page.goto(app.base + "/");
    const { page } = app;
    // On screen: a card off screen is paused, and its lateness not judged.
    await page.locator('[data-module-slot="dashboard-widget"] [data-module="hog"]').scrollIntoViewIfNeeded();
    await page.locator(`${view("framed")}[data-state="live"]`).waitFor();
    await page.locator(`${view("hog")}[data-state="live"]`).waitFor();
    // The host told it to draw less, then a still picture (it ignores both).
    await page.frameLocator(view("hog")).getByTestId("hog-budget").filter({ hasText: "budget still" }).waitFor({ timeout: 15_000 });
    // Then it goes, for the session.
    await page.locator(view("hog")).waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(view("hog")).count(), 0, "stopped modules stay stopped");

    const { steps, perf } = await page.evaluate(() => {
      const from = window.__frameAt;
      return {
        steps: window.__steps,
        perf: {
          longTasks: window.__longTasks.filter(t => t.start + t.duration >= from),
          worstGap: Math.max(0, ...window.__gaps.filter(([t]) => t >= from).map(([, g]) => g)),
        },
      };
    });
    const ladder = id => steps.filter(([m, s]) => m === id && s !== "normal").map(([, s]) => s);
    console.info(`[watchdog] hog: ${ladder("hog").join(" → ")}; worst page frame gap ${perf.worstGap.toFixed(1)} ms`);
    assert.deepEqual(ladder("hog").slice(0, 4), ["warn", "reduce", "still", "paused"]);
    assert.ok(warnings.some(w => w === "[module hog] stopped: it slowed the page"), warnings.join("\n"));

    // Its neighbour shares its process: stalled for a while, never blamed.
    assert.deepEqual(ladder("framed"), [], "the well-behaved module was never demoted");
    assert.equal(await page.locator(`${view("framed")}[data-state="live"]`).count(), 1);
    await page.frameLocator(view("framed")).getByTestId("framed-hello").filter({ hasText: "framed hello" }).waitFor();

    // The page itself stayed within its budget the whole time.
    assert.deepEqual(perf.longTasks.filter(t => t.duration > 50), [], "no long task of the page");
    assert.ok(perf.worstGap < 100, `worst page frame gap ${perf.worstGap} ms`);
    assert.deepEqual(errors, [], "no console errors");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
