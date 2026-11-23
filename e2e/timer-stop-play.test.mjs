// Stop then Play used to leave a gap: a resumed timer was counted from the
// Play (its block slid forward by the pause), and a timer started after a
// stop logged on whole minutes began on a later minute than the stop's block
// ended. A Play under a minute after the time before it ended now starts
// right there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, startTimer, withApp } from "./harness.mjs";

const MINUTE = 60_000;
// Time kept here (a GitHub connection): logged with no tracker to write to, as a read-only test server must.
const KEY = "acme/web#1";
/** When the seeded timer began (20 minutes before the test, set once it may run). */
let started = 0;

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
    github, KEY, started, started, started,
  );
};

/** Early in a minute: the stop's block ends on that minute, before the Play (rounded down). */
async function earlyInMinute() {
  const s = new Date().getSeconds();
  if (s > 10) await new Promise(r => setTimeout(r, (62 - s) * 1000));
}

async function stopOnTimeline(page, base) {
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: `Pause timer ${KEY}` }).first().waitFor();
  await earlyInMinute();
  await page.getByRole("button", { name: `Stop and log time on ${KEY}` }).first().click();
  const dialog = page.getByRole("dialog", { name: `Log time on ${KEY}` });
  await dialog.waitFor();
  return dialog;
}

/** A pause long enough to show a slide (seconds), well under the minute that is asked about. */
const pause = () => new Promise(r => setTimeout(r, 2_000));

test("stop, Later, Play again: the block keeps its start", { timeout: 300_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 25 * MINUTE);
  started = Date.now() - 20 * MINUTE;
  await withApp({ seed }, async ({ page, base, db }) => {
    const dialog = await stopOnTimeline(page, base);
    await dialog.getByRole("button", { name: "Later" }).click();
    await dialog.waitFor({ state: "detached" });
    await pause();
    await page.goto(`${base}/issues`);
    await startTimer(page, KEY);
    const [t] = await db.q("SELECT state, started_at, accumulated_seconds FROM timers WHERE issue_key = ?", KEY);
    assert.equal(t.state, "running");
    // Its count is whole seconds: where it begins is within one of the seeded start.
    const slid = Number(t.started_at) - t.accumulated_seconds * 1000 - started;
    assert.ok(slid >= 0 && slid < 1000, `counted from where it began, not slid to the Play (${slid} ms)`);
  });
});

test("stop, Log, Play again: the new block starts where the logged one ends", { timeout: 300_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 25 * MINUTE);
  started = Date.now() - 20 * MINUTE;
  await withApp({ seed }, async ({ page, base, db }) => {
    const dialog = await stopOnTimeline(page, base);
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const [w] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = ?", KEY);
    await pause();
    await page.goto(`${base}/issues`);
    await startTimer(page, KEY);
    const [t] = await db.q("SELECT started_at FROM timers WHERE issue_key = ?", KEY);
    assert.equal(Number(t.started_at), Number(w.started) + w.time_spent_seconds * 1000, "no gap between the two blocks");
  });
});
