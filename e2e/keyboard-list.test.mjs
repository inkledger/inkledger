// Moving through Issues with j/k keeps the selected row in view, whatever tracker it is on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

test("j moves the selection down the list and keeps the selected row on screen", async () => {
  const app = await start({
    viewport: { width: 1400, height: 700 },
    seed: async db => {
      const now = Date.now();
      for (let i = 1; i <= 40; i++) {
        await db.q(
          `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
           VALUES (1, 1, ?, ?, ?, 'To Do', 'To Do', 'KB', 'Project', 'Task', 'Medium', '[]', 'mrossi', ?, ?)`,
          `KB-${i}`, `KB-${i}`, `Keyboard row ${i}`, `https://jira.example.it/browse/KB-${i}`, now,
        );
      }
    },
  });
  try {
    const { page, base } = app;
    await page.goto(`${base}/issues`);
    await page.getByText("Keyboard row 1", { exact: true }).first().waitFor();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    for (let i = 0; i < 35; i++) await page.keyboard.press("j");
    const row = page.locator('tr[aria-selected="true"]');
    await row.waitFor();
    const box = await row.boundingBox();
    const view = page.viewportSize();
    assert.ok(box && box.y >= 0 && box.y + box.height <= view.height, `the selected row is on screen (y ${box?.y})`);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
