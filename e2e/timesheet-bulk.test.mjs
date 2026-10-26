// Many entries at once on the Timesheet: select them all or a day at a time (other choices
// kept), and a long delete counts its progress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, start } from "./harness.mjs";

let github = 0;
test("Select all, a day's own checkbox, and a delete that counts x/y", { timeout: 600_000 }, async () => {
  await awayFromMidnight();
  // Two days of this week that are not today (dates by local midnight, DST aside), each with three entries.
  const monday = new Date();
  monday.setHours(9, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  // Always two (on a Monday: Tuesday and Wednesday).
  const days = [0, 1, 2]
    .map(n => new Date(monday.getTime() + n * 86_400_000))
    .filter(d => d.toDateString() !== new Date().toDateString())
    .slice(0, 2);
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
      let n = 0;
      for (const d of days)
        for (let h = 0; h < 3; h++)
          await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, 'acme/web#1', ?, ?, 1800, '', 1)", github, `local-b${n++}`, d.getTime() + h * 3_600_000);
    },
  });
  try {
    const { page, base, db } = app;
    const total = days.length * 3;
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Select all" }).click();
    await page.getByRole("button", { name: `Delete ${total} selected` }).waitFor();
    // A day's checkbox takes that day out, the rest stays chosen.
    await page.getByRole("checkbox", { name: /^Select the entries of / }).first().click();
    await page.getByRole("button", { name: `Delete ${total - 3} selected` }).waitFor();
    await page.getByRole("checkbox", { name: /^Select the entries of / }).first().click();
    // Each delete held a moment: the button counts.
    await page.route(u => new URL(u).pathname.includes("worklogs.delete"), async route => {
      await new Promise(r => setTimeout(r, 300));
      return route.continue();
    });
    await page.getByRole("button", { name: `Delete ${total} selected` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /^Delete/ }).click();
    await page.getByText(new RegExp(`Deleting \\d/${total}`)).first().waitFor();
    await page.getByText(`${total} worklogs deleted`).first().waitFor({ timeout: 20_000 });
    assert.deepEqual(await db.q("SELECT count(*)::int AS n FROM worklogs WHERE connection_id = ?", github), [{ n: 0 }]);
  } finally {
    await app.stop();
  }
});
