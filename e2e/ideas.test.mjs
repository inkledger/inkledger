// Ideas in triage (docs/work/ideas/triage.md): a pasted list, moves by drag and by keyboard
// (Ready is earned), the palette's "New idea", and the page and its sheet at 320 px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

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
