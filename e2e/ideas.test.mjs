// Ideas in triage (docs/work/ideas/triage.md): a pasted list, moves by drag and by keyboard
// (Ready is earned), the palette's "New idea", and the page and its sheet at 320 px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trpcProcs, withApp } from "./harness.mjs";

const SEVEN = ["1) Bucket of its own in the add-in", "2) A record of purchases", "3. Keep what deleted mails showed", "- Notes in folders", "* Why the build is red", "4) A waiting room for ideas", "[ ] Estimates from my history"].join("\n");
const column = (page, name) => page.getByRole("region", { name, exact: true });

test("a pasted list becomes seven ideas", () =>
  withApp({ viewport: { width: 1400, height: 900 } }, async ({ page, base, db }) => {
    await page.goto(base + "/ideas");
    await page.getByRole("heading", { name: "Ideas" }).first().waitFor();
    await page.getByRole("radio", { name: "Columns" }).click();
    const field = page.getByRole("textbox", { name: "New ideas" });
    await field.fill(SEVEN);
    await page.getByText("7 ideas", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const raw = column(page, "Raw");
    await raw.getByRole("listitem").nth(6).waitFor();
    assert.deepEqual(await raw.getByRole("listitem").evaluateAll(items => items.map(i => i.getAttribute("aria-label"))), [
      "Bucket of its own in the add-in",
      "A record of purchases",
      "Keep what deleted mails showed",
      "Notes in folders",
      "Why the build is red",
      "A waiting room for ideas",
      "Estimates from my history",
    ]);
    assert.equal(await field.inputValue(), "");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM ideas WHERE state = 'raw'"))[0].n, 7);
  }));

test("ideas move by drag and by keyboard, and Ready is earned", () =>
  withApp(
    {
      viewport: { width: 1400, height: 900 },
      seed: async db => {
        const now = Date.now();
        for (const [n, title] of ["Drag me", "Key me"].entries())
          await db.q("INSERT INTO ideas (user_id, title, state, position, created_at, updated_at) VALUES (1, ?, 'raw', ?, ?, ?)", title, n, now, now);
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/ideas");
      await page.getByRole("radio", { name: "Columns" }).click();
      const card = title => page.getByRole("listitem", { name: title });
      await card("Drag me").waitFor();
      // Raw → Refining by drag.
      await card("Drag me").dragTo(column(page, "Refining"));
      await column(page, "Refining").getByRole("listitem", { name: "Drag me" }).waitFor();
      // → Ready with no "done when": refused, said, and it stays where it was.
      await column(page, "Refining").getByRole("listitem", { name: "Drag me" }).dragTo(column(page, "Ready"));
      await page.getByText('Add at least one "done when" first.').waitFor();
      assert.equal(await column(page, "Ready").getByRole("listitem").count(), 0);
      assert.equal((await db.q("SELECT state FROM ideas WHERE title = 'Drag me'"))[0].state, "refining");
      // By keyboard: the card's menu, Move to.
      await page.getByRole("button", { name: "More for Key me" }).click();
      await page.getByRole("menuitem", { name: "Move to" }).click();
      await page.getByRole("menuitem", { name: "Discarded" }).click();
      await page.getByRole("status").filter({ hasText: "Key me: now in Discarded" }).waitFor({ state: "attached" });
      for (let i = 0; i < 50 && (await db.q("SELECT state FROM ideas WHERE title = 'Key me'"))[0].state !== "discarded"; i++) await new Promise(r => setTimeout(r, 100));
      assert.equal((await db.q("SELECT state FROM ideas WHERE title = 'Key me'"))[0].state, "discarded");
      // And Alt+→ on a focused card: the next column.
      await column(page, "Refining").getByRole("listitem", { name: "Drag me" }).focus();
      await page.keyboard.press("Alt+ArrowLeft");
      await column(page, "Raw").getByRole("listitem", { name: "Drag me" }).waitFor();
    },
  ));

test("ideas from the command palette", () =>
  withApp({}, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("option", { name: "New idea" }).click();
    const dialog = page.getByRole("dialog", { name: "New idea" });
    await dialog.getByRole("textbox", { name: "New ideas" }).fill("From anywhere");
    await page.keyboard.press("ControlOrMeta+Enter");
    await dialog.waitFor({ state: "detached" });
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM ideas"))[0].n === 0; i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(await db.q("SELECT title, state FROM ideas"), [{ title: "From anywhere", state: "raw" }]);
    // And "Ideas" goes to the page, where it is.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("option", { name: "Ideas", exact: true }).click();
    await page.waitForURL(base + "/ideas");
    await page.getByRole("listitem", { name: "From anywhere" }).waitFor();
  }));

/** "New issue" as the server answers it: Jira's DEMO project; created as DEMO-101 (already in the catalogue). */
async function fakeCreate(page, sent) {
  await page.route(/\/api\/trpc\/[^?]*issues\.create/, async route => {
    const url = new URL(route.request().url());
    const names = trpcProcs(url);
    const input = route.request().method() === "POST" ? JSON.parse(route.request().postData() ?? "{}") : {};
    const mine = n => n.startsWith("issues.create");
    const real = names.every(mine) ? [] : await (await route.fetch()).json().catch(() => []);
    const out = names.map((n, i) => {
      if (!mine(n)) return real[i];
      if (n === "issues.createTargets") return { result: { data: { json: [{ connectionId: 1, name: "Jira", label: "Work Jira", types: true, containers: [{ key: "DEMO", name: "Demo", mine: true }] }] } } };
      if (n === "issues.createTypes") return { result: { data: { json: [{ id: "10001", name: "Task" }] } } };
      sent.push((url.searchParams.has("batch") ? input[i]?.json : input.json) ?? {});
      return { result: { data: { json: { key: "DEMO-101", connectionId: 1, remoteId: "DEMO-101" } } } };
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}

test("an idea becomes a Jira issue through the usual dialog", () =>
  withApp(
    {
      viewport: { width: 1400, height: 900 },
      seed: async db => {
        const now = Date.now();
        await db.q("UPDATE issues SET connection_id = 1 WHERE key = 'DEMO-101'");
        await db.q(
          "INSERT INTO ideas (user_id, title, body, state, acceptance, questions, position, created_at, updated_at) VALUES (1, 'Export to CSV', 'Users ask for it.', 'ready', ?, ?, 0, ?, ?)",
          JSON.stringify([{ id: "a", text: "A CSV with every column" }]),
          JSON.stringify([{ id: "q", text: "Which separator?", answer: "Semicolon", blocking: true }]),
          now,
          now,
        );
      },
    },
    async ({ page, base, db }) => {
      const sent = [];
      await fakeCreate(page, sent);
      await page.goto(base + "/ideas");
      await page.getByRole("radio", { name: "Columns" }).click();
      await page.getByRole("button", { name: "Open Export to CSV" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Create issue" }).click();
      // The usual dialog, filled from the idea (once the sheet has gone).
      const dialog = page.getByRole("dialog", { name: "New issue" });
      await dialog.getByLabel("Title").waitFor();
      assert.equal(await dialog.getByLabel("Title").inputValue(), "Export to CSV");
      await dialog.getByRole("combobox", { name: "Project" }).click();
      await page.getByRole("option", { name: /DEMO/ }).click();
      await dialog.getByRole("button", { name: "Create issue" }).click();
      await page.waitForURL(/DEMO-101/);
      assert.equal(sent.at(-1).body, "Users ask for it.\n\nDone when…\n- A CSV with every column\n\nDecisions taken\n- Which separator? → Semicolon");
      for (let i = 0; i < 50 && (await db.q("SELECT state FROM ideas"))[0].state !== "promoted"; i++) await new Promise(r => setTimeout(r, 100));
      assert.deepEqual(await db.q("SELECT state, promoted_issue_key, promoted_connection_id FROM ideas"), [{ state: "promoted", promoted_issue_key: "DEMO-101", promoted_connection_id: 1 }]);
      // The issue page has nothing in triage; the idea sits under "Became an issue" with its key.
      assert.equal(await page.getByText("In triage").count(), 0);
      await page.goto(base + "/ideas");
      await page.getByRole("button", { name: /^Show Became an issue/ }).click();
      await page.getByRole("region", { name: "Became an issue", exact: true }).getByText("Became DEMO-101").waitFor();
    },
  ));

test("an idea I will do becomes an issue and a TODO", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        await db.q("UPDATE issues SET connection_id = 1 WHERE key = 'DEMO-102'");
        const [{ id }] = await db.q("SELECT id FROM issues WHERE key = 'DEMO-102'");
        await db.q(
          "INSERT INTO ideas (user_id, title, state, route, promoted_connection_id, promoted_item_id, promoted_issue_key, promoted_at, position, created_at, updated_at) VALUES (1, 'Rotate the keys', 'promoted', 'me', 1, ?, 'DEMO-102', ?, 0, ?, ?)",
          id, now, now, now,
        );
      },
    },
    async ({ page, base, db }) => {
      const [{ id }] = await db.q("SELECT id FROM ideas");
      await page.goto(`${base}/ideas?open=${id}`);
      await page.getByRole("dialog").getByRole("button", { name: "Make a TODO" }).click();
      await page.getByText("TODO added for DEMO-102").waitFor();
      assert.deepEqual(await db.q("SELECT text, issue_key, connection_id FROM todos"), [{ text: "Rotate the keys", issue_key: "DEMO-102", connection_id: 1 }]);
    },
  ));

test("a vague issue goes to triage and back", () =>
  withApp({ seed: async db => void (await db.q("UPDATE issues SET connection_id = 1 WHERE key = 'DEMO-103'")) }, async ({ page, base, db }) => {
    await page.goto(base + "/issues/DEMO-103?c=1");
    await page.getByRole("button", { name: "Send to triage" }).click();
    const chip = page.getByRole("link", { name: "In triage" });
    await chip.waitFor();
    // Made from the issue, nothing sent to its tracker; once only.
    assert.deepEqual(await db.q("SELECT title, state, source_issue_key, source_connection_id FROM ideas"), [{ title: "Test task number 3", state: "raw", source_issue_key: "DEMO-103", source_connection_id: 1 }]);
    await chip.click();
    await page.waitForURL(/\/ideas\?open=\d+/);
    await page.getByRole("dialog").getByRole("textbox", { name: "Title" }).waitFor();
    assert.equal(await page.getByRole("dialog").getByRole("textbox", { name: "Title" }).inputValue(), "Test task number 3");
    // Back on the issue, it says so again after a reload.
    await page.goto(base + "/issues/DEMO-103?c=1");
    await page.getByRole("link", { name: "In triage" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send to triage" }).count(), 0);
  }));

test("a suggestion is used field by field", () =>
  withApp(
    {
      viewport: { width: 1400, height: 900 },
      env: { OLLAMA_SIMULATOR: "1" },
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO ideas (user_id, title, body, state, position, created_at, updated_at) VALUES (1, 'Estimates', 'Rough.', 'raw', 0, ?, ?)", now, now);
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/ideas");
      await page.getByRole("radio", { name: "Columns" }).click();
      await page.getByRole("button", { name: "Open Estimates" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Suggest" }).click();
      const panel = sheet.getByRole("region", { name: "Suggested by simulator" });
      await panel.waitFor();
      // Nothing saved by suggesting.
      assert.equal((await db.q("SELECT acceptance FROM ideas"))[0].acceptance, "[]");
      // One field: the criteria join the list, the rest stays as it was.
      await panel.getByRole("button", { name: "Use the suggested Done when…" }).click();
      const criteria = sheet.getByRole("region", { name: "Done when…" });
      await criteria.getByText("The issue page shows a range").waitFor();
      await criteria.getByText("The range says how many issues it is based on").waitFor();
      await panel.getByText("Used").first().waitFor();
      assert.equal(await sheet.getByRole("textbox", { name: "Title" }).inputValue(), "Estimates");
      await page.waitForTimeout(300);
      const saved = JSON.parse((await db.q("SELECT acceptance FROM ideas WHERE title = 'Estimates'"))[0].acceptance);
      assert.deepEqual(saved.map(c => c.text), ["The issue page shows a range", "The range says how many issues it is based on"]);
      // Out of scope goes under the problem; the split makes new ideas, with Undo.
      await panel.getByRole("button", { name: "Use the suggested Out of scope" }).click();
      await page.waitForTimeout(300);
      assert.match((await db.q("SELECT body FROM ideas WHERE title = 'Estimates'"))[0].body, /^Rough\.\n\nOut of scope:\n- Team estimates$/);
      await panel.getByRole("button", { name: "Use the suggested Split into ideas" }).click();
      await page.getByText("2 new ideas in Raw").waitFor();
      assert.equal((await db.q("SELECT count(*)::int AS n FROM ideas WHERE title IN ('Range on the issue page', 'Accuracy in Reports') AND deleted_at IS NULL"))[0].n, 2);
      // Closing with suggestions unused asks first.
      await page.keyboard.press("Escape");
      await page.getByRole("alertdialog").waitFor();
    },
  ));

test("ideas at 320 px", () =>
  withApp(
    {
      viewport: { width: 320, height: 800 },
      seed: async db => {
        const now = Date.now();
        await db.q(
          "INSERT INTO ideas (user_id, title, body, state, acceptance, questions, position, created_at, updated_at) VALUES (1, ?, 'A body', 'refining', ?, ?, 0, ?, ?)",
          "An-idea-with-a-very-long-unbroken-title-that-must-wrap-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
          JSON.stringify([{ id: "a", text: "Done when it wraps" }]),
          JSON.stringify([{ id: "q", text: "Does it fit?", answer: "", blocking: true }]),
          now,
          now,
        );
      },
    },
    async ({ page, base }) => {
      const overflow = () =>
        page.evaluate(() => {
          const root = document.documentElement;
          const main = document.querySelector("main");
          for (const element of main?.querySelectorAll(".sr-only, [data-overflow-ok]") ?? []) element.style.display = "none";
          return { root: root.scrollWidth - root.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
        });
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto(base + "/ideas");
        // A narrow screen starts in the list.
        await page.getByRole("radio", { name: "List", checked: true }).waitFor();
        const card = page.getByRole("listitem").filter({ hasText: "An-idea-with" });
        await card.waitFor();
        assert.deepEqual(await overflow(), { root: 0, main: 0 }, `page in ${scheme}`);
        await card.getByRole("button", { name: /^Open / }).click();
        const sheet = page.getByRole("dialog");
        await sheet.getByRole("textbox", { name: "Title" }).waitFor();
        const sheetOverflow = await sheet.evaluate(el => el.scrollWidth - el.clientWidth);
        assert.equal(sheetOverflow, 0, `sheet in ${scheme}`);
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached" });
      }
    },
  ));

test("an idea takes pictures (added, or pasted on a phone's picker) and links, shown in its preview", () =>
  withApp(
    {
      viewport: { width: 390, height: 844 },
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO ideas (user_id, title, body, state, position, created_at, updated_at) VALUES (1, 'Scanner view', 'See [the spec](https://example.com/spec).', 'raw', 0, ?, ?)", now, now);
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/ideas");
      await page.getByRole("button", { name: "Open Scanner view" }).click();
      const sheet = page.getByRole("dialog");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), sheet.getByRole("button", { name: "Add image" }).click()]);
      await chooser.setFiles({ name: "shelf.png", mimeType: "image/png", buffer: png });
      for (let i = 0; i < 50 && !/idea-file:\d+/.test((await db.q("SELECT body FROM ideas"))[0].body); i++) await new Promise(r => setTimeout(r, 100));
      assert.match((await db.q("SELECT body FROM ideas"))[0].body, /^See \[the spec\]\(https:\/\/example\.com\/spec\)\.\n!\[shelf\.png\]\(idea-file:\d+\)\n$/);
      await sheet.getByRole("radio", { name: "Preview" }).click();
      const img = sheet.getByRole("img", { name: "shelf.png" });
      await img.waitFor();
      await img.evaluate(el => (el.complete ? null : new Promise(r => el.addEventListener("load", r, { once: true }))));
      assert.ok(await img.evaluate(el => el.naturalWidth > 0), "the picture loads");
      await sheet.getByText("the spec", { exact: true }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow: ${overflow}`);
    }
  ));
