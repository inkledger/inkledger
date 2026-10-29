// Issue links: by identity, and old ones (a key, a key the issue had before) still arriving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, withApp } from "./harness.mjs";

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

/** 10:00 on the last working day (Monday to Friday), and that day as the Dashboard's `from`. */
function lastWorkdayAt10() {
  const d = new Date();
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  d.setHours(10, 0, 0, 0);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { at: d.getTime(), day };
}

test("a logged slice of the day timeline opens its issue, by click or by keyboard", () => {
  const { at, day } = lastWorkdayAt10();
  return withApp(
    {
      seed: db =>
        db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-slice', ?, 3600, '', 1)", at),
    },
    async ({ page, base, db }) => {
      const [{ connection_id: conn }] = await db.q("SELECT connection_id FROM issues WHERE key = 'DEMO-101'");
      const slice = page.getByRole("link", { name: /^DEMO-101 from 10:00, 1 h/ });
      await page.goto(`${base}/?period=day&from=${day}`);
      await slice.click();
      await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
      await page.getByText("Test task number 1").first().waitFor();
      // Keyboard: the slice takes focus, Enter opens it.
      await page.goto(`${base}/?period=day&from=${day}`);
      await slice.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
    },
  );
});

test("a dialog opened on one issue doesn't follow the user to another (Back with it open)", () =>
  withApp({}, async ({ page, base, db }) => {
    const [{ connection_id: conn }] = await db.q("SELECT connection_id FROM issues WHERE key = 'DEMO-101'");
    const go = path => page.evaluate(p => {
      history.pushState({}, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.goto(`${base}/issues/${conn}/DEMO-101`);
    await page.getByText("Test task number 1").first().waitFor();
    // To another issue in the same page, then its Log time dialog.
    await go(`/issues/${conn}/DEMO-102`);
    await page.getByText("Test task number 2").first().waitFor();
    await page.locator("main").getByRole("button", { name: "Log time" }).first().click();
    await page.getByRole("dialog").waitFor();
    // Back to the first issue with it still open (browser Back, the mouse's back button, ⌘[).
    await page.goBack();
    await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
    await page.getByText("Test task number 1").first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("dialog").count(), 0, "the other issue's dialog is gone");
  }));
