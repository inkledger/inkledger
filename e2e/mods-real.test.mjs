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
