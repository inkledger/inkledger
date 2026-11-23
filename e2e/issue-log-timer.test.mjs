// "Log time" on an issue whose own timer runs opened a blank form: its time could be
// logged twice, or over the timer's. It opens the timer's question (as Stop+log); from
// there "Log another interval" logs something else by hand, ending before the timer's time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, withApp } from "./harness.mjs";

const MINUTE = 60_000;
// Time kept here (a GitHub connection): logged with no tracker to write to, as a read-only test server must.
const KEY = "acme/web#1";

/** A GitHub issue and its timer, running for 40 min. */
const seed = async db => {
  const now = Date.now();
  await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
  const [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, 'I_1', ?, 'Task 1', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
    github, KEY, now,
  );
  await db.q(
    "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, ?, 'running', ?, 0, NULL, '', ?, ?)",
    github, KEY, now - 40 * MINUTE, now, now,
  );
};

/** The timer's question, opened by "Log time": the timer is stopped, nothing logged yet. */
async function question(page, db) {
  const dialog = page.getByRole("dialog", { name: `Log time on ${KEY}` });
  await dialog.waitFor();
  assert.deepEqual(await db.q("SELECT state FROM timers"), [{ state: "paused" }], "stopped, waiting to be logged");
  assert.deepEqual(await db.q("SELECT id FROM worklogs"), []);
  return dialog;
}

test("issue page, Log time with the issue's timer running: the timer's question, another interval before it", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 90 * MINUTE);
  await withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(`${base}/issues/${encodeURIComponent(KEY)}`);
    await page.getByRole("heading", { name: "Task 1" }).first().waitFor();
    await page.getByRole("button", { name: "Log time", exact: true }).first().click();
    const asked = await question(page, db);
    const [timer] = await db.q("SELECT paused_at, accumulated_seconds FROM timers");
    const timerStart = Math.round((Number(timer.paused_at) - timer.accumulated_seconds * 1000) / MINUTE) * MINUTE;

    await asked.getByRole("button", { name: "Log another interval" }).click();
    const other = page.getByRole("dialog", { name: `Log time · ${KEY}` });
    await other.waitFor();
    await other.getByText("Ends before the timer's time", { exact: false }).waitFor();
    await other.getByLabel("Time spent", { exact: true }).fill("10m");
    await other.getByText("= 10m").waitFor();
    await other.getByRole("button", { name: "Log", exact: true }).click();
    await other.waitFor({ state: "detached" });
    const [manual] = await db.q("SELECT started, time_spent_seconds FROM worklogs");
    assert.equal(manual.time_spent_seconds, 10 * 60);
    assert.ok(Number(manual.started) + 10 * MINUTE <= timerStart, "ends before the timer's time, not over it");
    assert.deepEqual(await db.q("SELECT state FROM timers"), [{ state: "paused" }], "the timer still waits");

    // The question is back: the timer's own time, logged once.
    await asked.waitFor();
    await asked.getByRole("button", { name: "Log", exact: true }).click();
    await asked.waitFor({ state: "detached" });
    const rows = await db.q("SELECT started, time_spent_seconds FROM worklogs ORDER BY started");
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[1].started), timerStart, "the timer's block where it ran");
    assert.deepEqual(await db.q("SELECT issue_key FROM timers"), [], "the timer is logged");
  });
});

test("issues list, Log time with the issue's timer running: the timer's question", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 90 * MINUTE);
  await withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(`${base}/issues`);
    await page.getByRole("button", { name: `Log time on ${KEY}`, exact: true }).first().click();
    const asked = await question(page, db);
    await asked.getByRole("button", { name: "Later" }).click();
    await asked.waitFor({ state: "detached" });
    // Stopped already: asked again, never a blank form beside it.
    await page.getByRole("button", { name: `Log time on ${KEY}`, exact: true }).first().click();
    await question(page, db);
    assert.equal(await page.getByRole("dialog", { name: `Log time · ${KEY}` }).count(), 0);
  });
});
