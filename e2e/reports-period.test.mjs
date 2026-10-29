// Reports open on this month, the same range the "This month" preset picks:
// the picker says so, and choosing it changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, trpcProcs } from "./harness.mjs";

test("Reports open on \"This month\", the preset's own range", async () => {
  const app = await start();
  try {
    const { page, base } = app;
    // Mid-month (on a month's last day both ranges would agree anyway).
    const now = new Date(2026, 9, 15, 10);
    await page.clock.install({ time: now });
    await page.goto(base + "/reports");
    const picker = page.locator("main").getByRole("button", { name: /^This month/ });
    await picker.waitFor();
    await picker.click();
    await page.getByRole("button", { name: "This month", exact: true }).click();
    await page.waitForTimeout(300);
    const url = new URL(page.url());
    const pad = n => String(n).padStart(2, "0");
    const first = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const end = `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
    // Either still the default (no params) or the preset's range, never anything else.
    assert.ok(!url.searchParams.has("from") || url.searchParams.get("from") === first, url.search);
    assert.ok(!url.searchParams.has("to") || url.searchParams.get("to") === end, url.search);
    assert.ok(await page.locator("main").getByRole("button", { name: /^This month/ }).isVisible());
  } finally {
    await app.stop();
  }
});

test("Export by days waits for the days and stays off when they couldn't be read (never a click that does nothing)", async () => {
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const app = await start({
    seed: db => db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-rep', ?, 3600, '', 1)", today.getTime()),
  });
  try {
    const { page, base } = app;
    let down = true;
    await page.route(u => new URL(u).pathname.includes("reports.daily"), async route => {
      if (!down) return route.continue();
      const procs = trpcProcs(route.request().url());
      const json = await (await route.fetch()).json();
      const out = procs.map((p, i) => (p === "reports.daily" ? { error: { json: { message: "down", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: p } } } } : json[i]));
      return route.fulfill({ status: 207, contentType: "application/json", body: JSON.stringify(out) });
    });
    await page.goto(base + "/reports?group=days");
    const exportButton = page.locator("main").getByRole("button", { name: "Export CSV" });
    await exportButton.waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await exportButton.isDisabled(), true, "off: the days couldn't be read");
    down = false;
    await page.reload();
    await exportButton.and(page.locator(":enabled")).waitFor({ timeout: 10_000 });
  } finally {
    await app.stop();
  }
});

test("Reports at 320 px in Italian: every grouping option stays on screen, reachable", async () => {
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const app = await start({
    viewport: { width: 320, height: 720 },
    seed: db => db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-320', ?, 3600, '', 1)", today.getTime()),
  });
  try {
    const { page, base, context } = app;
    await context.addInitScript(() => localStorage.setItem("ikl-locale", "it"));
    const answered = page.waitForResponse(r => r.url().includes("reports.generate"));
    await page.goto(base + "/reports");
    await answered;
    const group = page.getByRole("radiogroup", { name: "Raggruppa per" });
    await group.waitFor();
    await page.waitForTimeout(500);
    const radios = group.getByRole("radio");
    const boxes = await radios.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: e.textContent }; }));
    assert.ok(boxes.length >= 5, `five groupings: ${boxes.length}`);
    for (const b of boxes) assert.ok(b.l >= 0 && b.r <= 320, `"${b.t}" on screen: ${b.l}–${b.r}`);
    // Keyboard: Home and End reach the ends.
    await radios.first().focus();
    await page.keyboard.press("End");
    await radios.last().and(page.locator('[aria-checked="true"]')).waitFor({ timeout: 5000 });
    await page.keyboard.press("Home");
    await radios.first().and(page.locator('[aria-checked="true"]')).waitFor({ timeout: 5000 });
  } finally {
    await app.stop();
  }
});

test("Reports on a phone sort too, and the count says what it counts", async () => {
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  const app = await start({
    viewport: { width: 390, height: 844 },
    seed: async db => {
      await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-m1', ?, 1800, '', 1)", today.getTime());
      await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-102', 'w-m2', ?, 7200, '', 1)", today.getTime() + 3_600_000);
    },
  });
  try {
    const { page, base } = app;
    await page.goto(base + "/reports?group=issue");
    const sortBy = page.getByRole("combobox", { name: "Sort by" });
    await sortBy.waitFor();
    await sortBy.selectOption({ label: "Hours, most first" });
    const items = page.locator("main ul li");
    await items.first().waitFor();
    assert.match(await items.first().innerText(), /DEMO-102/, "most hours first");
    assert.match(await items.first().innerText(), /1 entry/, "the count says entries");
  } finally {
    await app.stop();
  }
});
