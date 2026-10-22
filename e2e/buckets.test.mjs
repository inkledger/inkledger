// Buckets: a device narrows its lists to one tracker, and goes back to everything.
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

const secondJira = async db => {
  const now = Date.now();
  const [{ id }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'jira', 'Client B', 'https://clientb.example.it', 'mrossi', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, '9001', 'CLB-1', 'Client B onboarding', 'To Do', 'To Do', 'CLB', 'Client B', 'Task', 'Medium', '[]', 'mrossi', 'https://clientb.example.it/browse/CLB-1', ?)`,
    id, now,
  );
};

test("a bucket narrows this device's board and lists; the chip goes back to everything", () =>
  withApp({ seed: secondJira }, async ({ page, base }) => {
    await page.goto(base + "/settings/buckets");
    await page.getByRole("button", { name: "New bucket" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill("Client B");
    await form.getByRole("checkbox", { name: "Client B · all of Jira" }).check();
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByText("Client B saved").waitFor();

    await page.goto(base + "/board");
    await page.getByText("Test task number 1").first().waitFor();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: /Showing: Everything/ }).click();
    await page.getByRole("menuitemradio", { name: "Client B" }).click();
    await page.getByText("Client B onboarding").first().waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes("Test task number 1"));

    await page.goto(base + "/issues");
    const clear = page.getByRole("button", { name: "Show everything" });
    await clear.waitFor();
    await clear.click();
    await page.getByText("Test task number 1").first().waitFor();
  }));

// The last working day 10–11 on the first tracker, 11–12 on Client B (a working day:
// its holes are checked below, and a Saturday or Sunday has none).
const dayBefore = () => {
  const d = new Date();
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return d;
};
const keyOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const secondJiraWithTime = async db => {
  await secondJira(db);
  const [{ id }] = await db.q("SELECT id FROM connections WHERE label = 'Client B'");
  const at = h => {
    const d = dayBefore();
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-a', ?, 3600, '', 1)", at(10));
  await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, 'CLB-1', 'w-b', ?, 3600, '', 1)", id, at(11));
};

test("D9: Timesheet and Report follow the bucket, All shows everything; the day's holes always see all the time", () =>
  withApp({ seed: secondJiraWithTime }, async ({ page, base }) => {
    await page.goto(base + "/settings/buckets");
    await page.getByRole("button", { name: "New bucket" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill("Client B");
    await form.getByRole("checkbox", { name: "Client B · all of Jira" }).check();
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByText("Client B saved").waitFor();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: /Showing: Everything/ }).click();
    const switched = page.waitForResponse(r => r.url().includes("buckets.setActive"));
    await page.getByRole("menuitemradio", { name: "Client B" }).click();
    await switched;

    const day = keyOf(dayBefore());
    await page.goto(`${base}/timesheet?day=${day}`);
    await page.getByText("CLB-1").first().waitFor();
    assert.equal(await page.getByText("DEMO-101").count(), 0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByText("DEMO-101").first().waitFor();
    // The search: only what it names.
    await page.getByRole("searchbox", { name: "Search the time shown" }).fill("onboarding");
    await page.waitForFunction(() => !document.body.innerText.includes("DEMO-101"));
    await page.getByText("CLB-1").first().waitFor();

    await page.goto(`${base}/reports?from=${day}&to=${day}&group=issue`);
    await page.getByText("CLB-1").first().waitFor();
    assert.equal(await page.getByText("DEMO-101").count(), 0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByText("DEMO-101").first().waitFor();

    // The Dashboard's day, with the bucket still on: 10–12 is logged, never a hole.
    await page.goto(`${base}/?from=${day}`);
    await page.getByRole("button", { name: /Log missing time from 0?9:00 to 10:00/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Log missing time from 1[01]:00/ }).count(), 0);
  }));
