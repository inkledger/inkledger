// Time on a GitHub issue: GitHub keeps none, so the entry stays in inkledger
// (it used to be sent to Jira's API and fail).
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

async function withApp(opts, body) {
  const app = await start(opts);
  try {
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
}

let github = 0;
const githubIssue = async db => {
  const now = Date.now();
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, 'I_1', 'acme/web#1', 'Login fails on Safari', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
    github, now,
  );
};

test("time logged on a GitHub issue stays in inkledger, said as such", () =>
  withApp({ seed: githubIssue }, async ({ page, base, db }) => {
    await page.goto(`${base}/issues/${github}/I_1`);
    await page.getByRole("heading", { name: /Login fails on Safari/ }).first().waitFor();
    // Only what GitHub can do: no watching, no attachments, no worklog sync.
    await page.getByRole("heading", { name: "Worklogs" }).waitFor();
    // (shown while the connections load, gone once GitHub's capabilities are known)
    await page.getByRole("button", { name: "Watch" }).waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "Attachments" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Sync", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Log time" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("GitHub keeps no time").waitFor();
    await dialog.getByLabel("Time spent").fill("30m");
    // A start of its own: the one placed from the clock has no room just after midnight.
    const y = new Date(Date.now() - 86_400_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    await dialog.getByLabel("Start", { exact: true }).fill(`${day}T10:00`);
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const rows = await db.q("SELECT connection_id, time_spent_seconds, jira_worklog_id FROM worklogs");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].connection_id, github);
    assert.equal(rows[0].time_spent_seconds, 1800);
    assert.match(rows[0].jira_worklog_id, /^local-/);
  }));
