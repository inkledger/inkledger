import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";
import { seedDense } from "./fixtures/dense.mjs";
import { LOOKS, lookName, sweepLook } from "./visual-sweep.mjs";

// Every page and the main dialogs with dense data (many people, 100+ h, long names and titles, Italian),
// in every look (light/dark × standard/soft/high), both densities and four widths: no text over text or
// over a cell, no text spilling out of its box without an ellipsis, no page scrolling sideways, and one
// height for a row of controls. A Team time total ran over the last day's cells and only dense data
// showed it. One server per look (the rate limit off: hundreds of pages in a few minutes).
for (const look of LOOKS) {
  test(`visual sweep: ${lookName(look)}`, { timeout: 1_800_000 }, async () => {
    const app = await start({ seed: seedDense, viewport: { width: 1440, height: 900 }, env: { RATE_LIMIT: "off" } });
    try {
      const found = await sweepLook(app, look);
      const lines = [...new Set(found.map(f => `${f.page} ${f.density} ${f.width}: ${f.kind} ${f.sel} "${f.text}" ${f.detail}`))];
      assert.deepEqual(lines, [], lines.join("\n"));
    } finally {
      await app.stop();
    }
  });
}
