// The board works on a bucket or one tracker, in three layouts, and a card
// goes only where its own tracker can take it: other columns stay off while
// dragging, a drop the tracker refuses goes back with its reason.
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

let github = 0;
const seed = async db => {
  const now = Date.now();
  await db.q("UPDATE issues SET status = 'In corso', category = 'doing' WHERE key = 'DEMO-102'");
  await db.q("UPDATE issues SET status = 'Fatto', category = 'done' WHERE key = 'DEMO-103'");
  await db.q("UPDATE issues SET category = 'todo' WHERE status = 'To Do'");
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  const gh = (id, n, title, state, category) =>
    db.q(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
       VALUES (1, ?, ?, ?, ?, ?, 'To Do', ?, 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', ?, ?)`,
      github, id, `acme/web#${n}`, title, state, category, `https://github.com/acme/web/issues/${n}`, now,
    );
  await gh("I_1", 1, "Login fails on Safari", "open", "todo");
  await gh("I_2", 2, "Old crash", "closed", "done");
};

/** Each tracker's ways on, as their APIs give them; a move to "In corso" refused by Jira's validator. */
async function fakeTrackers(page, sent) {
  await page.route(/\/api\/trpc\/[^?]*issues\.transition/, async route => {
    const url = new URL(route.request().url());
    const names = decodeURIComponent(url.pathname.split("/api/trpc/")[1]).split(",");
    const batched = url.searchParams.has("batch");
    const body = route.request().method() === "POST" ? JSON.parse(route.request().postData() ?? "{}") : JSON.parse(url.searchParams.get("input") ?? "{}");
    const mine = n => n === "issues.transition" || n === "issues.transitions";
    let real = [];
    if (!names.every(mine)) {
      // The page may be closing (end of the test): nothing left to answer.
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      real = await res.json().catch(() => []);
    }
    const out = names.map((n, i) => {
      if (!mine(n)) return real[i];
      const args = (batched ? body[i]?.json : body.json) ?? {};
      if (n === "issues.transitions") {
        const ways = args.connectionId === 1 ? [{ toStatus: "In corso", toCategory: "doing" }] : [{ toStatus: "closed", toCategory: "done" }];
        return { result: { data: { json: ways.map((w, j) => ({ id: String(j), name: w.toStatus, ...w, requirements: [], executable: true, remoteUrl: null })) } } };
      }
      sent.push(args);
      return { error: { json: { message: "Workflow validator: an estimate is needed first", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } } };
    });
    await route.fulfill({ status: out.some(o => o?.error) ? 400 : 200, contentType: "application/json", body: JSON.stringify(out) }).catch(() => {});
  });
}

/** Drags a card by hand, to look at the columns while it is in the air. */
async function lift(page, card) {
  await card.hover();
  await page.mouse.down();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 5 });
}

test("lanes per tracker: while dragging only the statuses its workflow reaches take the card; a refused move goes back with its reason", () =>
  withApp({ seed }, async ({ page, base }) => {
    const sent = [];
    await fakeTrackers(page, sent);
    await page.addInitScript(() => localStorage.setItem("ikl-board-mode", "lanes"));
    await page.goto(base + "/board");
    const jira = page.locator('[data-lane="1"]');
    const side = page.getByRole("group", { name: "Side projects" });
    await side.waitFor();
    const card = page.locator("[draggable=true]").filter({ has: page.getByText("Test task number 1", { exact: true }) });
    await card.hover();
    await page.waitForTimeout(300);
    await lift(page, card);
    const inCorso = jira.getByRole("region", { name: "In corso" });
    await page.waitForFunction(() => document.querySelector('section[aria-label="In corso"]')?.getAttribute("data-drop") === "on");
    assert.equal(await jira.getByRole("region", { name: "Fatto" }).getAttribute("data-drop"), "off");
    // Never onto another tracker's column.
    assert.equal(await side.getByRole("region", { name: "closed" }).getAttribute("data-drop"), "off");
    await page.mouse.move(...(await center(side.getByRole("region", { name: "closed" }))), { steps: 5 });
    await page.mouse.up();
    assert.equal(sent.length, 0, "nothing sent for a column it can't go to");

    await lift(page, card);
    await page.mouse.move(...(await center(inCorso)), { steps: 5 });
    await page.mouse.up();
    await page.getByText("Workflow validator: an estimate is needed first").waitFor();
    assert.deepEqual(sent.map(s => [s.key, s.connectionId, s.toStatus]), [["DEMO-101", 1, "In corso"]]);
    // Back where it was.
    await jira.getByRole("region", { name: "To Do" }).getByText("Test task number 1", { exact: true }).waitFor();
  }));

test("by category, and from the card's menu (keyboard, long press): only where its tracker can take it", () =>
  withApp({ seed }, async ({ page, base }) => {
    const sent = [];
    await fakeTrackers(page, sent);
    await page.goto(base + "/board");
    await page.getByRole("radio", { name: "By category" }).click();
    const doing = page.getByRole("region", { name: "In progress" });
    await doing.waitFor();
    const card = page.locator("[draggable=true]", { hasText: "Login fails on Safari" }).first();
    await card.hover();
    await page.waitForTimeout(300);
    await lift(page, card);
    await page.waitForFunction(() => document.querySelector('section[aria-label="Done"]')?.getAttribute("data-drop") === "on");
    assert.equal(await doing.getAttribute("data-drop"), "off");
    await page.mouse.up();
    // The menu lists only "Done" for the GitHub card.
    await page.getByRole("button", { name: /acme\/web#1/ }).click();
    const items = await page.getByRole("menuitem").allInnerTexts();
    assert.ok(items.includes("Done"), items.join("|"));
    assert.ok(!items.includes("In progress"), items.join("|"));
    await page.keyboard.press("Escape");
  }));

test("one tracker from the board's own switcher", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(base + "/board");
    await page.getByText("Login fails on Safari").first().waitFor();
    await page.getByRole("button", { name: /^Board shows/ }).click();
    await page.getByRole("menuitemradio", { name: "Side projects" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Test task number 1"));
    await page.getByText("Login fails on Safari").first().waitFor();
  }));

test("custom columns made in Settings → Buckets, each tracker's statuses mapped onto them", () =>
  withApp({ seed }, async ({ page, base }) => {
    const sent = [];
    await fakeTrackers(page, sent);
    await page.goto(base + "/settings/buckets");
    await page.getByRole("button", { name: "New bucket" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill("Work");
    // Each tracker whole (its own label, not one of its projects).
    await form.getByRole("checkbox", { name: /^jira\.example\.it · all of/ }).check();
    await form.getByRole("checkbox", { name: /^Side projects · all of/ }).check();
    await form.getByLabel("Board layout").selectOption("custom");
    await form.getByRole("button", { name: "Add column" }).click();
    await form.getByRole("button", { name: "Add column" }).click();
    await form.getByLabel("Name of column 1").fill("Waiting");
    await form.getByLabel("Name of column 2").fill("Finished");
    await form.getByLabel("Column for To Do").selectOption({ label: "Waiting" });
    await form.getByLabel("Column for open").selectOption({ label: "Waiting" });
    await form.getByLabel("Column for closed").selectOption({ label: "Finished" });
    await form.getByLabel("Column for Fatto").selectOption({ label: "Finished" });
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByText("Work saved").waitFor();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: /Showing: Everything/ }).click();
    const switched = page.waitForResponse(r => r.url().includes("buckets.setActive"));
    await page.getByRole("menuitemradio", { name: "Work" }).click();
    await switched;

    await page.goto(base + "/board");
    const waiting = page.getByRole("region", { name: "Waiting" });
    await waiting.getByText("Login fails on Safari").waitFor();
    await waiting.getByText("Test task number 1", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Finished" }).getByText("Old crash").waitFor();
    // "In corso" is in no column: said apart.
    await page.getByRole("region", { name: "In no column" }).getByText("Test task number 2", { exact: true }).waitFor();
    // GitHub's open issue can go to Finished (closed), Jira's To Do can't (only "In corso", in no column).
    const gh = page.locator("[draggable=true]").filter({ hasText: "Login fails on Safari" });
    await gh.hover();
    await page.waitForTimeout(300);
    await lift(page, gh);
    await page.waitForFunction(() => document.querySelector('section[aria-label="Finished"]')?.getAttribute("data-drop") === "on");
    await page.mouse.up();
    const jira = page.locator("[draggable=true]").filter({ has: page.getByText("Test task number 1", { exact: true }) });
    await jira.hover();
    await page.waitForTimeout(300);
    await lift(page, jira);
    await page.waitForFunction(() => document.querySelector('section[aria-label="Finished"]')?.getAttribute("data-drop") === "off");
    await page.mouse.up();
  }));

async function center(locator) {
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + Math.min(b.height / 2, 60)];
}
