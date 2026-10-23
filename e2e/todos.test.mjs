// The TODO list: "d", the hot corner, quick capture, the list's own keys,
// and where it lives (Settings → TODO).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProcedures, start } from "./harness.mjs";

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
    // The field stays ready: the next one is typed at once.
    await page.keyboard.type("And another");
    await page.keyboard.press("Enter");
    await float.getByRole("listitem", { name: "And another" }).waitFor();
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
      await float.getByRole("listitem", { name: "second" }).waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT due_on FROM todos WHERE text = 'second'"))[0].due_on, inDays(0));
      // The focus stays in the list, on the row that took its place: the next key goes on.
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "third");
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
    await page.mouse.move(width / 2, height / 2);
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

test("from a comment, a private note, a card's menu: each TODO tied to it, and its link leads back", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO issue_notes (user_id, connection_id, issue_key, body, created_at, updated_at) VALUES (1, 1, 'DEMO-101', ?, ?, ?)", "Try the staging DB first\nthen prod", now, now);
      },
    },
    async ({ page, base, db }) => {
      await fakeProcedures(page, {
        "issues.comments": [
          {
            id: "10042",
            author: "Anna Bianchi",
            isMine: false,
            body: "Can you check the logs?\nThanks",
            doc: { v: 1, blocks: [{ t: "p", c: [{ t: "text", v: "Can you check the logs? Thanks" }] }] },
            created: new Date().toISOString(),
            edited: false,
          },
        ],
      });
      await page.goto(base + "/issues/DEMO-101");
      // From the comment: its first line, today, tied to it.
      await page.getByRole("button", { name: "Make a TODO from this comment" }).click();
      const field = page.getByRole("dialog").getByRole("textbox", { name: "New TODO" });
      assert.equal(await field.inputValue(), "Can you check the logs?");
      await page.keyboard.press("Enter");
      await page.getByText("TODO added: Can you check the logs?").waitFor();
      await page.getByRole("button", { name: "Make a TODO from this comment (1 TODO already)" }).waitFor();
      // From the private note.
      await page.getByRole("button", { name: "Make a TODO from this note" }).click();
      await page.getByRole("dialog").getByRole("radio", { name: "Tomorrow" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Add TODO" }).click();
      await page.getByRole("button", { name: "Make a TODO from this note (1 TODO already)" }).waitFor();
      const rows = await db.q("SELECT text, issue_key, comment_id, comment_excerpt, issue_note_id IS NOT NULL AS on_note, due_on FROM todos ORDER BY id");
      assert.deepEqual(rows.map(r => [r.text, r.issue_key, r.comment_id, r.on_note]), [
        ["Can you check the logs?", "DEMO-101", "10042", false],
        ["Try the staging DB first", "DEMO-101", null, true],
      ]);
      assert.equal(rows[0].comment_excerpt, "Can you check the logs?");
      // The issue's own TODO list shows both.
      const issueList = page.getByRole("list", { name: "This issue's TODOs" });
      await issueList.getByRole("listitem", { name: "Can you check the logs?" }).waitFor();
      await issueList.getByRole("listitem", { name: "Try the staging DB first" }).waitFor();
      // A card's menu: "Add a TODO…".
      await page.goto(base + "/board");
      const card = page.locator("[draggable=true]", { hasText: "DEMO-105" }).first();
      await card.waitFor();
      await card.getByRole("button", { name: /Actions for DEMO-105/ }).click();
      await page.getByRole("menuitem", { name: "Add a TODO…" }).click();
      const dialog = page.getByRole("dialog", { name: "A TODO on DEMO-105" });
      await dialog.getByRole("textbox", { name: "New TODO" }).fill("Ask for the specs");
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT issue_key FROM todos WHERE text = 'Ask for the specs'"))[0].issue_key, "DEMO-105");
      // From the list, the comment's link: back on the issue, at the comment, marked.
      await page.keyboard.press("d");
      const float = page.getByRole("region", { name: "Floating TODO list" });
      await float.getByRole("listitem", { name: "Can you check the logs?" }).getByRole("link", { name: "comment" }).click();
      await page.waitForURL(/\/issues\/DEMO-101.*#comment-10042$/);
      const comment = page.locator("#comment-10042");
      await page.waitForFunction(() => document.getElementById("comment-10042")?.hasAttribute("data-flash"));
      const box = await comment.boundingBox();
      const { height } = page.viewportSize();
      assert.ok(box && box.y >= 0 && box.y + box.height <= height, "the comment is in view");
    },
  ));

test("reminders: today's and late TODOs in the bell and on the Dashboard; Tomorrow moves one, Hide puts one away until tomorrow", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        const add = (text, due) => db.q("INSERT INTO todos (user_id, text, due_on, position, created_at, updated_at) VALUES (1, ?, ?, 0, ?, ?)", text, due, now, now);
        await add("Send the invoice", inDays(-2));
        await add("Review PR", inDays(0));
        await add("Later thing", inDays(3));
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/");
      // Once a day: a toast says how many.
      await page.getByText("2 TODOs for today").waitFor();
      // The Dashboard's card.
      const card = page.getByRole("list", { name: "To do today" });
      await card.getByRole("listitem", { name: "Send the invoice" }).waitFor();
      await card.getByRole("listitem", { name: "Review PR" }).waitFor();
      // The bell counts them.
      const bell = page.getByRole("button", { name: "Notifications, 2 to review" }).first();
      await bell.click();
      const center = page.getByRole("dialog");
      const reminders = center.getByRole("region", { name: "To do today" });
      await reminders.getByRole("listitem", { name: "Send the invoice" }).waitFor();
      await reminders.getByRole("listitem", { name: "Review PR" }).getByRole("button", { name: "Tomorrow", exact: true }).click();
      await reminders.getByRole("listitem", { name: "Review PR" }).waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT due_on FROM todos WHERE text = 'Review PR'"))[0].due_on, inDays(1));
      await reminders.getByRole("button", { name: "Hide “Send the invoice” until tomorrow" }).click();
      await reminders.waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT reminder_seen_on FROM todos WHERE text = 'Send the invoice'"))[0].reminder_seen_on, inDays(0));
      // Still open, still on today's list: only the reminder is away.
      assert.equal((await db.q("SELECT done_at FROM todos WHERE text = 'Send the invoice'"))[0].done_at, null);
      await page.keyboard.press("Escape");
      // Back later the same day: no second toast.
      await page.reload();
      await card.getByRole("listitem", { name: "Send the invoice" }).waitFor();
      await page.waitForTimeout(800);
      assert.equal(await page.getByText(/TODOs? for today/).count(), 0);
    },
  ));

test("on a phone: the header button says how many for today and opens the list; More has it too, once", () =>
  withApp(
    {
      viewport: { width: 520, height: 800 },
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO todos (user_id, text, due_on, position, created_at, updated_at) VALUES (1, 'Call the bank', ?, 0, ?, ?)", inDays(0), now, now);
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/issues");
      await page.getByRole("button", { name: "TODO list, 1 for today" }).click();
      const sheet = page.getByRole("dialog", { name: "TODO" });
      await sheet.getByRole("listitem", { name: "Call the bank" }).waitFor();
      await sheet.getByRole("textbox", { name: "New TODO" }).fill("Buy stamps @tomorrow");
      await page.keyboard.press("Enter");
      await sheet.getByRole("listitem", { name: "Buy stamps" }).waitFor();
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      // More: its page is a section there (the menu is on): one way in, no second tile.
      const more = async () => {
        await page.getByRole("navigation", { name: "Quick sections" }).getByRole("button", { name: "More" }).click();
        return page.getByRole("dialog");
      };
      let m = await more();
      await m.getByRole("link", { name: "TODO" }).waitFor();
      assert.equal(await m.getByRole("button", { name: "Open the TODO list" }).count(), 0);
      await page.keyboard.press("Escape");
      // The menu off: a tile that opens the list as a sheet.
      await db.q("UPDATE settings SET todos_in_menu = 0 WHERE user_id = 1");
      await page.reload();
      m = await more();
      assert.equal(await m.getByRole("link", { name: "TODO" }).count(), 0);
      await m.getByRole("button", { name: "Open the TODO list" }).click();
      await page.getByRole("dialog", { name: "TODO" }).getByRole("listitem", { name: "Call the bank" }).waitFor();
    },
  ));
