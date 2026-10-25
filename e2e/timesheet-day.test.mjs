// The Timesheet says which day time goes on: a day that already has entries can take
// one more (it used to offer only today's Log time), and the dialog names the day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, start } from "./harness.mjs";

let github = 0;
const yesterday = () => {
  const d = new Date(Date.now() - 86_400_000);
  d.setHours(10, 0, 0, 0);
  return d;
};
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("a day with entries takes one more, on that day; the header logs today, said as such", { timeout: 600_000 }, async () => {
  await awayFromMidnight();
  const app = await start({
    seed: async db => {
      const now = Date.now();
      [{ id: github }] = await db.q(
        "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
        now,
      );
      await db.q(
        `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
         VALUES (1, ?, 'I_1', 'acme/web#1', 'Login fails on Safari', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
        github, now,
      );
      await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, 'acme/web#1', 'local-y', ?, 1800, 'first', 1)", github, yesterday().getTime());
    },
  });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Pick a date" }).click();
    await page.getByLabel("Go to day").fill(dayKey(yesterday()));
    // The header's button says it logs today.
    await page.getByRole("button", { name: "Log time today" }).waitFor();
    const day = page.locator("ol > li").filter({ hasText: "acme/web#1" });
    await day.getByRole("button", { name: /^Log time on / }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const y = yesterday();
    const title = await dialog.getByRole("heading").first().innerText();
    assert.match(title, new RegExp(String(y.getDate())), `the dialog names the day: ${title}`);
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: /acme\/web#1/ }).first().click();
    await page.getByRole("listbox").waitFor({ state: "detached" });
    await page.getByPlaceholder("2h 30m").fill("30m");
    await dialog.getByRole("button", { name: /^Log/ }).last().click();
    await dialog.waitFor({ state: "detached" });
    const rows = await db.q("SELECT started FROM worklogs WHERE connection_id = ? ORDER BY started", github);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(dayKey(new Date(Number(r.started))), dayKey(y), "both on yesterday");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
