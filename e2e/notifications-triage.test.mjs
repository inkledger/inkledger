import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeProcedures, withApp } from "./harness.mjs";

// The notifications page (studio/notifications/design.md): one group per issue, categories and states
// in the URL, the selected group read in the preview beside the list (over it on a narrow screen),
// done → the next one, and Back from the issue (or the detail) finds the list as it was.

/** [kind, issueKey] newest first, a minute apart. */
const seedNotes = list => async db => {
  const now = Date.now();
  let i = 0;
  for (const [kind, key] of list) {
    i++;
    await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (1, 1, ?, ?, '', ?, ?)", kind, key, `triage-${i}`, now - i * 60_000);
  }
};
const rowOf = (page, key) => page.locator(`li[data-issue-id="1:${key}"]`);
const pick = (page, key) => rowOf(page, key).locator("button[data-row-select]");
const pressed = async (page, key) => (await pick(page, key).getAttribute("aria-pressed")) === "true";
const param = (page, name) => new URL(page.url()).searchParams.get(name);
const scrollTop = page => page.evaluate(() => Math.max(document.getElementById("main")?.scrollTop ?? 0, scrollY));
async function until(fn, what) {
  for (let i = 0; i < 60; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(what);
}
const count = async (db, sql, ...args) => (await db.q(sql, ...args))[0].n;

/** Many groups: made-up issues first (newest), then the demo ones, so a demo one sits below the fold. */
const MANY = [
  ...Array.from({ length: 22 }, (_, i) => [i % 3 === 0 ? "status" : "commented", `ZZZ-${i + 1}`]),
  ...Array.from({ length: 12 }, (_, i) => [i % 2 === 0 ? "commented" : "status", `DEMO-${101 + i}`]),
];

test("notifications: a group opens in the preview, read; done moves on to the next one", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 1440, height: 900 }, seed: seedNotes([["commented", "DEMO-101"], ["status", "DEMO-101"], ["commented", "DEMO-101"], ["mentioned", "DEMO-102"], ["assigned", "DEMO-103"]]) }, async ({ page, base, db }) => {
    await page.goto(base + "/notifications");
    const row = rowOf(page, "DEMO-101");
    await row.getByText("2 comments · 1 status change").waitFor();
    // Categories count the notifications.
    await page.getByRole("radio", { name: "All 5" }).waitFor();
    await page.getByRole("radio", { name: "Comments 2" }).waitFor();
    await pick(page, "DEMO-101").click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("heading", { name: "Test task number 1" }).first().waitFor();
    assert.equal(param(page, "sel"), "1:DEMO-101");
    await until(async () => (await count(db, "SELECT count(*)::int AS n FROM notifications WHERE issue_key = 'DEMO-101' AND read_at IS NOT NULL")) === 3, "opened = read");
    // Read while looked at, it stays under "Unread".
    assert.ok(await row.isVisible(), "the read group stays in place");
    await preview.getByRole("button", { name: /^Done/ }).click();
    await preview.getByRole("heading", { name: "Test task number 2" }).first().waitFor();
    assert.ok(await pressed(page, "DEMO-102"), "the next group is selected");
    await row.waitFor({ state: "detached" });
    await until(async () => (await count(db, "SELECT count(*)::int AS n FROM notifications WHERE issue_key = 'DEMO-101' AND dismissed_at IS NOT NULL")) === 3, "done = dismissed");
    // Done ones are a state of their own, and come back.
    await page.getByRole("radio", { name: "Done" }).click();
    await pick(page, "DEMO-101").waitFor();
  }));

test("notifications: the issue's page and Back restore category, selection and scroll", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 1440, height: 800 }, seed: seedNotes(MANY) }, async ({ page, base }) => {
    await page.goto(base + "/notifications");
    await page.getByRole("radio", { name: /^Comments \d+$/ }).click();
    await until(async () => param(page, "cat") === "comments", "category in the URL");
    const target = pick(page, "DEMO-111");
    await target.scrollIntoViewIfNeeded();
    await target.click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("heading", { name: "Test task number 11" }).first().waitFor();
    const before = await scrollTop(page);
    assert.ok(before > 100, `the list is scrolled (${before})`);
    await preview.getByRole("button", { name: "Open issue" }).click();
    await page.waitForURL(/\/issues\/(1\/)?DEMO-111/);
    await page.getByRole("heading", { name: /Test task number 11/ }).first().waitFor();
    await page.goBack();
    await page.waitForURL(/\/notifications/);
    assert.equal(param(page, "cat"), "comments");
    assert.equal(param(page, "sel"), "1:DEMO-111");
    await until(async () => (await pick(page, "DEMO-111").isVisible()) && (await pressed(page, "DEMO-111")), "the selection is back");
    await until(async () => Math.abs((await scrollTop(page)) - before) < 4, `the scroll is back (${before})`);
    await preview.getByRole("heading", { name: "Test task number 11" }).first().waitFor();
  }));

test("notifications: j / k, u, e, Esc and Enter from the keyboard", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 1440, height: 900 }, seed: seedNotes([["commented", "DEMO-101"], ["mentioned", "DEMO-102"], ["status", "DEMO-103"]]) }, async ({ page, base, db }) => {
    await page.goto(base + "/notifications");
    await pick(page, "DEMO-101").waitFor();
    await page.keyboard.press("j");
    await until(() => pressed(page, "DEMO-101"), "j selects the first");
    await page.keyboard.press("j");
    await until(() => pressed(page, "DEMO-102"), "j moves on");
    await page.keyboard.press("k");
    await until(() => pressed(page, "DEMO-101"), "k moves back");
    await until(async () => (await count(db, "SELECT count(*)::int AS n FROM notifications WHERE issue_key = 'DEMO-101' AND read_at IS NOT NULL")) === 1, "read once shown");
    await page.keyboard.press("u");
    await until(async () => (await count(db, "SELECT count(*)::int AS n FROM notifications WHERE issue_key = 'DEMO-101' AND read_at IS NULL")) === 1, "u: unread again");
    await page.waitForTimeout(500);
    assert.equal(await count(db, "SELECT count(*)::int AS n FROM notifications WHERE issue_key = 'DEMO-101' AND read_at IS NULL"), 1, "not read back while still shown");
    await page.keyboard.press("e");
    await until(() => pressed(page, "DEMO-102"), "e: done, on to the next");
    await until(async () => (await count(db, "SELECT count(*)::int AS n FROM notifications WHERE dismissed_at IS NOT NULL")) === 1, "e dismisses");
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator("button[data-row-select][aria-pressed=true]").count()) === 0, "Esc: back to the list");
    await page.keyboard.press("j");
    await until(() => pressed(page, "DEMO-102"), "j again");
    // Enter on the row's own button (focused by a click) opens the issue too.
    await pick(page, "DEMO-102").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/issues\/(1\/)?DEMO-102/);
  }));

test("notifications on a phone: the detail replaces the list, next / previous, Back to the same place", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 390, height: 844 }, seed: seedNotes(MANY) }, async ({ page, base }) => {
    await page.goto(base + "/notifications");
    const target = pick(page, "DEMO-105");
    await target.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);
    const before = await scrollTop(page);
    assert.ok(before > 100, `the list is scrolled (${before})`);
    await target.click();
    await until(async () => param(page, "detail") !== null, "the detail is an entry of its own");
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("heading", { name: "Test task number 5" }).first().waitFor();
    assert.equal(await target.isVisible(), false, "the list makes room for the detail");
    await preview.getByRole("button", { name: "Next" }).click();
    await preview.getByRole("heading", { name: "Test task number 6" }).first().waitFor();
    await preview.getByRole("button", { name: "Notifications" }).click();
    await until(() => pressed(page, "DEMO-106"), "back on the list, the one last read selected");
    assert.equal(param(page, "detail"), null);
    await until(async () => Math.abs((await scrollTop(page)) - before) < 80, `about where it was (${before})`);
    // The browser's Back does the same, to the pixel.
    await page.waitForTimeout(300);
    const there = await scrollTop(page);
    await pick(page, "DEMO-106").click();
    await preview.getByRole("heading", { name: "Test task number 6" }).first().waitFor();
    await page.goBack();
    await until(async () => (await pick(page, "DEMO-106").isVisible()) && (await pressed(page, "DEMO-106")), "selection kept");
    await until(async () => Math.abs((await scrollTop(page)) - there) < 4, `scroll kept (${there})`);
    // A detail whose group is gone (done elsewhere, Forward after Done) shows the list, not an empty page.
    await page.goto(base + "/notifications?sel=1:NOPE-1&detail");
    await pick(page, "DEMO-101").waitFor();
    await page.getByRole("radiogroup", { name: "Category" }).waitFor();
  }));

test("notifications: the preview says what happened (the comment, from → to, who), the issue folded below", { timeout: 180_000 }, () =>
  withApp({
    viewport: { width: 1440, height: 900 },
    seed: async db => {
      const now = Date.now();
      const rows = [
        ["commented", "", "c1:commented:DEMO-101:c-77", 1, null],
        ["status", "Da fare → In corso", "c1:status:DEMO-101:h-9", 2, null],
        ["mentioned", "Lotto 42", "c1:inbox:t-1:1", 3, now],
        ["assigned", "", "c1:assigned:DEMO-101:1", 4, null],
      ];
      for (const [kind, detail, dedupe, i, read] of rows)
        await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at, read_at) VALUES (1, 1, ?, 'DEMO-101', ?, ?, ?, ?)", kind, detail, dedupe, now - i * 60_000, read);
    },
  }, async ({ page, base }) => {
    const para = v => ({ t: "p", c: [{ t: "text", v }] });
    const at = Date.now() - 30 * 60_000;
    await fakeProcedures(page, {
      "issues.comments": [
        { id: "c-78", author: "Bea Neri", isMine: false, body: "Prima frase. Puoi vedere @mrossi il lotto? Grazie.", doc: { v: 1, blocks: [para("Prima frase. Puoi vedere @mrossi il lotto? Grazie.")] }, created: new Date(at + 60_000).toISOString(), edited: false },
        { id: "c-77", author: "Anna Bianchi", isMine: false, body: "Riga 1", doc: { v: 1, blocks: Array.from({ length: 12 }, (_, i) => para(`Riga ${i + 1} del commento sul lotto.`)) }, created: new Date(at).toISOString(), edited: false },
      ],
      "issues.history": {
        reason: null,
        events: [
          { kind: "change", at, author: "Carlo Verdi", items: [{ field: "Status", key: "status", from: "Da fare", to: "In corso" }] },
          { kind: "change", at: at - 60_000, author: "Dario", items: [{ field: "Assignee", key: "assignee", from: "Luca Neri", to: "Mario Rossi" }] },
        ],
      },
    });
    await page.goto(base + "/notifications?state=read");
    await page.getByRole("radio", { name: /^Unread/ }).click();
    // Read and unread rows start at the same edge; only unread ones have the dot.
    await page.getByRole("button", { name: "Show all 4 on DEMO-101" }).click();
    const items = rowOf(page, "DEMO-101").locator("ul > li");
    await items.first().waitFor();
    const lefts = await items.evaluateAll(lis => lis.map(li => ({ unread: li.dataset.unread === "true", x: Math.round(li.querySelector(".truncate").getBoundingClientRect().left), dots: li.querySelectorAll(".rounded-full").length })));
    assert.equal(new Set(lefts.map(l => l.x)).size, 1, `one left edge: ${JSON.stringify(lefts)}`);
    for (const l of lefts) assert.equal(l.dots, l.unread ? 1 : 0, `dot only when unread: ${JSON.stringify(lefts)}`);
    assert.ok(lefts.some(l => !l.unread) && lefts.some(l => l.unread), "both kinds shown");
    await pick(page, "DEMO-101").click();
    const happened = page.getByRole("region", { name: "What happened" });
    // The comment itself, clamped, with its author; "Show all" opens the rest in place.
    await happened.getByText("Riga 1 del commento sul lotto.").waitFor();
    await happened.getByText("Anna Bianchi").waitFor();
    const hidden = () => happened.getByText("Riga 12 del commento sul lotto.").evaluate(el => {
      const box = el.closest(".line-clamp-6");
      return !!box && el.getBoundingClientRect().top >= box.getBoundingClientRect().bottom - 1;
    });
    assert.ok(await hidden(), "clamped: the last line is past the box");
    await happened.getByRole("button", { name: "Show all" }).click();
    await happened.getByText("Riga 12 del commento sul lotto.").waitFor();
    // The status change and the assignment: from → to, and who.
    await happened.getByText("Da fare", { exact: true }).waitFor();
    await happened.getByText("In corso", { exact: true }).waitFor();
    await happened.getByText("Carlo Verdi").waitFor();
    await happened.getByText("Luca Neri", { exact: true }).waitFor();
    await happened.getByText("Mario Rossi", { exact: true }).waitFor();
    // The mention: the sentence around it, not the whole comment.
    await happened.getByText("Puoi vedere @mrossi il lotto?", { exact: true }).waitFor();
    // The issue is folded below until asked for.
    const details = page.getByRole("button", { name: "Issue details" });
    assert.equal(await details.getAttribute("aria-expanded"), "false");
    await details.click();
    assert.equal(await details.getAttribute("aria-expanded"), "true");
    await page.getByRole("complementary", { name: "Preview" }).getByText("Project", { exact: true }).waitFor();
    // One "done" mark everywhere: ✓, named Done.
    for (const b of await rowOf(page, "DEMO-101").getByRole("button", { name: /^Done/ }).all()) assert.ok(await b.locator("svg.lucide-check").count(), "a check");
  }));
