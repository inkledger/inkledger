// Accessibility on the key routes (axe-core, WCAG 2 A/AA rules): no serious or
// critical violation. A gate, not a full audit: keyboard and screen-reader
// checks by hand stay part of a release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { start } from "./harness.mjs";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const ROUTES = ["/", "/issues", "/issues/DEMO-101", "/timesheet", "/board", "/reports", "/settings", "/notes", "/notes/new", "/notes/trash", "/todos", "/pinboard"];

test("key routes have no serious or critical accessibility violation", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    const found = [];
    for (const route of ROUTES) {
      await page.goto(base + route);
      await page.waitForLoadState("load");
      await page.waitForTimeout(1500);
      // Run in the page as the test (the app's CSP rightly refuses inline scripts).
      await page.evaluate(AXE);
      const result = await page.evaluate(async () =>
        (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.map(v => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 3).map(n => n.target.join(" ")),
        })),
      );
      for (const v of result.filter(v => v.impact === "serious" || v.impact === "critical")) found.push({ route, ...v });
    }
    if (process.env.A11Y_REPORT) console.log(JSON.stringify(found, null, 2));
    assert.deepEqual(found, [], `violations:\n${found.map(f => `${f.route} ${f.impact} ${f.id}: ${f.help} — ${f.nodes.join(" | ")}`).join("\n")}`);
  } finally {
    await app.stop();
  }
});
