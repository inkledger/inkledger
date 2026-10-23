// The TODO list: "d", the hot corner, quick capture, the list's own keys,
// and where it lives (Settings → TODO).
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

const pad = n => String(n).padStart(2, "0");
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const inDays = n => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dayKey(d);
};

test("d opens the list, a capture with a day and an issue lands where it belongs; g d still goes home", () =>
  withApp({}, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    await page.getByRole("heading", { name: "Issues" }).first().waitFor();
    await page.keyboard.press("d");
    const float = page.getByRole("region", { name: "Floating TODO list" });
    await float.waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "not a dialog");
    const field = float.getByRole("textbox", { name: "New TODO" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "New TODO");
    await field.fill("Call Anna @tomorrow #demo-101");
    await float.getByText("DEMO-101", { exact: true }).waitFor();
    await float.getByText("Tomorrow", { exact: true }).waitFor();
    await page.keyboard.press("Enter");
    // It went to "Upcoming", and the list follows it there.
    const row = float.getByRole("listitem", { name: "Call Anna" });
    await row.waitFor();
    assert.equal(await float.getByRole("radio", { name: /^Upcoming/ }).getAttribute("aria-checked"), "true");
    await row.getByRole("link", { name: /DEMO-101 · Test task number 1/ }).waitFor();
    const [stored] = await db.q("SELECT text, due_on, issue_key FROM todos");
    assert.deepEqual(stored, { text: "Call Anna", due_on: inDays(1), issue_key: "DEMO-101" });
    // Without a day in "Today": today's.
    await float.getByRole("radio", { name: /^Today/ }).click();
    await field.fill("Write the recap");
    await page.keyboard.press("Enter");
    await float.getByRole("listitem", { name: "Write the recap" }).waitFor();
    assert.equal((await db.q("SELECT due_on FROM todos WHERE text = 'Write the recap'"))[0].due_on, inDays(0));
    // Esc empties the field first, then closes.
    await field.fill("half");
    await page.keyboard.press("Escape");
    assert.equal(await field.inputValue(), "");
    await page.keyboard.press("Escape");
    await float.waitFor({ state: "detached" });
    // "g d" is still the Dashboard, not the list.
    await page.keyboard.press("g");
    await page.keyboard.press("d");
    await page.waitForURL(base + "/");
    assert.equal(await float.count(), 0);
  }));

test("the list's keys: tick, plan, delete with Undo; the page behind gets none of them", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        for (const [i, text] of ["first", "second", "third"].entries())
          await db.q("INSERT INTO todos (user_id, text, due_on, position, created_at, updated_at) VALUES (1, ?, NULL, ?, ?, ?)", text, i, now, now);
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/issues");
      await page.getByRole("heading", { name: "Issues" }).first().waitFor();
      await page.keyboard.press("d");
      const float = page.getByRole("region", { name: "Floating TODO list" });
      await float.getByRole("radio", { name: /^Someday/ }).click();
      const first = float.getByRole("listitem", { name: "first" });
      await first.focus();
      await page.keyboard.press("j");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "second");
      // The issues list behind did not move its selection.
      assert.equal(await page.locator("[aria-selected=true], [data-selected]").count(), 0);
      await page.keyboard.press("1");
      await page.waitForFunction(() => true);
      await float.getByRole("listitem", { name: "second" }).waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT due_on FROM todos WHERE text = 'second'"))[0].due_on, inDays(0));
      await float.getByRole("listitem", { name: "third" }).focus();
      await page.keyboard.press("x");
      await page.getByText("Done: third").waitFor();
      assert.notEqual((await db.q("SELECT done_at FROM todos WHERE text = 'third'"))[0].done_at, null);
      await first.focus();
      await page.keyboard.press("Delete");
      await page.getByText("Deleted: first").waitFor();
      await page.locator("[data-sonner-toast]", { hasText: "Deleted: first" }).getByRole("button", { name: "Undo" }).click();
      await first.waitFor();
      assert.equal((await db.q("SELECT count(*)::int AS n FROM todos WHERE text = 'first'"))[0].n, 1);
    },
  ));

test("the hot corner: a rest of the pointer opens the list, a pass does not; off in Settings, nothing", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/issues");
    await page.getByRole("heading", { name: "Issues" }).first().waitFor();
    const { width, height } = page.viewportSize();
    const float = page.getByRole("region", { name: "Floating TODO list" });
    // A pass: in and straight out.
    await page.mouse.move(width - 1, height - 1);
    await page.mouse.move(width / 2, height / 2);
    await page.waitForTimeout(500);
    assert.equal(await float.count(), 0);
    // A rest.
    await page.mouse.move(width - 1, height - 1);
    await page.waitForTimeout(450);
    await float.waitFor();
    await page.keyboard.press("Escape");
    await float.waitFor({ state: "detached" });
    // Off in Settings: the corner does nothing; neither does "d" without the widget and the menu.
    await page.goto(base + "/settings/todos");
    await page.getByRole("switch", { name: "Bottom-right corner" }).click();
    await page.getByRole("switch", { name: "Floating widget" }).click();
    await page.waitForTimeout(300);
    const menuLink = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "TODO" });
    await menuLink.waitFor();
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.move(width - 1, height - 1);
    await page.waitForTimeout(450);
    assert.equal(await float.count(), 0);
    // With only the menu: "d" goes to the page.
    await page.mouse.move(width / 2, height / 2);
    await page.keyboard.press("d");
    await page.waitForURL(/\/todos$/);
    await page.getByRole("textbox", { name: "New TODO" }).waitFor();
    await page.goto(base + "/settings/todos");
    await page.getByRole("switch", { name: "In the menu" }).click();
    await menuLink.waitFor({ state: "detached" });
    await page.keyboard.press("d");
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("region", { name: /TODO/ }).count(), 0);
    assert.match(page.url(), /\/settings\/todos$/);
  }));
