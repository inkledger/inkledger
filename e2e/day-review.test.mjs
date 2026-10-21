// Close the day: a running timer keeps counting while the sheet is open; the
// confirmation snapshots its live length, and that snapshot stands for the
// whole save, the sheet's summary included (not the length it had when the
// sheet opened).
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

test("while the day is being logged, the summary shows what is being logged", async () => {
  const now = Date.now();
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - 30 * 60_000, now, now,
      );
      // No "you were away" question while the test waits.
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Close the day" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Close the day" });
    await sheet.waitFor();
    // The timer runs on while the sheet is open: 20 more minutes on the server, read by the next poll.
    await app.db.q("UPDATE timers SET started_at = started_at - ? WHERE issue_key = 'DEMO-101'", 20 * 60_000);
    await page.waitForTimeout(16_000);
    await sheet.getByRole("button", { name: /^Log 1 to / }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    const logged = (await confirm.locator("li .tabular").first().innerText()).trim();
    // The save held on its way to the server.
    let release = () => {};
    const held = new Promise(r => (release = r));
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("worklogs.create"), async route => {
      await held;
      return route.continue();
    });
    await confirm.getByRole("button", { name: "Log", exact: true }).click();
    await page.waitForTimeout(400);
    const summary = await sheet.locator("footer, [class*=border-t]").last().innerText().catch(() => sheet.innerText());
    assert.ok(summary.includes(`${logged} in 1 entry`), `the summary shows ${logged}: ${summary}`);
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await app.stop();
  }
});
