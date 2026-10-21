// Settings → Connections: several trackers, one archived leaves the lists.
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
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'jira', 'Client B', 'https://clientb.example.it', 'mrossi', 'Mario Rossi', '{\"deployment\":\"server\",\"authType\":\"basic\",\"username\":\"mrossi\"}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, '9001', 'CLB-1', 'Client B onboarding', 'To Do', 'To Do', 'CLB', 'Client B', 'Task', 'Medium', '[]', 'mrossi', 'https://clientb.example.it/browse/CLB-1', ?)`,
    id, now,
  );
  // An hour on it yesterday at 10.
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(10, 0, 0, 0);
  await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, 'CLB-1', 'w-clb', ?, 3600, '', 1)", id, d.getTime());
};

test("two trackers in Settings → Connections; archiving one takes its issues off the lists", () =>
  withApp({ seed: secondJira }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    await page.getByText("Client B onboarding").first().waitFor();

    await page.goto(base + "/settings/connections");
    await page.getByRole("button", { name: "Actions for Client B" }).waitFor();
    await page.getByRole("button", { name: "Actions for jira.example.it" }).waitFor();

    // The catalogue: Jira can be added, GitHub is to come.
    await page.getByRole("button", { name: "Add" }).click();
    const add = page.getByRole("dialog");
    await add.getByRole("button", { name: /^Jira/ }).waitFor();
    // GitHub signs in through inkledger's OAuth App.
    assert.equal(await add.getByRole("button", { name: /^GitHub/ }).isDisabled(), false);
    // Built on a simulator: offered, said not verified, its token form asks the server's address.
    const gitlab = add.getByRole("button", { name: /^GitLab/ });
    assert.equal(await gitlab.isDisabled(), false);
    assert.match(await gitlab.innerText(), /Not verified yet/);
    await gitlab.click();
    await add.getByLabel("Address of your server").waitFor();
    await add.getByLabel("Personal access token").waitFor();
    await add.getByText(/tested on a simulator/).waitFor();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Actions for Client B" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
    await page.getByText("Client B archived").waitFor();

    await page.goto(base + "/issues");
    await page.getByText("Test task number 1").first().waitFor();
    assert.equal(await page.getByText("Client B onboarding").count(), 0);

    // Its time stays: the Timesheet still counts the hour logged on it.
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    await page.goto(`${base}/timesheet?day=${day}`);
    await page.getByText("CLB-1").first().waitFor();
  }));

test("webhooks are off until turned on; on, the address and secret to register are shown, off again they go", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/settings/connections");
    await page.getByRole("button", { name: "Actions for jira.example.it" }).click();
    await page.getByRole("menuitem", { name: "Options" }).click();
    const dialog = page.getByRole("dialog");
    const toggle = dialog.getByRole("switch", { name: "Webhooks" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    const url = dialog.getByLabel("Address to register");
    await url.waitFor();
    assert.match(await url.inputValue(), new RegExp(`^${base.replace(/[.]/g, "\\.")}/api/hooks/1/[0-9a-f]{32}$`));
    await toggle.click();
    await url.waitFor({ state: "detached" });
  }));
