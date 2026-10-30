// A timer started by mistake goes without logging: from the dialog a stop opens
// (it used to offer only Log or Later) and while it still runs (it had to be
// paused or stopped first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const running = async db => {
  const now = Date.now();
  await db.q(
    "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
    now - 20 * 60_000, now, now,
  );
  await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
};

async function gone(db) {
  for (let i = 0; i < 50; i++) {
    if ((await db.q("SELECT count(*)::int AS n FROM timers"))[0].n === 0) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

test("the log dialog of a stopped timer discards it, after asking, and logs nothing", async () => {
  const app = await start({ seed: running });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Stop and log time on DEMO-101" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Log time on DEMO-101" });
    await dialog.getByRole("button", { name: "Discard timer", exact: true }).click();
    const ask = page.getByRole("alertdialog", { name: "Discard the timer on DEMO-101?" });
    await ask.getByRole("button", { name: "Discard" }).click();
    assert.ok(await gone(db), "the timer is gone");
    await dialog.waitFor({ state: "detached" });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM worklogs"))[0].n, 0, "nothing logged");
  } finally {
    await app.stop();
  }
});

test("a running timer is discarded from the timer controls without stopping it first", async () => {
  const app = await start({ seed: running });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Discard timer DEMO-101" }).first().click();
    const ask = page.getByRole("alertdialog", { name: "Discard the timer on DEMO-101?" });
    // Cancel keeps it running.
    await ask.getByRole("button", { name: "Cancel" }).click();
    assert.equal((await db.q("SELECT state FROM timers"))[0].state, "running");
    await page.getByRole("button", { name: "Discard timer DEMO-101" }).first().click();
    await ask.getByRole("button", { name: "Discard" }).click();
    assert.ok(await gone(db), "the timer is gone");
    await page.getByText("Timer discarded").waitFor();
  } finally {
    await app.stop();
  }
});

test("on a phone the timers sheet discards a running timer too", async () => {
  const app = await start({ seed: running, viewport: { width: 360, height: 760 } });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/issues");
    await page.getByRole("button", { name: /^Timer running on DEMO-101/ }).first().click();
    const sheet = page.getByRole("dialog", { name: "Timers" });
    await sheet.getByRole("button", { name: "Discard timer DEMO-101" }).click();
    await page.getByRole("alertdialog", { name: "Discard the timer on DEMO-101?" }).getByRole("button", { name: "Discard" }).click();
    assert.ok(await gone(db), "the timer is gone");
  } finally {
    await app.stop();
  }
});
