// Framed modules (host API v2) end to end: a module signed with a key made
// here (MODULES_TRUST_EXTRA_KEY, tests only) runs in a sandboxed frame on the
// Dashboard, with a runtime frame beside it, and reaches nothing of the app.
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
const CODE = readFileSync(new URL("./fixtures/modules/framed/index.js", import.meta.url));
const ID = "framed";

function install(modulesDir) {
  const manifest = {
    id: ID,
    version: "2.0.0",
    product: `inkledger.${ID}`,
    entry: "index.js",
    hostApi: { min: 1, max: 2 },
    runtime: "frame",
    capabilities: ["runtime"],
    slots: ["dashboard-widget"],
    name: { en: "Framed", it: "Framed" },
    files: { "index.js": sha256hex(CODE) },
  };
  mkdirSync(join(modulesDir, ID), { recursive: true });
  writeFileSync(join(modulesDir, ID, "index.js"), CODE);
  writeFileSync(join(modulesDir, ID, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, ID, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = signEnvelope(
  Buffer.from(JSON.stringify({ id: `L-${ID}`, email_hash: "h", product: `inkledger.${ID}`, issued: 1, v: 1 })),
  "inkledger-license-v1\n",
  KEY.privateKey,
);
const seed = db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now());

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

async function withFramed(body, { before } = {}) {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-framed-")), "modules");
  install(modulesDir);
  const app = await start({ seed, env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" } });
  const consoleErrors = [];
  app.page.on("console", m => m.type() === "error" && consoleErrors.push(m.text()));
  const responses = [];
  app.context.on("response", r => /\/modules\/(run|frame)\//.test(r.url()) && responses.push(r));
  try {
    await app.context.addInitScript(watch);
    await before?.(app);
    await app.page.goto(app.base + "/");
    await body({ ...app, consoleErrors, responses });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
}

const viewFrame = async page => (await page.locator('iframe[data-module-frame="view"]').elementHandle()).contentFrame();

test("a framed module draws in its card, talks to the host and its runtime, and reaches nothing of the app", () =>
  withFramed(async ({ page, base, consoleErrors, responses }) => {
    const inside = page.frameLocator('iframe[data-module-frame="view"]');
    await inside.getByTestId("framed-hello").filter({ hasText: "framed hello" }).waitFor();
    await inside.getByTestId("framed-worker").filter({ hasText: "worker 42" }).waitFor();
    await inside.getByTestId("framed-runtime").filter({ hasText: "runtime hears dashboard-widget" }).waitFor();
    await inside.getByTestId("framed-totals").filter({ hasText: /^totals \d+$/ }).waitFor();
    await inside.getByTestId("framed-timer").filter({ hasText: "timer idle" }).waitFor();
    await page.locator('iframe[data-module-frame="view"][data-state="live"]').waitFor();
    assert.equal(await page.locator('[data-module-runtimes] iframe[data-module-frame="runtime"][data-state="live"]').count(), 1);
    // The frame fills its card, inside its border.
    const card = await page.locator('[data-module="framed"]').evaluate(el => [el.clientWidth, el.clientHeight]);
    const frameBox = await page.locator('iframe[data-module-frame="view"]').boundingBox();
    assert.deepEqual([frameBox.width, frameBox.height], card);
    assert.deepEqual(consoleErrors, [], "no console errors while mounting");

    // Smooth while it mounted: no long task of the page, no frame gap worth a dropped beat.
    await page.waitForTimeout(500);
    const perf = await page.evaluate(() => {
      const from = window.__frameAt;
      return {
        from,
        longTasks: window.__longTasks.filter(t => t.start + t.duration >= from),
        worstGap: Math.max(0, ...window.__gaps.filter(([t]) => t >= from).map(([, g]) => g)),
      };
    });
    console.info(`[framed] frame at ${Math.round(perf.from)} ms, worst frame gap after it ${perf.worstGap.toFixed(1)} ms`);
    assert.notEqual(perf.from, null);
    assert.deepEqual(perf.longTasks.filter(t => t.duration > 50), [], "no long task while the frame mounts");

    // Headers as served: code readable by an opaque origin, a policy of its own for the frame document.
    const code = responses.find(r => r.url().includes("/modules/run/") && r.url().endsWith("/index.js"));
    const doc = responses.find(r => r.url().includes("/modules/frame/"));
    assert.ok(code && doc, "both the frame document and the code were fetched");
    const codeHeaders = await code.allHeaders();
    const docHeaders = await doc.allHeaders();
    console.info(`[framed] code: corp=${codeHeaders["cross-origin-resource-policy"]} acao=${codeHeaders["access-control-allow-origin"]}; document: xfo=${docHeaders["x-frame-options"]}`);
    assert.equal(codeHeaders["access-control-allow-origin"], "*");
    assert.match(docHeaders["content-security-policy"], new RegExp(`script-src 'nonce-[^']+' ${base.replace(/[.]/g, "[.]")}/modules/run/;`));
    assert.match(new URL(code.url()).pathname, /^\/modules\/run\/[^/]+\/framed\/[0-9a-f]{32}\/index[.]js$/);

    // Inside the frame: no app, no cookie, no network, no shell.
    const frame = await viewFrame(page);
    const probes = await frame.evaluate(async () => {
      const blocked = f => {
        try {
          f();
          return false;
        } catch {
          return true;
        }
      };
      let api;
      try {
        const r = await fetch("/api/trpc/auth.me", { credentials: "include" });
        api = `answered ${r.status}`;
      } catch {
        api = "failed";
      }
      return {
        origin: self.origin,
        api,
        parentDocument: blocked(() => parent.document.title),
        cookie: blocked(() => document.cookie),
        tauri: typeof window.__TAURI__ === "undefined" && typeof window.__TAURI_INTERNALS__ === "undefined",
        popup: window.open("/") === null,
        peer: typeof RTCPeerConnection === "undefined",
      };
    });
    assert.deepEqual(probes, { origin: "null", api: "failed", parentDocument: true, cookie: true, tauri: true, popup: true, peer: true });

    // Navigating away stops the module: its frames go, and stay gone.
    await frame.evaluate(() => (location.href = "/modules/frame/elsewhere")).catch(() => {});
    await page.locator("iframe[data-module-frame]").first().waitFor({ state: "detached" });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("iframe[data-module-frame]").count(), 0);
  }));

test("other bytes at the code URL never run: the import map pins the entry to its hash", () =>
  withFramed(
    async ({ page, consoleErrors }) => {
      await page.locator('iframe[data-module-frame="view"][data-state="failed"]').waitFor();
      const frame = await viewFrame(page);
      assert.equal(await frame.evaluate(() => document.querySelector("#ikl-box")), null);
      assert.ok(!(await frame.evaluate(() => document.body.textContent)).includes("tampered"));
      assert.ok(consoleErrors.some(e => e.startsWith("[module framed] load:")), consoleErrors.join("\n"));
    },
    {
      before: ({ context }) =>
        context.route("**/modules/run/**", route =>
          route.fulfill({
            status: 200,
            headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" },
            body: "export default { id: 'framed', hostApi: 2, mount: { 'dashboard-widget'(el) { el.textContent = 'tampered'; return () => {}; } } };",
          }),
        ),
    },
  ));
