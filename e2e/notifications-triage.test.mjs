import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

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
