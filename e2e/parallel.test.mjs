// Time logged in parallel: two lanes on the day's timeline, and the clock time beside the logged one.
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

test("two overlapping worklogs sit in two lanes; the day says logged vs clock time", () =>
  withApp(
    {
      seed: async db => {
        const at = (h, m = 0) => {
          const d = new Date();
          d.setHours(h, m, 0, 0);
          return d.getTime();
        };
        for (const [key, start, seconds] of [["DEMO-101", at(9), 3600], ["DEMO-102", at(9, 30), 3600]]) {
          await db.q(
            "INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, author_account_id, synced_at) VALUES (1, ?, ?, ?, ?, '', 'mrossi', ?)",
            key, `w-${key}`, seconds, start, Date.now(),
          );
        }
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/");
      const a = page.locator('[title^="DEMO-101 ·"]').first();
      const b = page.locator('[title^="DEMO-102 ·"]').first();
      await a.waitFor();
      const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()];
      assert.ok(boxA && boxB);
      assert.ok(boxB.y >= boxA.y + boxA.height - 1, "DEMO-102 sits in the lane below DEMO-101");
      await page.getByText("2 h logged in 1 h 30 min of clock time (in parallel)").waitFor();
    },
  ));
