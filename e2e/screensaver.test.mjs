import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { start } from "./harness.mjs";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

test("screensaver swallows closing keys and supports scene navigation and pointer exit", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await page.goto(base + "/issues");
    // Keys only once the app is live (hydrated), as in the other keyboard tests.
    await page.getByRole("heading", { name: "Issues" }).first().waitFor();
    await page.keyboard.press("z");
    const stage = page.locator("[data-screensaver]");
    await stage.waitFor({ state: "visible" });
    assert.equal(await stage.getAttribute("data-scene"), "ink");
    await stage.locator("canvas").waitFor({ state: "visible" });

    await page.waitForTimeout(550);
    await page.keyboard.press("ArrowRight");
    await stage.waitFor({ state: "visible" });
    assert.equal(await stage.getAttribute("data-scene"), "ink");

    await page.keyboard.press("t");
    await stage.waitFor({ state: "detached" });
    // Time for QuickStart to open, had the key reached the app.
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole("dialog", { name: "Start timer" }).count(), 0);

    await page.getByRole("button", { name: /^Screensaver/ }).click();
    await stage.waitFor({ state: "visible" });
    await page.waitForTimeout(550);
    await stage.click({ position: { x: 20, y: 20 } });
    await stage.waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("screensaver opens from More and closes with a tap on mobile", async () => {
  const app = await start({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });
  try {
    const { page, base } = app;
    await page.goto(base);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: "Screensaver", exact: true }).click();
    const stage = page.locator("[data-screensaver]");
    await stage.waitFor({ state: "visible" });
    await page.waitForTimeout(550);
    await stage.tap({ position: { x: 20, y: 20 } });
    await stage.waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("screensaver has no serious accessibility violations with reduced motion", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(base + "/issues");
    await page.getByRole("heading", { name: "Issues" }).first().waitFor();
    await page.keyboard.press("z");
    await page.locator("[data-screensaver] canvas").waitFor({ state: "visible" });
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        .map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map(n => n.target.join(" ")) })),
    );
    assert.deepEqual(violations, []);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("screensaver stays open through React StrictMode on the Vite dev server", async () => {
  const app = await start({ viteDev: true });
  try {
    const { page, base } = app;
    await page.goto(base + "/issues");
    await page.getByRole("heading", { name: "Issues" }).first().waitFor();
    await page.keyboard.press("z");
    const stage = page.locator("[data-screensaver]");
    await stage.waitFor({ state: "visible" });
    await page.waitForTimeout(1500);
    await stage.waitFor({ state: "visible" });
    await page.keyboard.press("t");
    await stage.waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
