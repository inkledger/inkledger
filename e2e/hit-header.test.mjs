// A module drawn over the whole window ("page.overlay") is drawn over the page's
// sticky header: standing on the header's bottom edge, its shape is clicked and
// carried there, and the header's own buttons next to it, or under it, keep their
// clicks. The same with reduced motion (the page's fade-in leaves no layer behind).
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
const ID = "hop";

function install(modulesDir) {
  const code = readFileSync(new URL(`./fixtures/modules/${ID}/index.js`, import.meta.url));
  const manifest = { id: ID, product: `inkledger.${ID}`, entry: "index.js", name: { en: "Hop", it: "Hop" }, files: { "index.js": sha256hex(code) }, version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities: ["page.overlay", "drag"], slots: ["dashboard-overlay"] };
  mkdirSync(join(modulesDir, ID), { recursive: true });
  writeFileSync(join(modulesDir, ID, "index.js"), code);
  writeFileSync(join(modulesDir, ID, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, ID, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = signEnvelope(Buffer.from(JSON.stringify({ id: `L-${ID}`, email_hash: "h", product: `inkledger.${ID}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

for (const motion of ["no-preference", "reduce"])
  test(`over the sticky header (motion: ${motion}): the shape on its bottom edge is clicked and carried, the header's buttons keep theirs`, { timeout: 300_000 }, async () => {
    const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-hop-")), "modules");
    install(modulesDir);
    const app = await start({
      viewport: { width: 1440, height: 900 },
      seed: db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now()),
      env: { STORE_URL: "off", MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
    });
    try {
      const { page } = app;
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto(app.base + "/");
      const header = page.locator("[data-above-modules].region");
      const title = header.locator("h1");
      await title.waitFor();
      const frameEl = page.locator("[data-page-overlay] iframe[data-module-frame=view]");
      await frameEl.waitFor({ state: "attached", timeout: 20_000 });
      const frame = await (await frameEl.elementHandle()).contentFrame();
      await frame.waitForFunction(() => typeof window.place === "function", null, { timeout: 20_000 });
      await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
      const h = await header.boundingBox();
      const t = await title.boundingBox();
      // Standing on the header's bottom edge, right of the title (as a bunny by the title): 40×44, feet on the line.
      const shape = { x: Math.round(t.x + t.width + 80), y: Math.round(h.y + h.height - 44), w: 40, h: 44 };
      await frame.evaluate(s => window.place(s.x, s.y, s.w, s.h), shape);
      const box = page.locator("[data-page-overlay] [data-module=hop]");
      await page.waitForFunction(el => el.hasAttribute("data-hit"), await box.elementHandle());
      const cx = shape.x + shape.w / 2;
      const cy = shape.y + shape.h / 2;
      // Drawn over the header there: the box (made hit-testable for a moment) is the topmost element.
      const painted = await page.evaluate(([x, y]) => {
        const b = document.querySelector("[data-page-overlay] [data-module=hop]");
        b.style.setProperty("pointer-events", "auto", "important");
        const top = document.elementFromPoint(x, y);
        b.style.removeProperty("pointer-events");
        return top === b;
      }, [cx, cy]);
      assert.equal(painted, true, "the module is drawn over the header");
      // A click on the shape is the module's.
      await page.mouse.click(cx, cy);
      await frame.waitForFunction(() => window.heard.includes("pointer"), null, { timeout: 5_000 });
      // Carried from there.
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 30, cy + 60, { steps: 6 });
      await page.mouse.up();
      await frame.waitForFunction(() => window.heard.includes("drag:start") && window.heard.includes("drag:end"), null, { timeout: 5_000 });
      // The header's buttons beside it still click: the Week view.
      const week = header.getByRole("radio", { name: "Week" });
      await week.click();
      await page.waitForFunction(el => el.getAttribute("aria-checked") === "true", await week.elementHandle());
      // The shape over a header button: the button keeps the click, the module hears nothing.
      const dayRadio = header.getByRole("radio", { name: "Day" });
      const day = await dayRadio.boundingBox();
      await frame.evaluate(s => window.place(s.x, s.y, s.w, s.h), { x: Math.round(day.x), y: Math.round(day.y), w: Math.round(day.width), h: Math.round(day.height) });
      await page.waitForTimeout(200);
      const before = await frame.evaluate(() => window.heard.length);
      await page.mouse.click(day.x + day.width / 2, day.y + day.height / 2);
      await page.waitForFunction(el => el.getAttribute("aria-checked") === "true", await dayRadio.elementHandle());
      assert.equal(await frame.evaluate(() => window.heard.length), before, "the module heard nothing on the button");
      assert.deepEqual(app.errors, [], "no page errors");
    } finally {
      await app.stop();
      rmSync(join(modulesDir, ".."), { recursive: true, force: true });
    }
  });
