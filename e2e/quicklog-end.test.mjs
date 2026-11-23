// The Dashboard's (and Timesheet's) quick "Log time" took a duration only, while the
// issue's dialog takes an end time too: the same choice everywhere, with the same rules
// (the start is placed first, the end follows it; over logged time a warning).
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, withApp } from "./harness.mjs";

const MINUTE = 60_000;
// Time kept here (a GitHub connection): logged with no tracker to write to, as a read-only test server must.
const KEY = "acme/web#1";
const pad = n => String(n).padStart(2, "0");
const localInput = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A GitHub issue with a worklog of 20 min that ended an hour ago. */
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
    "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, ?, 'earlier', ?, 1200, '', ?)",
    github, KEY, now - 80 * MINUTE, now,
  );
};

test("Dashboard quick Log time by end time: the start is placed, the end follows, an overlap is said", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 90 * MINUTE);
  await withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(`${base}/`);
    await page.getByRole("button", { name: "Log time", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Log time" });
    await dialog.getByRole("combobox", { name: "Issue" }).click();
    await page.getByRole("option", { name: /Task 1/ }).first().click();
    await dialog.getByLabel("Duration", { exact: true }).fill("5m");
    await dialog.getByRole("radiogroup", { name: "Time as" }).getByRole("radio", { name: "End time" }).click();
    const startField = dialog.getByLabel("Start", { exact: true });
    const endField = dialog.getByLabel("End", { exact: true });
    await page.waitForFunction(el => el.value !== "", await startField.elementHandle(), { timeout: 15_000 });
    const start = new Date(await startField.inputValue()).getTime();
    assert.equal(new Date(await endField.inputValue()).getTime(), start + 5 * MINUTE, "the end keeps the duration typed before");

    // Over the earlier entry: said, as in the issue's dialog (the default policy warns).
    const [earlier] = await db.q("SELECT started FROM worklogs");
    await startField.fill(localInput(Number(earlier.started) + 5 * MINUTE));
    await endField.fill(localInput(Number(earlier.started) + 10 * MINUTE));
    await dialog.getByText("Overlaps", { exact: false }).waitFor();

    await startField.fill(localInput(start));
    await endField.fill(localInput(start + 4 * MINUTE));
    await dialog.getByText(/^From \d\d:\d\d to \d\d:\d\d$/).waitFor();
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const [row] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE jira_worklog_id <> 'earlier'");
    assert.equal(Number(row.started), start);
    assert.equal(row.time_spent_seconds, 4 * 60);
  });
});
