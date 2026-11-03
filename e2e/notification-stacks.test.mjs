import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

// The notification center groups a burst on one issue into a stack (its newest on top, the rest in
// place on request, archived in one call) and filters by kind.
test("notifications: a stack per issue, opened and archived at once; one kind at a time", { timeout: 180_000 }, () =>
  withApp({
    seed: async db => {
      const now = Date.now();
      for (const [kind, key, i] of [["commented", "DEMO-101", 1], ["commented", "DEMO-101", 2], ["mentioned", "DEMO-101", 3], ["assigned", "DEMO-102", 4]])
        await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (1, 1, ?, ?, '', ?, ?)", kind, key, `stack-${i}`, now - i * 60_000);
    },
  }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await page.getByRole("button", { name: /^Notifications/ }).first().click();
    const center = page.getByRole("dialog", { name: "Notifications" });
    await center.waitFor();
    // DEMO-101's three are one stack: its newest shown, "2 more" opens the rest.
    const more = center.getByRole("button", { name: "2 more on DEMO-101" });
    await more.waitFor();
    assert.equal(await more.getAttribute("aria-expanded"), "false");
    await more.click();
    await center.getByRole("button", { name: "Fewer on DEMO-101" }).waitFor();
    // A kind alone.
    await center.getByRole("radio", { name: /^Assigned to you 1$/ }).click();
    await center.getByRole("button", { name: /DEMO-101/ }).first().waitFor({ state: "detached" });
    await center.getByRole("radio", { name: /^All 4$/ }).click();
    // Archived in one call.
    await center.getByRole("button", { name: "Archive all 3 on DEMO-101" }).click();
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM notifications WHERE dismissed_at IS NULL"))[0].n !== 1; i++) await page.waitForTimeout(100);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM notifications WHERE dismissed_at IS NULL"))[0].n, 1, "only DEMO-102's left");
  }));
