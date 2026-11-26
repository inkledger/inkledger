import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";
import { seedDense } from "./fixtures/dense.mjs";
import { storeFixture } from "./fixtures/store.mjs";
import { DENSITIES, LOOKS, WIDTHS, lookName, sweepLook } from "./visual-sweep.mjs";

// Every page and the main dialogs with dense data (many people, 100+ h, long names and titles, Italian),
// in every look (light/dark × standard/soft/high), both densities and four widths: no text over text or
// over a cell, no text spilling out of its box without an ellipsis, no page scrolling sideways, and one
// height for a row of controls. A Team time total ran over the last day's cells and only dense data
// showed it. One server per look (the rate limit off: hundreds of pages in a few minutes).
//
// On CI (CI=true) a reduced matrix keeps the pull request's job in its time (the full one is about 33
// minutes there): the two looks furthest apart, light standard and dark high contrast, one density each
// and the widest and the phone's width, with the same checks. SWEEP=full runs everything (the weekly
// sweep workflow, the studio script, a local run without CI).
const full = process.env.SWEEP === "full" || !process.env.CI;
const MATRIX = full
  ? LOOKS.map(look => ({ look, densities: DENSITIES, widths: WIDTHS }))
  : [
      { look: LOOKS.find(([v, c, s]) => v === "standard" && c === "normal" && s === "light"), densities: ["compact"], widths: [1440, 390] },
      { look: LOOKS.find(([v, c, s]) => v === "standard" && c === "high" && s === "dark"), densities: ["comfortable"], widths: [1440, 390] },
    ];

for (const { look, densities, widths } of MATRIX) {
  test(`visual sweep: ${lookName(look)}${full ? "" : ` (${densities.join(", ")}; ${widths.join(", ")})`}`, { timeout: 1_800_000 }, async () => {
    // The Store on (a stub catalog, two modules installed): its cards are swept too, both layouts.
    const store = await storeFixture();
    const app = await start({ seed: async db => (await seedDense(db), await store.seed(db)), viewport: { width: 1440, height: 900 }, env: { RATE_LIMIT: "off", ...store.env } });
    try {
      const found = await sweepLook(app, look, { densities, widths });
      const lines = [...new Set(found.map(f => `${f.page} ${f.density} ${f.width}: ${f.kind} ${f.sel} "${f.text}" ${f.detail}`))];
      assert.deepEqual(lines, [], lines.join("\n"));
    } finally {
      await app.stop();
      store.close();
    }
  });
}
