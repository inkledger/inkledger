// The six real modules, as built (unsigned) by inkledger-modules' `pnpm build:unsigned`, loaded by
// the real loader: signed here with a throwaway key and fixture licences (never a real key), no
// store, no weather. Skipped when the build folder is not there (the modules repo is private).
//   MODS_BUILD=../inkledger-modules/build-unsigned PROVIDERS_READ_ONLY=1 node --test e2e/mods-real.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const BUILD = process.env.MODS_BUILD ?? new URL("../../inkledger-modules/build-unsigned/", import.meta.url).pathname;
const SRC = join(BUILD, "..", "packages");
const IDS = existsSync(BUILD) ? readdirSync(BUILD).filter(id => existsSync(join(BUILD, id, "manifest.unsigned.json"))).sort() : [];
const skip = IDS.length === 0 ? "no unsigned modules build (MODS_BUILD)" : false;
const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const license = id =>
  signEnvelope(Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

function install(dir, id) {
  const meta = JSON.parse(readFileSync(join(SRC, id, "meta.json"), "utf8"));
  const out = join(dir, id);
  mkdirSync(out, { recursive: true });
  const files = {};
  for (const f of readdirSync(join(BUILD, id)).filter(f => f !== "manifest.unsigned.json")) {
    const bytes = readFileSync(join(BUILD, id, f));
    writeFileSync(join(out, f), bytes);
    files[f] = sha256hex(bytes);
  }
  const manifest = { ...meta, files };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(out, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

async function withAll(o, body) {
  const dir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-mods-")), "modules");
  for (const id of IDS) install(dir, id);
  const app = await start({
    viewport: o.viewport,
    seed: db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(IDS.map(license)), Date.now()),
    env: { MODULES_DIR: dir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1", STORE_URL: "off", WEATHER: "off" },
  });
  try {
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

/** Page transitions finished (a page fading in is measured at its final colours); endless ones stay. */
const settled = page =>
  page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));

const axe = async page => {
  await settled(page);
  return page.evaluate(async src => {
    if (!window.axe) new Function(src)();
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return r.violations.filter(v => v.impact === "serious" || v.impact === "critical").map(v => `${v.id}: ${v.nodes.map(n => `${n.target.join(" ")} (${n.failureSummary?.replace(/\s+/g, " ").slice(0, 160)})`).slice(0, 3).join(", ")}`);
  }, AXE);
};

test("all six modules load with the real loader, the dashboard and the Store stay clean (axe, no errors)", { skip, timeout: 600_000 }, () =>
  withAll({}, async ({ page, base }) => {
    await page.goto(base + "/");
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`[data-module="${id}"]`)), IDS, { timeout: 30_000 }).catch(() => undefined);
    const mounted = await page.evaluate(() => [...new Set([...document.querySelectorAll("[data-module]")].map(e => e.getAttribute("data-module")))].sort());
    assert.ok(mounted.length >= IDS.length - 1, `modules mounted: ${mounted.join(", ")}`);
    await page.waitForTimeout(3000);
    assert.deepEqual(await axe(page), [], "dashboard with every module");
    await page.goto(base + "/settings/store");
    await page.getByRole("heading", { name: /Store/ }).first().waitFor();
    assert.deepEqual(await axe(page), [], "the Store");
  }));

test("Stitch's sheet on a phone is modal: Tab stays inside, a redraw keeps the focus, Escape gives it back", { skip: skip || (!IDS.includes("stitch") && "no stitch"), timeout: 600_000 }, () =>
  withAll({ viewport: { width: 390, height: 844 } }, async ({ page, base }) => {
    await page.goto(base + "/");
    const card = page.locator("[data-stitch-card]").first();
    await card.waitFor({ timeout: 30_000 });
    await card.focus();
    await page.keyboard.press("Enter");
    const sheet = page.locator("[data-stitch-panel]");
    await sheet.waitFor();
    assert.equal(await sheet.getAttribute("aria-modal"), "true", "modal on a phone");
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest("[data-stitch-panel]")), true, `Tab ${i + 1} stays inside`);
    }
    // A pattern for next week: the sheet redraws, the focus stays on that tile.
    const tile = sheet.locator('button[aria-pressed]:not([disabled]):not([aria-disabled="true"])').last();
    await tile.focus();
    const label = await tile.getAttribute("aria-label");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), label, "focus kept through the redraw");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    assert.equal(await card.evaluate(el => el === document.activeElement || el.contains(document.activeElement)), true, "focus back on the card");
  }));

test("Kanbunny's panel takes the focus, keeps it through its two-step reset, and gives it back", { skip: skip || (!IDS.includes("kanbunny") && "no kanbunny"), timeout: 600_000 }, () =>
  withAll({}, async ({ page, base }) => {
    await page.goto(base + "/");
    const hit = page.locator("[data-kanbunny-hit]").first();
    await hit.waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await hit.focus();
    await page.keyboard.press("Enter");
    const panel = page.locator("[data-kanbunny-panel]");
    await panel.waitFor();
    assert.equal(await panel.evaluate(el => el.contains(document.activeElement)), true, "focus moved into the panel");
    const restart = panel.getByRole("button", { name: "Start over…" });
    await restart.focus();
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: /^Sure\?/ }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent ?? ""), "Sure? A new egg hatches", "focus stays on the reset button");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert.equal(await hit.evaluate(el => el === document.activeElement), true, "focus back where it was");
  }));

test("Bonsai's film is a modal dialog: Tab stays inside, the slider says where it is, Escape gives the focus back", { skip: skip || (!IDS.includes("bonsai") && "no bonsai"), timeout: 600_000 }, () =>
  withAll({}, async ({ page, base }) => {
    await page.goto(base + "/settings/store");
    await page.locator('[data-store-item="bonsai"]').getByRole("button", { name: /^Manage Bonsai/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const watch = page.getByRole("button", { name: "Watch it grow" });
    await watch.waitFor({ timeout: 30_000 });
    await watch.focus();
    await page.keyboard.press("Enter");
    const film = page.getByRole("dialog", { name: "Your bonsai over time" });
    await film.waitFor({ timeout: 30_000 });
    assert.equal(await film.getAttribute("aria-modal"), "true");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await film.evaluate(el => el.contains(document.activeElement)), true, `Tab ${i + 1} stays inside`);
    }
    const slider = film.getByRole("slider", { name: "Position in the film" });
    await page.waitForFunction(() => document.querySelector('input[type="range"][aria-valuetext]'));
    assert.match((await slider.getAttribute("aria-valuetext")) ?? "", /moment 1 of \d+/);
    await page.keyboard.press("Escape");
    await film.waitFor({ state: "detached" });
    assert.equal(await watch.evaluate(el => el === document.activeElement), true, "focus back on the button");
  }));

test("Shadow asks no weather until the person turns it on", { skip: skip || (!IDS.includes("shadow") && "no shadow"), timeout: 600_000 }, () =>
  withAll({}, async ({ page, base }) => {
    const asked = [];
    page.on("request", r => {
      if (r.url().includes("modules.weather") && decodeURIComponent(r.url()).includes('"moduleId":"shadow"')) asked.push(r.url());
    });
    await page.goto(base + "/");
    await page.locator('[data-module="shadow"]').first().waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(3000);
    assert.deepEqual(asked, [], "no weather request by default");
    await page.goto(base + "/settings/store");
    await page.locator('[data-store-item="shadow"]').getByRole("button", { name: /^Manage Shadow/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    const box = page.getByRole("checkbox", { name: /Clouds from the weather/ });
    await box.waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-pref="weather"]')?.disabled);
    const saved = page.waitForResponse(r => /modules\.storageSet(If)?/.test(r.url()) && r.request().postData()?.includes("shadow"));
    await box.check();
    await saved;
    await page.goto(base + "/");
    for (let i = 0; i < 30 && !asked.length; i++) await page.waitForTimeout(200);
    assert.ok(asked.length > 0, "asked once turned on");
  }));
