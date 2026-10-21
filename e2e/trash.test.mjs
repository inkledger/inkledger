// The worklog trash: what was deleted comes back with one click.
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

/**
 * Restoring logs on Jira, which the test server never writes to
 * (JIRA_READ_ONLY): its answer is faked here, the rest is the real server.
 */
async function fakeRestore(page, restored) {
  await page.route(/\/api\/trpc\/[^?]*worklogs\.restore/, async route => {
    restored.push(JSON.parse(route.request().postData() ?? "{}"));
    const names = decodeURIComponent(new URL(route.request().url()).pathname.split("/api/trpc/")[1]).split(",");
    const out = names.map(() => ({ result: { data: { json: { id: 999, issueKey: "DEMO-101", timeSpentSeconds: 1800 } } } }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}

test("a deleted worklog is in Recently deleted, and restoring it sends it back", () =>
  withApp(
    {
      seed: db => {
        const started = new Date();
        started.setHours(9, 0, 0, 0);
        return db.q(
          "INSERT INTO worklog_trash (user_id, connection_id, worklog_uuid, issue_key, started, time_spent_seconds, comment, remote_id, reason, deleted_at) SELECT 1, id, gen_random_uuid(), 'DEMO-101', ?, 1800, 'design review', 'w-9', 'user', ? FROM connections LIMIT 1",
          started.getTime(),
          Date.now(),
        );
      },
    },
    async ({ page, base, db }) => {
      const restored = [];
      await fakeRestore(page, restored);
      await page.goto(base + "/timesheet");
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Recently deleted" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("design review").waitFor();
      const [{ id }] = await db.q("SELECT id FROM worklog_trash");
      await dialog.getByRole("button", { name: "Restore" }).click();
      await page.getByText("DEMO-101: worklog restored").waitFor();
      assert.equal(restored.length, 1);
      assert.match(JSON.stringify(restored[0]), new RegExp(`"id":${id}`));
    },
  ));
