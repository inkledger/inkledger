import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

// The ideas as a list: per state a bounded grid as wide as the page (two rows, then Show all in place),
// the finished states folded until opened.
test("ideas, list view: a bounded grid per state, Show all in place, finished ones folded", { timeout: 180_000 }, () =>
  withApp({
    viewport: { width: 1280, height: 900 },
    seed: async db => {
      const now = Date.now();
      for (let n = 0; n < 14; n++) await db.q("INSERT INTO ideas (user_id, title, state, position, created_at, updated_at) VALUES (1, ?, 'raw', ?, ?, ?)", `Idea ${n + 1}`, n, now, now);
      await db.q("INSERT INTO ideas (user_id, title, state, position, created_at, updated_at) VALUES (1, 'Old one', 'discarded', 0, ?, ?)", now, now);
    },
  }, async ({ page, base }) => {
    await page.goto(base + "/ideas");
    await page.getByRole("radio", { name: "List" }).click();
    const raw = page.getByRole("region", { name: "Raw" });
    await raw.waitFor();
    const visible = async () => raw.getByRole("group").evaluateAll(cards => cards.filter(c => c.offsetParent !== null).length);
    const first = await visible();
    assert.ok(first > 0 && first < 14, `two rows only (${first} of 14)`);
    await raw.getByRole("button", { name: "Show all (14)" }).click();
    assert.equal(await visible(), 14, "all of them in place");
    // A finished state starts folded, opened by its button.
    assert.equal(await page.getByRole("region", { name: "Discarded" }).count(), 0, "folded");
    await page.getByRole("button", { name: /^Show Discarded/ }).click();
    await page.getByRole("region", { name: "Discarded" }).getByText("Old one").waitFor();
  }));
