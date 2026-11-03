import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { start, APP } from "./harness.mjs";

// Every control FlowMap counts declares its minimum target (the catalog's accessibility contract,
// minTouchTargetPx). On a touch screen its real hit area, the pseudo-element that widens a small icon
// included, must be at least that big: probed with elementFromPoint around the control's centre, since
// a box measure ignores the widening ::after. Under a coarse pointer the design system asks 44 px
// (docs/design-system.md §7.1): enforced where the catalog says 44, reported elsewhere.
const CATALOG = JSON.parse(readFileSync(`${APP}api/parity/workspace-catalog.json`, "utf8")).catalog;
const MIN = Object.fromEntries(CATALOG.controls.map(control => [control.id, control.accessibility?.minTouchTargetPx ?? 24]));
const ROUTES = ["/", "/issues", "/issues/DEMO-101", "/timesheet", "/reports", "/board", "/team", "/notes", "/settings"];

async function probe(page, min) {
  return page.evaluate(({ min }) => {
    const seen = new Set();
    const out = [];
    for (const element of document.querySelectorAll("[data-workspace-control]")) {
      const id = element.getAttribute("data-workspace-control");
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || getComputedStyle(element).visibility === "hidden") continue;
      // Only what is on screen and uncovered at its centre (a control behind a sheet is not tappable now).
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const atCentre = document.elementFromPoint(cx, cy);
      if (!atCentre || !(element === atCentre || element.contains(atCentre))) continue;
      const key = `${id}@${Math.round(cx)},${Math.round(cy)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The largest square around the centre that still lands on the control, in 2 px steps.
      const hits = r => [[cx - r, cy], [cx + r, cy], [cx, cy - r], [cx, cy + r]].every(([x, y]) => {
        const at = document.elementFromPoint(x, y);
        return at && (at === element || element.contains(at));
      });
      let reach = 0;
      for (let r = 1; r <= 30 && hits(r); r += 1) reach = r;
      out.push({ id, size: reach * 2 + 1, need: min[id] ?? 24, label: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 30) });
    }
    return out;
  }, { min });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`touch targets at ${viewport.width}px, as the catalog declares them`, { timeout: 300_000 }, async () => {
    const app = await start({ viewport });
    const context = await app.context.browser().newContext({ viewport, isMobile: true, hasTouch: true, baseURL: app.base, storageState: await app.page.context().storageState() });
    const page = await context.newPage();
    try {
      await page.goto(app.base + "/");
      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "a coarse pointer");
      const below = [];
      const under44 = [];
      for (const route of ROUTES) {
        await page.goto(app.base + route);
        await page.locator("[data-surface-stage]").waitFor();
        await page.waitForTimeout(1000);
        for (const item of await probe(page, MIN)) {
          // The probe steps 1 px from the centre on both sides: a 44 px target reads 43.
          if (item.size + 2 < item.need) below.push(`${route} ${item.id} "${item.label}": ${item.size} px < ${item.need}`);
          else if (item.size + 2 < 44) under44.push(`${route} ${item.id} "${item.label}": ${item.size} px`);
        }
      }
      if (under44.length > 0) console.log(`under 44 px on touch (report only), ${viewport.width}px:\n  ` + [...new Set(under44)].join("\n  "));
      assert.deepEqual([...new Set(below)], [], "every control reaches the catalog's minimum");
    } finally {
      await context.close();
      await app.stop();
    }
  });
}
