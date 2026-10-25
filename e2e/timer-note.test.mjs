// A timer's note is saved while typing: the last words typed are the ones kept,
// even when an earlier save is slow and lands after a later one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

test("a slow earlier save never overwrites the note typed after it", async () => {
  const now = Date.now();
  const app = await start({
    seed: db =>
      db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - 600_000, now, now,
      ),
  });
  try {
    const { page, base, db } = app;
    // The first save waits until a later one has been answered, then goes on.
    let first = true;
    let laterDone = () => {};
    const later = new Promise(r => (laterDone = r));
    await page.route(u => new URL(u).pathname.includes("timers.setNote"), async route => {
      if (first) {
        first = false;
        await Promise.race([later, new Promise(r => setTimeout(r, 4000))]);
        return route.continue();
      }
      // Answered by the server before the first one goes on.
      const res = await route.fetch();
      await route.fulfill({ response: res });
      laterDone();
    });
    await page.goto(base + "/issues/DEMO-101");
    const box = page.getByRole("textbox", { name: "What are you working on in DEMO-101?" }).first();
    await box.fill("first draft");
    await page.waitForTimeout(900);
    await box.fill("final words");
    await box.blur();
    await page.waitForTimeout(5000);
    const [row] = await db.q("SELECT note FROM timers WHERE issue_key = 'DEMO-101'");
    assert.equal(row.note, "final words");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("a note that couldn't be saved says so and is kept, sent again on the next change", async () => {
  const now = Date.now();
  const app = await start({
    seed: db =>
      db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - 600_000, now, now,
      ),
  });
  try {
    const { page, base, db } = app;
    let down = true;
    await page.route(u => new URL(u).pathname.includes("timers.setNote"), route =>
      down ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify([{ error: { json: { message: "down", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } } } }]) }) : route.continue(),
    );
    await page.goto(base + "/issues/DEMO-101");
    const box = page.getByRole("textbox", { name: "What are you working on in DEMO-101?" }).first();
    await box.fill("kept words");
    await box.blur();
    await page.getByRole("alert").filter({ hasText: "Note not saved" }).first().waitFor();
    assert.equal(await box.inputValue(), "kept words");
    // Kept on this device too: a reload shows it, still unsaved.
    await page.reload();
    await page.getByRole("alert").filter({ hasText: "Note not saved" }).first().waitFor();
    assert.equal(await box.inputValue(), "kept words");
    down = false;
    await box.fill("kept words!");
    await box.blur();
    await page.getByRole("alert").filter({ hasText: "Note not saved" }).first().waitFor({ state: "detached" });
    const [row] = await db.q("SELECT note FROM timers WHERE issue_key = 'DEMO-101'");
    assert.equal(row.note, "kept words!");
  } finally {
    await app.stop();
  }
});
