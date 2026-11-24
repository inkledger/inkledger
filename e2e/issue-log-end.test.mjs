// On an issue's own page the day's entries are not loaded yet when a log dialog
// opens: choosing "End time" while the start was still being placed pinned an
// empty start, and the end could never be chosen. Stop+log and Log time on the
// issue page behave as on the Dashboard: the start is placed, the end follows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdRoute, nearMidnight, trpcProcs, withApp } from "./harness.mjs";

const MINUTE = 60_000;
// Time kept here (a GitHub connection): logged with no tracker to write to, as a read-only test server must.
const KEY = "acme/web#1";
const pad = n => String(n).padStart(2, "0");
const localInput = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A GitHub issue, a worklog of 20 min that ended an hour ago and, with `timer`, its timer running for 40 min. */
const seedWith = ({ timer }) => async db => {
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
    "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, ?, 'earlier', ?, 1200, '', ?)",
    github, KEY, now - 80 * MINUTE, now,
  );
  if (timer)
    await db.q(
      "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, ?, 'running', ?, 0, NULL, '', ?, ?)",
      github, KEY, now - 40 * MINUTE, now, now,
    );
};

/** The issue's page, loaded; then the day's entries (a list by day, not the issue's own) held until `release`. */
async function issuePageHeld(page, base) {
  await page.goto(`${base}/issues/${encodeURIComponent(KEY)}`);
  await page.getByRole("heading", { name: "Task 1" }).first().waitFor();
  return holdRoute(
    page,
    url => /\/api\/trpc\//.test(url.href) && trpcProcs(url).includes("worklogs.list") && (url.searchParams.get("input") ?? "").includes('"from"'),
  );
}

/** End time chosen before the start is placed: once placed, the start is there and the end after it. */
async function endTimeWhilePlacing(page, dialog, release) {
  await dialog.getByRole("radiogroup", { name: "Time as" }).getByRole("radio", { name: "End time" }).click();
  release();
  const startField = dialog.getByLabel("Start", { exact: true });
  const endField = dialog.getByLabel("End", { exact: true });
  await page.waitForFunction(el => el.value !== "", await startField.elementHandle(), { timeout: 15_000 });
  const start = new Date(await startField.inputValue()).getTime();
  assert.ok(Number.isFinite(start), "the start is placed after all");
  assert.notEqual(await endField.inputValue(), "", "the end follows the placed block");
  return { start, endField };
}

test("issue page, Stop+log by end time: the end can be chosen, no overlap with the day", { skip: nearMidnight(5 * MINUTE, 90 * MINUTE), timeout: 600_000 }, async () => {
  await withApp({ seed: seedWith({ timer: true }) }, async ({ page, base, db }) => {
    const { release } = await issuePageHeld(page, base);
    await page.getByRole("button", { name: `Stop and log time on ${KEY}` }).first().click();
    const dialog = page.getByRole("dialog", { name: `Log time on ${KEY}` });
    await dialog.waitFor();
    const { start, endField } = await endTimeWhilePlacing(page, dialog, release);
    await endField.fill(localInput(start + 30 * MINUTE));
    await dialog.getByText("= 30m").waitFor();
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const rows = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = ? ORDER BY started", KEY);
    assert.equal(rows.length, 2);
    const [earlier, logged] = rows;
    assert.equal(logged.time_spent_seconds, 30 * 60);
    assert.ok(Number(logged.started) >= Number(earlier.started) + earlier.time_spent_seconds * 1000, "after the earlier entry, not over it");
    assert.deepEqual(await db.q("SELECT issue_key FROM timers"), [], "the timer is logged");
  });
});

test("issue page, Log time by end time: the end can be chosen", { skip: nearMidnight(5 * MINUTE, 90 * MINUTE), timeout: 600_000 }, async () => {
  await withApp({ seed: seedWith({ timer: false }) }, async ({ page, base, db }) => {
    const { release } = await issuePageHeld(page, base);
    await page.getByRole("button", { name: "Log time", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: `Log time · ${KEY}` });
    await dialog.waitFor();
    // Short: room before now even early in the working hours, which a typed block never starts before.
    await dialog.getByLabel("Time spent", { exact: true }).fill("5m");
    const { start, endField } = await endTimeWhilePlacing(page, dialog, release);
    assert.equal(new Date(await endField.inputValue()).getTime(), start + 5 * MINUTE, "the end keeps the duration typed before");
    await endField.fill(localInput(start + 4 * MINUTE));
    await dialog.getByText("= 4m").waitFor();
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const [row] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = ? AND jira_worklog_id <> 'earlier'", KEY);
    assert.equal(Number(row.started), start);
    assert.equal(row.time_spent_seconds, 4 * 60);
  });
});
