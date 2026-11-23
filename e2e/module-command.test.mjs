// A framed module's keyboard command ("commands", a four-key chord) reaches
// its views as page event "command", from the keys and from the palette, and
// the chord's first press never opens the palette.
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
const ID = "chord";
const COMMAND = { id: "chord.showWays", keys: "Mod+Shift+K+B", label: { en: "Show the ways", it: "Mostra le strade" } };

function install(modulesDir) {
  const code = readFileSync(new URL(`./fixtures/modules/${ID}/index.js`, import.meta.url));
  const manifest = { id: ID, product: `inkledger.${ID}`, entry: "index.js", name: { en: "Chord", it: "Chord" }, files: { "index.js": sha256hex(code) }, version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities: ["page.overlay", "page.events"], slots: ["dashboard-overlay"], commands: [COMMAND] };
  mkdirSync(join(modulesDir, ID), { recursive: true });
  writeFileSync(join(modulesDir, ID, "index.js"), code);
  writeFileSync(join(modulesDir, ID, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, ID, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = signEnvelope(Buffer.from(JSON.stringify({ id: "L-chord", email_hash: "h", product: `inkledger.${ID}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

test("a module's chord reaches its frame as a command, from the keys and from the palette", async () => {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-command-")), "modules");
  install(modulesDir);
  const app = await start({
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now());
    },
    env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  try {
    const { page } = app;
    await page.goto(app.base + "/");
    const heard = page.frameLocator("[data-page-overlay] iframe[data-module-frame=view]").getByTestId("chord-heard");
    await heard.waitFor({ state: "attached", timeout: 20_000 });
    const palette = page.locator('[data-slot="command-input-wrapper"]');
    // Its listener comes a moment after the frame: pressed again until heard (none is held for a late one).
    const chord = async () => {
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.keyboard.down("ControlOrMeta");
      await page.keyboard.down("Shift");
      await page.keyboard.down("KeyK");
      assert.equal(await palette.count(), 0, "the chord's first press opens no palette");
      await page.keyboard.press("KeyB");
      await page.keyboard.up("KeyK");
      await page.keyboard.up("Shift");
      await page.keyboard.up("ControlOrMeta");
    };
    for (let i = 0; i < 20 && !/^command /.test((await heard.textContent()) ?? ""); i++) {
      await chord();
      await page.waitForTimeout(500);
    }
    await heard.filter({ hasText: /^command chord\.showWays \d+$/ }).waitFor({ timeout: 5_000 });
    assert.equal(await palette.count(), 0, "no palette after the chord");
    const n = Number((await heard.textContent()).split(" ").pop());

    // In the shortcuts help, under Modules.
    await page.keyboard.press("?");
    await page.getByRole("dialog").getByText("Chord: Show the ways").waitFor();
    await page.keyboard.press("Escape");

    // The palette's action sends the same.
    await page.keyboard.press("ControlOrMeta+k");
    await palette.waitFor();
    await page.keyboard.type("Show the ways");
    await page.getByRole("option", { name: /Chord: Show the ways/ }).click();
    await heard.filter({ hasText: `command chord.showWays ${n + 1}` }).waitFor({ timeout: 5_000 });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
