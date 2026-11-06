// Switches in a row used to drift: each switched timer's time was rounded to the
// minute on its own, its block pushed after the one before and ending past the
// stop, until one no longer fitted ("No free space of this length before the
// stop"). Now the moments are rounded, not the lengths: the block of a switch
// begins where the one before ends and ends on the switch's minute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, withApp } from "./harness.mjs";

const MINUTE = 60_000;
// Time kept here (a GitHub connection): logged with no tracker to write to, as a read-only test server must.
const [A, B] = ["acme/web#1", "acme/web#2"];
const onMinute = ms => Math.round(ms / MINUTE) * MINUTE;

test("a switch logs its time from where the previous block ends to the switch's minute, nothing over the next timer", { timeout: 300_000 }, async () => {
  await awayFromMidnight(10 * MINUTE);
  // A runs since 4 min 51 s ago, started where the block logged before it ended.
  const startedAt = Date.now() - 291_000;
  const before = onMinute(startedAt);
  const seed = async db => {
    const now = Date.now();
    await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    const [{ id: github }] = await db.q(
      "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
      now,
    );
    for (const [n, key] of [A, B].entries()) {
      await db.q(
        `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
         VALUES (1, ?, ?, ?, ?, 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', ?, ?)`,
        github, `I_${n + 1}`, key, `Task ${n + 1}`, `https://github.com/acme/web/issues/${n + 1}`, now,
      );
    }
    await db.q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, 'acme/web#9', 'local-before', ?, 1800, '', 1)",
      github, before - 30 * MINUTE,
    );
    await db.q(
      "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, ?, 'running', ?, 0, NULL, '', ?, ?)",
      github, A, startedAt, startedAt, startedAt,
    );
  };
  await withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(`${base}/issues`);
    await page.getByRole("button", { name: `Start timer ${B}` }).first().click();
    await page.getByRole("alertdialog", { name: /^Running: acme\/web#1/ }).getByRole("button", { name: "Switch" }).click();
    const log = page.getByRole("dialog", { name: `Log time on ${A}` });
    await log.waitFor();
    const [asked] = await db.q("SELECT payload FROM decisions WHERE kind = 'timer-log'");
    const { end, seconds } = JSON.parse(asked.payload);
    const stop = new Date(end).getTime();
    assert.equal(stop % MINUTE, 0, "the switch asks up to a whole minute");
    assert.equal(stop - seconds * 1000, before, "its time begins where the block before ends");
    // Placed there with no question: no "pick a start", no overlap warning.
    await log.getByRole("button", { name: "Log", exact: true }).click();
    await log.waitFor({ state: "detached" });
    const [row] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = ?", A);
    assert.equal(Number(row.started), before, "the block starts where the one before ends");
    assert.equal(Number(row.started) + row.time_spent_seconds * 1000, stop, "and ends on the switch's minute");
    // The timer started there begins on that minute too: nothing of the two overlaps.
    const [next] = await db.q("SELECT started_at FROM timers WHERE issue_key = ?", B);
    assert.equal(onMinute(Number(next.started_at)), stop);
  });
});
