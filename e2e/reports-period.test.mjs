// Reports open on this month, the same range the "This month" preset picks:
// the picker says so, and choosing it changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

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
    await page.getByRole("option", { name: "This month" }).click();
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
