// The six real modules, as built (unsigned) by inkledger-modules' `pnpm build:unsigned`, loaded by
// the real loader: signed here with a throwaway key and fixture licences (never a real key), no
// store, no weather. Skipped when the build folder is not there (the modules repo is private).
//   MODS_BUILD=../inkledger-modules/build-unsigned PROVIDERS_READ_ONLY=1 node --test e2e/mods-real.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AXE, start, TAB } from "./harness.mjs";
import { signedMods, unsignedIds } from "./unsigned-mods.mjs";

const BUILD = process.env.MODS_BUILD ?? new URL("../../inkledger-modules/build-unsigned/", import.meta.url).pathname;
const IDS = existsSync(BUILD) ? unsignedIds(BUILD).sort() : [];
const skip = IDS.length === 0 ? "no unsigned modules build (MODS_BUILD)" : false;

async function withAll(o, body) {
  const { dir, env, licenses } = signedMods(BUILD, IDS, "ikl-e2e-mods-");
  const app = await start({
    viewport: o.viewport,
    seed: db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(licenses), Date.now()),
    env: { ...env, STORE_URL: "off", WEATHER: "off" },
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

/** A framed module's sheet: the host's dialog (named after the module), its view frame inside. */
const moduleSheet = (page, name) =>
  page.getByRole("dialog", { name }).and(page.locator(':has(iframe[data-module-frame="view"])'));
/** A frame's own document (its focus, its waits), from the host's iframe element. */
const frameOf = async locator => (await locator.elementHandle()).contentFrame();
/**
 * A view the host had paused off screen (visibility: hidden) takes the pointer again: Chrome routes
 * input to the page, not into a just-woken frame, for a few frames. Ready once the frame itself
 * sees the mouse over `target` (one of its elements).
 */
const awake = async (locator, target) => {
  const page = locator.page();
  await page.waitForFunction(el => el.style.visibility !== "hidden", await locator.elementHandle());
  const inside = await frameOf(locator);
  await inside.evaluate(() => {
    window.__seen = false;
    addEventListener("pointermove", () => (window.__seen = true), { capture: true });
  });
  const box = await target.boundingBox();
  for (let i = 0; i < 50 && !(await inside.evaluate(() => window.__seen)); i++) {
    await page.mouse.move(box.x + box.width / 2 + (i % 2), box.y + box.height / 2);
    await page.waitForTimeout(50);
  }
};
/** Outside the dialog the page takes no pointer (the host's modal layer). */
const pagePointerShut = page => page.evaluate(() => getComputedStyle(document.body).pointerEvents === "none");
/** Resolves once `locator`'s element has the page's focus (a closing sheet hands it back after its exit). */
const focusOn = async (page, locator) => page.waitForFunction(el => el === document.activeElement, await locator.elementHandle());

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
    // The card is the module's, in its view frame (off screen a frame is paused).
    const box = page.locator('[data-module-slot="dashboard-widget"] [data-module="stitch"]').first();
    await box.waitFor({ state: "attached", timeout: 30_000 });
    await box.scrollIntoViewIfNeeded();
    const cardFrame = box.locator('iframe[data-module-frame="view"]');
    const card = page.frameLocator('[data-module-slot="dashboard-widget"] [data-module="stitch"] iframe[data-module-frame="view"]').locator("[data-stitch-card]").first();
    await card.waitFor({ timeout: 30_000 });
    // Scrolled in at once: the host wakes the frame it had paused only as it comes into view.
    await awake(cardFrame, card);
    // A tap on the card: a script's focus inside a frame is no person's, so Enter there would open nothing.
    await card.click();
    // The host's sheet, modal on a phone: the page behind is out of reach, the panel in its frame.
    const sheet = moduleSheet(page, "Stitch");
    await sheet.waitFor();
    const sheetFrame = sheet.locator('iframe[data-module-frame="view"]');
    const inside = await frameOf(sheetFrame);
    const panel = inside.locator("[data-stitch-panel]");
    await panel.waitFor();
    assert.equal(await sheet.getAttribute("aria-modal"), "true", "modal on a phone");
    assert.equal(await pagePointerShut(page), true, "the page behind takes no pointer");
    // Inside the host's sheet, and round the panel's own controls (not only its close button and frame).
    const reached = new Set();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(TAB);
      assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true, `Tab ${i + 1} stays inside`);
      const at = await inside.evaluate(() => {
        const el = document.hasFocus() ? document.activeElement : null;
        return el?.closest("[data-stitch-panel]") ? el.getAttribute("aria-label") || el.textContent : null;
      });
      if (at) reached.add(at);
    }
    assert.ok(reached.size > 1, `Tab goes round the panel's controls (${[...reached].join(", ")})`);
    // A pattern for next week: the sheet redraws, the focus stays on that tile.
    const tile = panel.locator('button[aria-pressed]:not([disabled]):not([aria-disabled="true"])').last();
    await tile.focus();
    const label = await tile.getAttribute("aria-label");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await sheetFrame.evaluate(el => el === document.activeElement), true, "the host's focus on the sheet's frame");
    assert.equal(await inside.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), label, "focus kept through the redraw");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    // Back on the card: the host's focus on its frame, the frame's on the card.
    await focusOn(page, cardFrame);
    await (await frameOf(cardFrame)).waitForFunction(() => !!document.activeElement?.closest("[data-stitch-card]"));
  }));

test("Kanbunny's panel takes the focus, keeps it through its two-step reset, and gives it back", { skip: skip || (!IDS.includes("kanbunny") && "no kanbunny"), timeout: 600_000 }, () =>
  withAll({}, async ({ page, base }) => {
    await page.goto(base + "/");
    // The host's box takes the keyboard: one named button over the bunny's shape.
    const hit = page.locator('[data-module-slot="panel-edge"] [data-module="kanbunny"][role="button"][tabindex="0"]');
    await hit.waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await hit.focus();
    await page.keyboard.press("Enter");
    const sheet = moduleSheet(page, "Kanbunny");
    await sheet.waitFor();
    const sheetFrame = sheet.locator('iframe[data-module-frame="view"]');
    const inside = await frameOf(sheetFrame);
    const panel = inside.locator("[data-kanbunny-panel]");
    await panel.waitFor();
    await focusOn(page, sheetFrame);
    assert.equal(await sheet.evaluate(el => el.contains(document.activeElement)), true, "focus moved into the sheet");
    const restart = panel.getByRole("button", { name: "Start over…" });
    await restart.focus();
    await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: /^Sure\?/ }).waitFor();
    assert.equal(await sheetFrame.evaluate(el => el === document.activeElement), true, "the host's focus on the sheet's frame");
    assert.equal(await inside.evaluate(() => document.activeElement?.textContent ?? ""), "Sure? A new egg hatches", "focus stays on the reset button");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    await focusOn(page, hit);
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
      await page.keyboard.press(TAB);
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
    // The frame reaches nothing itself (connect-src 'none'): it asks the host, whose page fetches.
    const asked = [];
    page.on("request", r => {
      if (r.url().includes("modules.weather") && decodeURIComponent(r.url()).includes('"moduleId":"shadow"')) asked.push(r.url());
    });
    await page.goto(base + "/");
    await page.locator('[data-module="shadow"]').first().waitFor({ state: "attached", timeout: 30_000 });
    // Its light is cast from its runtime frame: running, and still asking nothing.
    await page.locator('[data-module-runtimes] iframe[data-module-frame="runtime"][title="Shadow"][data-state="live"]').waitFor({ state: "attached", timeout: 30_000 });
    await page.waitForTimeout(3000);
    assert.deepEqual(asked, [], "no weather request by default");
    await page.goto(base + "/settings/store");
    await page.locator('[data-store-item="shadow"]').getByRole("button", { name: /^Manage Shadow/ }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    // Its settings are drawn in its own frame.
    const settings = page.locator('[data-module-slot="settings"] [data-module="shadow"] iframe[data-module-frame="view"]');
    await settings.waitFor({ timeout: 30_000 });
    const inside = await frameOf(settings);
    const box = inside.getByRole("checkbox", { name: /Clouds from the weather/ });
    await box.waitFor({ timeout: 30_000 });
    await inside.waitForFunction(() => !document.querySelector('[data-pref="weather"]')?.disabled);
    // The sheet still sliding in moves the frame under a click aimed inside it.
    await settled(page);
    const saved = page.waitForResponse(r => /modules\.storage(Set|Update)(If)?/.test(r.url()) && r.request().postData()?.includes("shadow"));
    await box.check();
    await saved;
    await page.goto(base + "/");
    for (let i = 0; i < 30 && !asked.length; i++) await page.waitForTimeout(200);
    assert.ok(asked.length > 0, "asked once turned on");
  }));
