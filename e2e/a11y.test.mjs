// Accessibility on the key routes (axe-core, WCAG 2 A/AA rules): no serious or
// critical violation. A gate, not a full audit: keyboard and screen-reader
// checks by hand stay part of a release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, start } from "./harness.mjs";

const ROUTES = ["/", "/issues", "/issues/desk", "/issues/DEMO-101", "/timesheet", "/board", "/reports", "/settings", "/notes", "/notes/new", "/notes/trash", "/todos", "/pinboard"];

test("key routes have no serious or critical accessibility violation", async () => {
  // A desk with two issues and one parked: its panes, dividers and tray are checked too.
  const pane = key => ({ connectionId: 1, key, remoteId: key });
  const desk = { v: 1, preset: "cols-2", tracks: {}, panes: [pane("DEMO-101"), pane("DEMO-102")], parked: [pane("DEMO-103")], maximized: null, compare: false, onlyDifferences: false, noteId: null };
  const app = await start({ seed: db => db.q("INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)", JSON.stringify(desk)) });
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

// Windows contrast themes (forced colors): box-shadows are dropped, so the focus ring must be a real
// outline; every route stays free of serious violations, and a focused control shows an outline.
test("forced colors: no serious violation, and the focus is still drawn", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await page.emulateMedia({ forcedColors: "active" });
    const found = [];
    for (const route of ["/", "/issues", "/issues/DEMO-101", "/timesheet", "/settings"]) {
      await page.goto(base + route);
      await page.waitForLoadState("load");
      await page.waitForTimeout(1200);
      await page.evaluate(AXE);
      const result = await page.evaluate(async () =>
        // Contrast is the system's here: forced colors replace text and background alike with the user's
        // palette, while axe reads the author's colours. Every other rule still applies.
        (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false } } })).violations
          .filter(v => v.impact === "serious" || v.impact === "critical")
          .map(v => `${v.id}: ${v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(" | ")}`),
      );
      found.push(...result.map(r => `${route} ${r}`));
      // Tab to a control past the skip link: its outline is drawn (not "none", not zero wide).
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      });
      assert.ok(outline.style !== "none" && outline.width >= 1, `${route}: the focus is drawn in forced colors (${JSON.stringify(outline)})`);
    }
    assert.deepEqual(found, [], found.join("\n"));
  } finally {
    await app.stop();
  }
});
