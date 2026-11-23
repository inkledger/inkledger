// A framed module switched on from its Store card hears it ("page.events"
// "enabled") with where the card is, also when that switch made its frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const ID = "popout";

function install(modulesDir) {
  const code = readFileSync(new URL(`./fixtures/modules/${ID}/index.js`, import.meta.url));
  const manifest = { id: ID, product: `inkledger.${ID}`, entry: "index.js", name: { en: "Popout", it: "Popout" }, files: { "index.js": sha256hex(code) }, version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities: ["page.overlay", "page.events"], slots: ["dashboard-overlay"] };
  mkdirSync(join(modulesDir, ID), { recursive: true });
  writeFileSync(join(modulesDir, ID, "index.js"), code);
  writeFileSync(join(modulesDir, ID, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, ID, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = signEnvelope(Buffer.from(JSON.stringify({ id: "L-pop", email_hash: "h", product: `inkledger.${ID}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

test("switched on from its Store card, a module hears where the card is, once its new frames listen", async () => {
  // An empty catalog: the installed module shows as a local card with its switch.
  const store = createServer((req, res) => {
    res.writeHead(req.url === "/catalog" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/catalog" ? { v: 1, items: [] } : { error: "nope" }));
  });
  await new Promise(r => store.listen(0, "127.0.0.1", r));
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-enabled-")), "modules");
  install(modulesDir);
  const app = await start({
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now());
      // Off for this user: the switch below turns it on (and makes its frames).
      await db.q("INSERT INTO module_storage (user_id, module_id, key, value, updated_at) VALUES (1, ?, '__off', 'true', ?)", ID, Date.now());
    },
    env: { STORE_URL: `http://127.0.0.1:${store.address().port}`, MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  try {
    const { page } = app;
    await page.goto(app.base + "/settings/store");
    const card = page.locator(`[data-store-item="${ID}"]`);
    await card.waitFor();
    assert.equal(await page.locator("[data-page-overlay] iframe").count(), 0, "off: no frame yet");
    await card.getByRole("switch").click();
    const heard = page.frameLocator("[data-page-overlay] iframe[data-module-frame=view]").getByTestId("popout-heard");
    await heard.filter({ hasText: /^enabled / }).waitFor({ timeout: 20_000 });
    const from = JSON.parse((await heard.textContent()).replace(/^enabled /, ""));
    const box = await card.boundingBox();
    // The overlay's box is the window: the card's rect as the page shows it.
    assert.ok(from && Math.abs(from.x - box.x) <= 2 && Math.abs(from.y - box.y) <= 2 && Math.abs(from.w - box.width) <= 2, JSON.stringify({ from, box }));
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    store.close();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
