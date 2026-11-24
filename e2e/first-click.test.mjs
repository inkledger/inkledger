// The first click on a page the server drew. One Suspense held every route, so while the first
// page's code was still on its way the whole server-drawn app had no handlers, and a click there
// was dropped (a loaded CI runner lost about half of them: tests timed out on a dialog that never
// opened). The page hydrates once its code is in, and <html data-live> says when that is done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdRoute, start } from "./harness.mjs";

test("the server's Dashboard is live only with its code in; the first click then opens what it should", async () => {
  const now = Date.now();
  const app = await start({
    seed: async db => {
      // A running timer: the Summary offers "Close the day".
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - 10 * 60_000, now, now,
      );
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base } = app;
    const { release } = await holdRoute(page, u => /^\/assets\/Dashboard-[^/]+\.js$/.test(new URL(u).pathname));
    // The harness's goto returns once the page is live: here only after the release below.
    const opened = page.goto(base + "/", { waitUntil: "commit" });
    const close = page.getByRole("button", { name: "Close the day" }).first();
    await close.waitFor();
    await page.waitForTimeout(1000);
    const live = () => page.evaluate(() => document.documentElement.hasAttribute("data-live"));
    assert.equal(await live(), false, "drawn by the server, not live while its code is held");
    release();
    await opened;
    assert.equal(await live(), true);
    // At once, no waiting for anything else: live means it answers.
    await close.click();
    await page.getByRole("dialog", { name: "Close the day" }).waitFor({ timeout: 5000 });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
