// One question, every page: a stopped timer asks to be logged on all the
// user's pages and devices, the draft typed on one shows on the others, a
// page opened later finds it, and the first answer closes it everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

let github = 0;
const KEY = "acme/web#1";
const seed = async db => {
  const now = Date.now();
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, 'I_1', ?, 'Login fails on Safari', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
    github, KEY, now,
  );
  await db.q(
    "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, ?, 'running', ?, 3600, NULL, '', ?, ?)",
    github, KEY, now, now, now,
  );
};

test("a stopped timer asks on every page; the first answer closes it everywhere", () =>
  withApp({ seed }, async ({ page, context, base, db }) => {
    const browser = context.browser();
    const phone = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: "Europe/Rome", locale: "en-US" });
    await phone.addCookies(await context.cookies());
    const other = await phone.newPage();
    try {
      await page.goto(base + "/");
      await other.goto(base + "/");
      await page.getByRole("button", { name: `Stop and log time on ${KEY}` }).first().click();

      const title = `Log time on ${KEY}`;
      const here = page.getByRole("dialog", { name: title });
      const there = other.getByRole("dialog", { name: title });
      await here.waitFor();
      // The other device asks too, from the event stream.
      await there.waitFor({ timeout: 4000 });

      // Typed here, shown there.
      await here.getByLabel("Comment").fill("Fixing Safari login");
      await other.waitForFunction(() => [...document.querySelectorAll("textarea")].some(t => t.value === "Fixing Safari login"), null, { timeout: 4000 });

      // A page opened later finds the same question, with the draft.
      const later = await context.newPage();
      await later.goto(base + "/");
      const third = later.getByRole("dialog", { name: title });
      await third.waitFor();
      assert.equal(await third.getByLabel("Comment").inputValue(), "Fixing Safari login");

      // The other device answers: one worklog; this page and the late one are told who did.
      await there.getByRole("button", { name: "Log", exact: true }).click();
      await there.waitFor({ state: "detached" });
      await page.getByRole("status").filter({ hasText: /^Logged on / }).waitFor({ timeout: 4000 });
      await later.getByRole("status").filter({ hasText: /^Logged on / }).waitFor({ timeout: 4000 });
      assert.equal(await other.getByText(/^Logged on /).count(), 0, "the page that answered is not told it was elsewhere");

      const logs = await db.q("SELECT comment, time_spent_seconds FROM worklogs WHERE issue_key = ?", KEY);
      assert.equal(logs.length, 1, "one worklog");
      assert.equal(logs[0].comment, "Fixing Safari login");
      assert.equal((await db.q("SELECT count(*)::int AS n FROM timers")).at(0).n, 0, "timer cleared");
      const [d] = await db.q("SELECT state FROM decisions");
      assert.equal(d.state, "resolved");
    } finally {
      await phone.close();
    }
  }));

test("a question asked while typing elsewhere waits in a banner, then opens once the field is left", () =>
  withApp({ seed }, async ({ page, context, base }) => {
    const browser = context.browser();
    const phone = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: "Europe/Rome", locale: "en-US" });
    await phone.addCookies(await context.cookies());
    const other = await phone.newPage();
    try {
      await page.goto(base + "/");
      await other.goto(base + "/issues");
      const search = other.getByRole("searchbox").or(other.getByRole("textbox")).first();
      await search.click();
      await search.pressSequentially("safari");
      await page.getByRole("button", { name: `Stop and log time on ${KEY}` }).first().click();
      await other.getByRole("status").filter({ hasText: `Waiting for you: log time on ${KEY}` }).waitFor({ timeout: 4000 });
      assert.equal(await other.getByRole("dialog", { name: `Log time on ${KEY}` }).count(), 0, "no dialog under the cursor");
      assert.equal(await search.inputValue(), "safari", "the typing is untouched");
      // Leaving the field: the question opens.
      await other.locator("body").click({ position: { x: 5, y: 5 } });
      await other.getByRole("dialog", { name: `Log time on ${KEY}` }).waitFor({ timeout: 4000 });
    } finally {
      await phone.close();
    }
  }));
