import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

// WCAG 2.4.11 Focus Not Obscured, page by page: Tab through the first controls and check that each one,
// once the browser has scrolled it into view, is not entirely covered by a bar that stays put (the
// sticky header and toolbar on a laptop, the phone's top bar, tab bar and dock). The scroll padding
// (src/index.css, usePublishChromeHeight) is what keeps them clear.
const ROUTES = ["/", "/issues", "/issues/DEMO-101", "/timesheet", "/reports", "/team", "/settings"];
const STEPS = 70;

async function sweep(page) {
  const covered = [];
  for (let step = 0; step < STEPS; step += 1) {
    await page.keyboard.press("Tab");
    // The page brings a covered control out a frame after the focus lands (useFocusClearOfBars).
    await page.waitForTimeout(80);
    const result = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      // Inside a dialog or a popover the page's bars are not in play.
      if (element.closest("[role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]")) return null;
      // The skip link is shown on focus over everything, by design.
      if (element.getAttribute("href") === "#main") return null;
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + 3, rect.top + 3],
        [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3],
        [rect.right - 3, rect.bottom - 3],
      ];
      const seen = points.some(([x, y]) => {
        if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) return false;
        const at = document.elementFromPoint(x, y);
        return at !== null && (at === element || element.contains(at) || at.contains(element));
      });
      if (seen) return null;
      const label = (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 40);
      const at = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)), Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)));
      return `${label} (under ${at ? at.tagName.toLowerCase() + "." + String(at.className).split(" ").slice(0, 3).join(".") : "off screen"})`;
    });
    if (result) covered.push(result);
  }
  return covered;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`focus is never hidden under the bars at ${viewport.width}px`, { timeout: 300_000 }, async () => {
    const app = await start({ viewport });
    const problems = [];
    try {
      await app.page.emulateMedia({ reducedMotion: "reduce" });
      for (const route of ROUTES) {
        await app.page.goto(app.base + route);
        await app.page.locator("[data-surface-stage]").waitFor();
        await app.page.waitForTimeout(800);
        for (const item of await sweep(app.page)) problems.push(`${route}: ${item}`);
      }
    } finally {
      await app.stop();
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });
}

// The padding that keeps focus clear of the bars must not move the page when the focus is in a bar:
// focusing the Issues filter's own search once scrolled the list by 994 px to "uncover" it.
test("focusing a control inside a sticky bar never scrolls the page", { timeout: 180_000 }, async () => {
  const app = await start({
    viewport: { width: 1440, height: 800 },
    seed: async db => {
      const now = Date.now();
      for (let i = 200; i < 260; i++)
        await db.q("INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite) VALUES (1, ?, ?, ?, 'To do', 'To Do', 'DEMO', 'Project', 'Task', 'Medium', '[]', 'mrossi', ?, ?, 0)", `DEMO-${i}`, `DEMO-${i}`, `Work item ${i}`, `https://jira.example.it/browse/DEMO-${i}`, now);
    },
  });
  try {
    const { page, base } = app;
    await page.goto(base + "/issues");
    await page.getByRole("link", { name: /DEMO-2\d\d/ }).first().waitFor();
    const main = page.locator("#main");
    await main.evaluate(el => (el.scrollTop = 1200));
    await page.waitForTimeout(200);
    const before = await main.evaluate(el => el.scrollTop);
    await page.getByRole("searchbox", { name: "Filter the local catalogue" }).focus();
    await page.waitForTimeout(300);
    assert.equal(await main.evaluate(el => el.scrollTop), before, "the list stays where it was");
  } finally {
    await app.stop();
  }
});
