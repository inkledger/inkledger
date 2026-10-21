// Issue links: by identity, and old ones (a key, a key the issue had before) still arriving.
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

test("an old link by key, or by a key the issue had before, lands on the issue's own link", () =>
  withApp(
    {
      seed: db =>
        db.q("INSERT INTO item_aliases (item_id, key, created_at) SELECT id, 'OLD-5', ? FROM issues WHERE key = 'DEMO-101'", Date.now()),
    },
    async ({ page, base, db }) => {
      const [{ connection_id: conn }] = await db.q("SELECT connection_id FROM issues WHERE key = 'DEMO-101'");
      for (const old of ["/issues/DEMO-101", "/issues/OLD-5"]) {
        await page.goto(base + old);
        await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
        await page.getByText("Test task number 1").first().waitFor();
      }
      // From the list, the link is the issue's own already.
      await page.goto(base + "/issues");
      const href = await page.getByRole("link", { name: /DEMO-102/ }).first().getAttribute("href");
      assert.equal(href, `/issues/${conn}/DEMO-102`);
    },
  ));
