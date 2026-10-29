// Searching across trackers: client: by name or other name, a search saved
// and found again (Issues and ⌘K), a pasted key or link opening its issue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, withApp } from "./harness.mjs";

let github = 0;
const seed = async db => {
  const now = Date.now();
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  const [{ id: web }] = await db.q("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, 'R_1', 'acme/web', 'web', ?) RETURNING id", github, now);
  const [{ id: app }] = await db.q("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, 'R_2', 'bigco/app', 'app', ?) RETURNING id", github, now);
  const row = (id, key, title, container, repo) =>
    db.q(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, container_id, issue_type, priority, labels, assignee_id, url, synced_at)
       VALUES (1, ?, ?, ?, ?, 'Open', 'To Do', 'todo', ?, ?, ?, 'Issue', '', '[]', '4242', ?, ?)`,
      github, id, key, title, repo, repo, container, `https://github.com/${repo}/issues/1`, now,
    );
  await row("I_1", "acme/web#1", "Login fails on Safari", web, "acme/web");
  await row("I_2", "bigco/app#1", "Billing export is slow", app, "bigco/app");
  const [{ id: acme }] = await db.q("INSERT INTO clients (user_id, name, aliases, created_at) VALUES (1, 'Acme', '[\"ACME Corp\"]', ?) RETURNING id", now);
  await db.q("INSERT INTO client_containers (client_id, container_id) VALUES (?, ?)", acme, web);
};

test("client: finds a client's issues by name or other name; a saved search comes back from Issues and ⌘K", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(`${base}/issues?unassigned=1&done=1`);
    const box = page.getByRole("searchbox", { name: "Filter the local catalogue" });
    await page.getByText("Billing export is slow").first().waitFor();
    await box.fill('client:"acme corp"');
    await page.getByText("Billing export is slow").first().waitFor({ state: "detached" });
    await page.getByText("Login fails on Safari").first().waitFor();
    await box.press("Enter");
    await page.getByRole("button", { name: "Save search" }).click();
    await page.getByRole("textbox", { name: "Name of the search" }).fill("Acme work");
    await page.getByRole("button", { name: "Save search" }).last().click();
    await page.getByText("Search “Acme work” saved").waitFor();
    await box.fill("");
    await page.getByText("Billing export is slow").first().waitFor();
    await page.getByRole("button", { name: "Recent and saved searches" }).click();
    await page.getByRole("menuitem", { name: /Acme work/ }).click();
    assert.equal(await box.inputValue(), 'client:"acme corp"');
    await page.getByText("Billing export is slow").first().waitFor({ state: "detached" });
    // ⌘K: the saved search, in the palette too.
    await page.goto(`${base}/`);
    await page.getByRole("button", { name: /^Search/ }).first().click();
    await page.getByRole("option", { name: /Acme work/ }).click();
    await page.waitForURL(/\/issues\?q=/);
    await page.getByText("Login fails on Safari").first().waitFor();
  }));

test("a pasted link opens its issue, from Issues (Enter) and from ⌘K", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(`${base}/issues`);
    const box = page.getByRole("searchbox", { name: "Filter the local catalogue" });
    await box.fill("https://github.com/acme/web/issues/1");
    // Enter again if the first came before the page could act on it (as a person would).
    const opened = new RegExp(`/issues/${github}/I_1$`);
    for (let i = 0; i < 3 && !opened.test(page.url()); i++) {
      await box.press("Enter");
      await page.waitForURL(opened, { timeout: 10_000 }).catch(() => {});
    }
    await page.waitForURL(opened);
    await page.getByRole("heading", { name: /Login fails on Safari/ }).first().waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("bigco/app#1");
    await page.getByRole("option", { name: "Open bigco/app#1" }).click();
    await page.waitForURL(new RegExp(`/issues/${github}/I_2$`));
  }));

test("on a phone: chips switch filters on and off in the box, field names complete as typed", () =>
  withApp({ seed, viewport: { width: 390, height: 844 } }, async ({ page, base }) => {
    await page.goto(`${base}/issues?unassigned=1&done=1`);
    const box = page.getByRole("searchbox", { name: "Filter the local catalogue" });
    const shows = text => page.waitForFunction(x => document.body.innerText.includes(x), text);
    const gone = text => page.waitForFunction(x => !document.body.innerText.includes(x), text);
    await shows("Billing export is slow");
    const quick = page.getByRole("group", { name: "Quick filters" });
    await quick.getByRole("button", { name: "Watched" }).click();
    await quick.getByRole("button", { name: "Watched", pressed: true }).waitFor();
    assert.equal((await box.inputValue()).trim(), "is:watched");
    await quick.getByRole("button", { name: "Watched" }).click();
    await quick.getByRole("button", { name: "Watched", pressed: false }).waitFor();
    assert.equal(await box.inputValue(), "");
    await box.fill("cli");
    await page.getByRole("option", { name: "client:" }).click();
    await page.waitForFunction(() => document.querySelector('input[type="search"]')?.value === "client:");
    await box.fill("client:acme");
    await gone("Billing export is slow");
    await shows("Login fails on Safari");
  }));
