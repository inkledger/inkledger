// Settings → Appearance: the soft variant and high contrast (src/lib/theme). Each look is
// clean for axe on the Dashboard (high contrast against the enhanced, AAA contrast rule too),
// the choice survives a reload, and "System" contrast follows prefers-contrast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AXE, start } from "./harness.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axeSerious(page, { enhanced = false } = {}) {
  await page.evaluate(AXE);
  return page.evaluate(
    async ([tags, enhanced]) =>
      (await axe.run(document, { runOnly: { type: "tag", values: enhanced ? [...tags, "wcag2aaa"] : tags } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        // AAA is asked only of contrast: the other wcag2aaa rules are out of this test's scope.
        .filter(v => !enhanced || !v.tags.includes("wcag2aaa") || v.id === "color-contrast-enhanced")
        .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
    [TAGS, enhanced],
  );
}

const look = page => page.evaluate(() => ({ variant: document.documentElement.dataset.variant, contrast: document.documentElement.dataset.contrast }));

async function dashboard(page, base, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(base + "/");
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
}

test("style and contrast switch from Settings, persist, and stay accessible in every look", async () => {
  const app = await start({ viewport: { width: 1440, height: 900 } });
  try {
    const { page, base, db } = app;
    // The page shows a choice at once (optimistic); a reload is only fair once the server has it.
    const saved = async (variant, contrast) => {
      for (let i = 0; i < 100; i++) {
        const [row] = await db.q("SELECT theme_variant, theme_contrast FROM settings WHERE user_id = 1");
        if (row?.theme_variant === variant && row?.theme_contrast === contrast) return;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.fail(`the server never saved ${variant}/${contrast}`);
    };
    await page.goto(base + "/settings/appearance");
    const style = page.getByRole("radiogroup", { name: /^(Style|Stile)$/ });
    const contrast = page.getByRole("radiogroup", { name: /^(Contrast|Contrasto)$/ });
    await style.getByRole("radio", { name: /Soft|Morbido/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.variant === "soft");
    // Keyboard: one Tab stop, arrows choose.
    await contrast.getByRole("radio", { checked: true }).focus();
    await page.keyboard.press("Home");
    await contrast.getByRole("radio", { name: /Normal|Normale/, checked: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-checked")), "true", "the focus follows the choice");

    const found = [];
    const shots = process.env.THEME_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    for (const [variant, level] of [["soft", "normal"], ["standard", "high"], ["soft", "high"], ["standard", "normal"]]) {
      await page.goto(base + "/settings/appearance");
      await style.getByRole("radio", { name: variant === "soft" ? /Soft|Morbido/ : /^Standard$/ }).click();
      await contrast.getByRole("radio", { name: level === "high" ? /High|Alto/ : /Normal|Normale/ }).click();
      await page.waitForFunction(([v, c]) => document.documentElement.dataset.variant === v && document.documentElement.dataset.contrast === c, [variant, level]);
      await saved(variant, level);
      for (const scheme of ["light", "dark"]) {
        await dashboard(page, base, scheme);
        assert.deepEqual(await look(page), { variant, contrast: level }, "the look survives a reload");
        found.push(...(await axeSerious(page, { enhanced: level === "high" })).map(v => `${variant}/${level}/${scheme} ${v}`));
        if (shots && !(variant === "soft" && level === "high")) {
          await page.mouse.move(0, 0);
          await page.screenshot({ path: join(shots, `dashboard-${scheme}-${level === "high" ? "high" : variant}.png`) });
        }
      }
    }
    assert.deepEqual(found, [], found.join("\n"));
  } finally {
    await app.stop();
  }
});

test("System contrast follows prefers-contrast; an explicit choice wins over it", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await page.emulateMedia({ contrast: "more" });
    await dashboard(page, base, "light");
    assert.equal((await look(page)).contrast, "high", "more contrast asked: high contrast at once");
    // Thicker focus: a 3 px outline in the ring colour.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => parseFloat(getComputedStyle(document.activeElement).outlineWidth));
    assert.ok(outline >= 3, `focus outline ${outline}px`);
    await page.emulateMedia({ contrast: "no-preference" });
    await page.waitForFunction(() => document.documentElement.dataset.contrast === "normal");
    await page.emulateMedia({ contrast: "more" });
    await page.goto(base + "/settings/appearance");
    await page.getByRole("radiogroup", { name: /^(Contrast|Contrasto)$/ }).getByRole("radio", { name: /Normal|Normale/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.contrast === "normal");
    await page.reload();
    await page.waitForLoadState("load");
    assert.equal((await look(page)).contrast, "normal", "the explicit choice holds against the system's");
  } finally {
    await app.stop();
  }
});

test("a slow answer to an earlier choice never takes back a later one (the focus stays on the chosen tile)", async () => {
  const app = await start({ viewport: { width: 1440, height: 900 } });
  try {
    const { page, base } = app;
    await page.goto(base + "/settings/appearance");
    const style = page.getByRole("radiogroup", { name: /^(Style|Stile)$/ });
    const contrast = page.getByRole("radiogroup", { name: /^(Contrast|Contrasto)$/ });
    await contrast.getByRole("radio", { checked: true }).waitFor();
    // The first save (the style) is done on the server (the contrast still "system") but its answer
    // arrives after the contrast was chosen: CI's race, made certain.
    let release = () => {};
    const held = new Promise(r => (release = r));
    let first = true;
    let answered = () => {};
    const firstAnswered = new Promise(r => (answered = r));
    let sent = () => {};
    const firstSent = new Promise(r => (sent = r));
    await page.route(u => new URL(u).pathname.includes("settings.update"), async route => {
      if (!first) return route.continue();
      first = false;
      sent();
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
      answered();
    });
    await style.getByRole("radio", { name: /Soft|Morbido/ }).click();
    await firstSent;
    await contrast.getByRole("radio", { checked: true }).focus();
    await page.keyboard.press("Home");
    await contrast.getByRole("radio", { name: /Normal|Normale/, checked: true }).waitFor();
    await page.waitForTimeout(500);
    // The contrast's own save waits too (its answer is the newest), so the stale one lands alone first.
    release();
    await firstAnswered;
    await page.waitForTimeout(300);
    assert.equal(await contrast.getByRole("radio", { name: /Normal|Normale/ }).getAttribute("aria-checked"), "true", "the later choice holds");
    assert.equal(await style.getByRole("radio", { name: /Soft|Morbido/ }).getAttribute("aria-checked"), "true", "the earlier one too");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-checked")), "true", "the focus is on the chosen tile");
  } finally {
    await app.stop();
  }
});
