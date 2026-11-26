import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

// The bell leads to the notifications page, which groups a burst on one issue into one row (its newest
// leads, the rest open in place, done in one call) and filters by category.
test("notifications: a group per issue, opened and done at once; one category at a time", { timeout: 180_000 }, () =>
  withApp({
    seed: async db => {
      const now = Date.now();
      for (const [kind, key, i] of [["commented", "DEMO-101", 1], ["commented", "DEMO-101", 2], ["mentioned", "DEMO-101", 3], ["assigned", "DEMO-102", 4]])
        await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (1, 1, ?, ?, '', ?, ?)", kind, key, `stack-${i}`, now - i * 60_000);
    },
  }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await page.getByRole("button", { name: /^Notifications/ }).first().click();
    await page.waitForURL(/\/notifications$/);
    const main = page.getByRole("main");
    // DEMO-101's three are one group: what happened in all, the rest a click away.
    await main.getByText("2 comments · 1 mention").waitFor();
    const more = main.getByRole("button", { name: "Show all 3 on DEMO-101" });
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    await more.click();
    await main.getByRole("button", { name: "Fewer on DEMO-101" }).waitFor();
    assert.equal(await main.getByRole("button", { name: "Done: this one on DEMO-101" }).count(), 3);
    // A category alone, kept in the URL.
    await main.getByRole("radio", { name: "Assignments 1" }).click();
    await main.getByText("2 comments · 1 mention").waitFor({ state: "detached" });
    assert.match(page.url(), /cat=assignments/);
    await main.getByRole("radio", { name: "All 4" }).click();
    // Done in one call.
    await main.getByRole("button", { name: "Done: all 3 on DEMO-101" }).click();
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM notifications WHERE dismissed_at IS NULL"))[0].n !== 1; i++) await page.waitForTimeout(100);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM notifications WHERE dismissed_at IS NULL"))[0].n, 1, "only DEMO-102's left");
  }));
