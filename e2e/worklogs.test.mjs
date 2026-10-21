// The issue's work log: my time first, everyone's beside it with its author.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProcedures, start } from "./harness.mjs";

test("an issue shared with others: my worklogs highlighted, theirs with their author, my time over the team's", async () => {
  const at = Date.parse("2026-10-20T08:00:00+02:00");
  const app = await start({
    seed: db =>
      db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-105', 'wl-mine', ?, 3600, 'my part', 1)", at),
  });
  try {
    const { page, base } = app;
    await fakeProcedures(page, {
      "worklogs.team": {
        totalSeconds: 3600 + 5400,
        entries: [
          { remoteId: "wl-mine", start: at, day: null, seconds: 3600, comment: "my part", authorName: "Mario", mine: true },
          { remoteId: "wl-anna", start: at + 86_400_000, day: null, seconds: 5400, comment: "her part", authorName: "Anna Bianchi", mine: false },
        ],
      },
    });
    await page.goto(base + "/issues/DEMO-105");
    const list = page.getByTestId("issue-worklogs");
    await list.getByText("Anna Bianchi").waitFor();
    // Newest first, each with whose it is; mine is not repeated from the tracker.
    const rows = list.locator("li");
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(0).getAttribute("data-mine"), "false");
    assert.equal(await rows.nth(1).getAttribute("data-mine"), "true");
    await rows.nth(1).getByText("You").waitFor();
    // Only my own row can be changed.
    assert.equal(await rows.nth(0).getByRole("button", { name: "Edit worklog" }).count(), 0);
    assert.equal(await rows.nth(1).getByRole("button", { name: "Edit worklog" }).count(), 1);
    await page.getByText("My time").first().waitFor();
    await page.getByText("Team total").first().waitFor();
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
