// Accessibility on the key routes (axe-core, WCAG 2 A/AA rules): no serious or
// critical violation. A gate, not a full audit: keyboard and screen-reader
// checks by hand stay part of a release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, start } from "./harness.mjs";

const ROUTES = ["/", "/issues", "/issues/desk", "/issues/DEMO-101", "/timesheet", "/board", "/reports", "/settings", "/notes", "/notes/new", "/notes/trash", "/todos", "/pinboard", "/notifications", "/notifications?sel=1:DEMO-101&open=1:DEMO-101", "/info", "/feedback", "/feedback/1"];

test("key routes have no serious or critical accessibility violation", async () => {
  // A desk with two issues and one parked: its panes, dividers and tray are checked too.
  const pane = key => ({ connectionId: 1, key, remoteId: key });
  const desk = { v: 1, preset: "cols-2", tracks: {}, panes: [pane("DEMO-101"), pane("DEMO-102")], parked: [pane("DEMO-103")], maximized: null, compare: false, onlyDifferences: false, noteId: null };
  // Notifications too: a group of three (opened, selected in the preview) and single ones.
  const notes = [["commented", "DEMO-101"], ["status", "DEMO-101"], ["mentioned", "DEMO-101"], ["assigned", "DEMO-102"], ["due", "DEMO-103"]];
  const app = await start({
    seed: async db => {
      await db.q("INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)", JSON.stringify(desk));
      for (const [i, [kind, key]] of notes.entries())
        await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (1, 1, ?, ?, '', ?, ?)", kind, key, `a11y-${i}`, Date.now() - i * 60_000);
      // A feedback with a thread (the Feedback page, its list and its detail).
      await db.q("INSERT INTO feedback (id, user_id, type, title, body, page, status, created_at, updated_at) VALUES (1, 1, 'problem', 'The board jumps', 'It jumps when I drag.', '/board', 'discussion', 1, 1)");
      await db.q("INSERT INTO feedback_comments (feedback_id, author_id, origin, body, status_from, status_to, created_at) VALUES (1, 1, 'status', '', 'new', 'discussion', 1)");
    },
  });
  try {
    const { page, base } = app;
    // A page is checked once it has its data: requests still on their way (a loaded machine) would have it
    // checked while still loading.
    let pending = 0;
    const api = r => new URL(r.url()).pathname.startsWith("/api/trpc/");
    page.on("request", r => api(r) && pending++);
    page.on("requestfinished", r => api(r) && pending--);
    page.on("requestfailed", r => api(r) && pending--);
    const settled = async () => {
      for (let quiet = 0, i = 0; quiet < 3 && i < 300; i++) {
        quiet = pending <= 0 ? quiet + 1 : 0;
        await page.waitForTimeout(100);
      }
    };
    const found = [];
    for (const route of ROUTES) {
      await page.goto(base + route);
      await page.waitForLoadState("load");
      await page.waitForTimeout(1500);
      await settled();
      // Contrast is measured at rest: a page's entry animation (its opacity) still running on a loaded machine
      // would be read as faded text.
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))));
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

// While its data is still on its way (a slow server), the pinboard is already a valid page: its board area
// is a named region (a label on a plain element is not allowed).
test("the pinboard while it loads has no serious accessibility violation", async () => {
  const app = await start();
  try {
    const { page, base } = app;
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/"), async route => {
      await new Promise(r => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    });
    await page.goto(base + "/pinboard");
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);
    await page.evaluate(AXE);
    const found = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        .filter(v => v.id !== "color-contrast")
        .map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(" | ")}`),
    );
    assert.deepEqual(found, []);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await app.stop();
  }
});
