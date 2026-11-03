import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

// Comfortable density (a 16 px root instead of 14): every size is in rem, so the whole app grows by a
// seventh. Nothing may then spill sideways, nor any control leave the screen, on a phone or a laptop.
const ROUTES = ["/", "/issues", "/issues/DEMO-101", "/timesheet", "/timesheet?view=month", "/board", "/reports", "/team", "/settings", "/notes", "/todos"];

for (const width of [320, 390, 1024, 1280]) {
  test(`comfortable density: no overflow at ${width}px`, { timeout: 300_000 }, async () => {
    const app = await start({ viewport: { width, height: 900 } });
    try {
      await app.page.addInitScript(() => localStorage.setItem("ikl-density", "comfortable"));
      await app.page.emulateMedia({ reducedMotion: "reduce" });
      const problems = [];
      for (const route of ROUTES) {
        await app.page.goto(app.base + route);
        await app.page.locator("[data-surface-stage]").waitFor();
        await app.page.waitForTimeout(1000);
        const result = await app.page.evaluate(() => {
          const root = document.documentElement;
          const main = document.querySelector("main");
          for (const element of main?.querySelectorAll(".sr-only, [data-overflow-ok]") ?? []) element.style.display = "none";
          const controls = [...document.querySelectorAll("main a[href], main button, main input")].filter(element => {
            if (element.closest("[data-overflow-ok], table")) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
          }).map(element => (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 30));
          return { density: root.dataset.density, root: root.scrollWidth - root.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0, controls };
        });
        assert.equal(result.density, "comfortable");
        if (result.root > 1) problems.push(`${route}: document overflow ${result.root}px`);
        if (result.main > 1) problems.push(`${route}: main overflow ${result.main}px`);
        for (const control of result.controls) problems.push(`${route}: control outside the screen "${control}"`);
      }
      assert.deepEqual(problems, [], problems.join("\n"));
    } finally {
      await app.stop();
    }
  });
}
