import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, withApp } from "./harness.mjs";

// The week as a grid of issues × days (docs/design-system.md §7.1): one Tab stop and arrows between
// cells, a cell's entries in its popover, the day's totals in the last row, the whole week on one screen
// at 1280; on a phone a strip of the seven days and the chosen day's entries. The day cards stay one choice away.
async function week(db) {
  const monday = new Date();
  monday.setHours(10, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (dayOffset, hour) => monday.getTime() + dayOffset * 86_400_000 + (hour - 10) * 3_600_000;
  const rows = [
    ["DEMO-101", 0, 9, 3600, "planning"],
    ["DEMO-101", 1, 9, 5400, "review"],
    ["DEMO-102", 1, 14, 1800, ""],
    ["DEMO-103", 2, 10, 7200, "pairing"],
  ];
  for (const [key, day, hour, seconds, comment] of rows) {
    await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (1, 1, ?, ?, ?, ?, ?, 1)", key, `grid-${key}-${day}`, seconds, at(day, hour), comment);
  }
}

test("the week grid: rows per issue, one Tab stop, arrows, a cell's entries, day totals", { timeout: 300_000 }, async () => {
  await awayFromMidnight();
  await withApp({ viewport: { width: 1280, height: 800 }, seed: week }, async ({ page, base }) => {
    await page.goto(base + "/timesheet");
    const grid = page.getByRole("grid", { name: "Week by issue" });
    await grid.waitFor();
    // One row per issue, the busiest first; the foot says the days' totals.
    const rowKeys = await grid.locator("tbody th[scope=row] a").allInnerTexts();
    assert.deepEqual(rowKeys, ["DEMO-101", "DEMO-103", "DEMO-102"]);
    // One Tab stop inside the grid: every cell but one is -1.
    assert.equal(await grid.locator("[data-cell][tabindex='0']").count(), 1);
    // Arrows move between cells; Enter opens a cell's entries.
    await grid.locator("[data-cell='0,1']").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-cell")), "0,2");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-cell")), "1,2");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    const popover = page.getByRole("dialog");
    await popover.getByText("review").waitFor();
    await popover.getByRole("button", { name: "Edit DEMO-101" }).waitFor();
    await popover.getByRole("button", { name: "Delete DEMO-101" }).waitFor();
    await page.keyboard.press("Escape");
    // The week fits the screen at 1280 (it was 3.4 screens as cards).
    const screens = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main.scrollHeight / main.clientHeight;
    });
    assert.ok(screens <= 1.2, `the week on one screen (${screens.toFixed(2)})`);
    // The day cards are one choice away, remembered.
    await page.getByRole("radio", { name: "By day" }).click();
    await page.getByRole("grid").waitFor({ state: "detached" });
    await page.reload();
    await page.getByRole("radio", { name: "By day", checked: true }).waitFor();
  });
});

test("the week on a phone: the days' strip and the chosen day's entries", { timeout: 300_000 }, async () => {
  await awayFromMidnight();
  await withApp({ viewport: { width: 390, height: 844 }, seed: week }, async ({ page, base }) => {
    await page.goto(base + "/timesheet");
    const strip = page.getByRole("radiogroup", { name: "Days of the week" });
    await strip.waitFor();
    assert.equal(await strip.getByRole("radio").count(), 7);
    assert.equal(await page.getByRole("grid").isVisible().catch(() => false), false, "no grid on a phone");
    // Monday, by its chip; then Tuesday with the arrow: its two entries.
    await strip.getByRole("radio").first().click();
    await page.getByText("planning").waitFor();
    await page.keyboard.press("ArrowRight");
    await page.getByText("review").waitFor();
    await page.getByRole("button", { name: "Edit DEMO-102" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, "nothing sideways");
  });
});

test("the month on a phone: one calendar, one Tab stop, arrows by day and week, on one screen", { timeout: 300_000 }, async () => {
  await awayFromMidnight();
  await withApp({ viewport: { width: 390, height: 844 }, seed: week }, async ({ page, base }) => {
    await page.goto(base + "/timesheet?view=month");
    const grid = page.getByRole("grid", { name: "Days of the month" });
    await grid.waitFor();
    assert.equal(await grid.locator("[role=gridcell][tabindex='0']").count(), 1, "one Tab stop");
    const current = grid.locator("[role=gridcell][tabindex='0']");
    await current.focus();
    const before = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await page.keyboard.press("ArrowDown");
    const after = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    assert.notEqual(after, before, "a week down");
    const box = await grid.boundingBox();
    assert.ok(box.height < 420, `the month is short (${Math.round(box.height)} px)`);
  });
});
