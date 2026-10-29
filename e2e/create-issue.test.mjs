// New issue: one list of places across trackers (a Jira project, a GitHub
// repository); Jira asks for a type, GitHub doesn't; never raw errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, trpcProcs, withApp } from "./harness.mjs";

const TARGETS = [
  { connectionId: 1, name: "Jira", label: "Work Jira", types: true, containers: [{ key: "DEMO", name: "Demo", mine: true }, { key: "NEW", name: "New project", mine: false }] },
  { connectionId: 7, name: "GitHub", label: "Side projects", types: false, containers: [{ key: "acme/web", name: "acme/web", mine: true }] },
];
const TYPES = [{ id: "10002", name: "Bug" }, { id: "10001", name: "Task" }];

/** The creating procedures, as the server answers them; the rest of each batch goes to the server. */
async function fakeCreate(page, sent) {
  await page.route(/\/api\/trpc\/[^?]*issues\.create/, async route => {
    const url = new URL(route.request().url());
    const names = trpcProcs(url);
    const input = route.request().method() === "POST" ? JSON.parse(route.request().postData() ?? "{}") : {};
    const mine = n => n.startsWith("issues.create");
    let real = [];
    if (!names.every(mine)) real = await (await route.fetch()).json().catch(() => []);
    const out = names.map((n, i) => {
      if (!mine(n)) return real[i];
      if (n === "issues.createTargets") return { result: { data: { json: TARGETS } } };
      if (n === "issues.createTypes") return { result: { data: { json: TYPES } } };
      const args = (url.searchParams.has("batch") ? input[i]?.json : input.json) ?? {};
      sent.push(args);
      if (args.title === "bad") return { error: { json: { message: "Something in the request isn't valid: check the fields and try again.", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400, fields: { title: "Not valid" } } } } };
      return { result: { data: { json: { key: "DEMO-101", connectionId: 1, remoteId: "DEMO-101" } } } };
    });
    await route.fulfill({ status: out.some(o => o?.error) ? 400 : 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}

test("New issue goes to a Jira project with its type, or to a GitHub repository without one", () =>
  withApp({}, async ({ page, base }) => {
    const sent = [];
    await fakeCreate(page, sent);
    await page.goto(base + "/issues");
    const open = async () => {
      // A new issue opens its page: the list again for the next one.
      if (!page.url().endsWith("/issues")) await page.goto(base + "/issues");
      await page.getByRole("button", { name: "New issue" }).first().click();
      return page.getByRole("dialog");
    };
    let dialog = await open();
    await dialog.getByRole("combobox", { name: "Project" }).click();
    // Grouped by tracker, mine first.
    await page.getByText("Work Jira · My projects").waitFor();
    await page.getByRole("option", { name: "NEW — New project" }).click();
    // Jira asks for a type: a task by default.
    await dialog.getByRole("combobox", { name: "Type" }).getByText("Task").waitFor();
    await dialog.getByLabel("Title").fill("Customer request");
    await dialog.getByRole("button", { name: "Create issue" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(sent.at(-1), { connectionId: 1, container: "NEW", title: "Customer request", body: "", assignToMe: true, type: "10001" });

    dialog = await open();
    await dialog.getByRole("combobox", { name: "Project" }).click();
    await page.getByRole("option", { name: "acme/web" }).click();
    // GitHub has no issue types: no field for one.
    assert.equal(await dialog.getByRole("combobox", { name: "Type" }).count(), 0);
    await dialog.getByLabel("Title").fill("bad");
    await dialog.getByRole("button", { name: "Create issue" }).click();
    // Refused: words, never the validator's JSON.
    await page.getByText("check the fields and try again").first().waitFor();
    assert.equal(await page.getByText('"code"').count(), 0);
    assert.deepEqual(sent.at(-1), { connectionId: 7, container: "acme/web", title: "bad", body: "", assignToMe: true });
  }));
