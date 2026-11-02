// The Desk (/issues/desk): issues side by side in an arrangement, dividers between them, the
// desk kept across reloads, its keys, parking and maximize, and the phone's tabs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

const pane = key => ({ connectionId: 1, key, remoteId: key });
const seedDesk = (keys, more = {}) => db =>
  db.q(
    "INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)",
    JSON.stringify({ v: 1, preset: keys.length === 2 ? "cols-2" : "single", tracks: {}, panes: keys.map(pane), parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null, ...more }),
  );

/** "Add issue" (the first one shown), then the issue picked in the picker. */
async function addIssue(page, key) {
  await page.getByRole("button", { name: "Add issue" }).first().click();
  await page.getByPlaceholder("Search an issue to add…").fill(key);
  await page.getByRole("option", { name: new RegExp(`^${key} `) }).click();
  await page.locator(`[data-desk-pane="1:${key}"]`).waitFor();
}

const boxes = page => page.locator("section[data-desk-pane]:visible").evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
const storedDesk = async db => JSON.parse((await db.q("SELECT layout FROM desks WHERE user_id = 1 AND name IS NULL"))[0]?.layout ?? "null");

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () =>
    (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
      .filter(v => v.impact === "serious" || v.impact === "critical")
      .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
  );
}

test("desk: empty, two issues side by side, another layout, a divider by keyboard, kept on reload", () =>
  withApp({ viewport: { width: 1280, height: 800 } }, async ({ page, base, db }) => {
    await page.goto(base + "/issues/desk");
    await page.getByText("Your desk is empty").waitFor();
    assert.equal(await page.getByRole("separator").count(), 0);

    await addIssue(page, "DEMO-101");
    await addIssue(page, "DEMO-102");
    let [a, b] = await boxes(page);
    assert.ok(Math.abs(a.top - b.top) < 2 && b.left >= a.right - 2, `side by side: ${JSON.stringify([a, b])}`);
    assert.match(await page.title(), /Desk \(2\)/);

    // Another arrangement, from the Layout picker.
    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("button", { name: "One above the other" }).click();
    await page.keyboard.press("Escape");
    [a, b] = await boxes(page);
    assert.ok(Math.abs(a.left - b.left) < 2 && b.top >= a.bottom - 2, `stacked: ${JSON.stringify([a, b])}`);

    // Back side by side; the divider moves by keyboard (2% a press).
    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("button", { name: "Side by side" }).click();
    await page.keyboard.press("Escape");
    const divider = page.getByRole("separator", { name: "Resize between DEMO-101 and DEMO-102" });
    assert.equal(await divider.getAttribute("aria-valuenow"), "50");
    const before = (await boxes(page))[0].width;
    await divider.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await divider.getAttribute("aria-valuenow"), "56");
    assert.ok((await boxes(page))[0].width > before + 30, "the first pane grew");

    // Saved after a moment of quiet: a reload brings the same arrangement and sizes.
    await page.waitForTimeout(800);
    assert.equal((await storedDesk(db)).preset, "cols-2");
    await page.reload();
    await page.getByRole("separator", { name: "Resize between DEMO-101 and DEMO-102" }).waitFor();
    assert.equal(await page.getByRole("separator").getAttribute("aria-valuenow"), "56");

    // 2 focuses the second pane, x closes it.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("2");
    await page.locator('[data-desk-pane="1:DEMO-102"][aria-current="true"]').waitFor();
    await page.keyboard.press("x");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor({ state: "detached" });
    assert.equal((await boxes(page)).length, 1);
  }));

test("desk: a seventh issue parks one; maximize keeps the others' scroll, Esc restores", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102"]) }, async ({ page, base, db }) => {
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor();
    for (const key of ["DEMO-103", "DEMO-104", "DEMO-105", "DEMO-106", "DEMO-107"]) await addIssue(page, key);
    assert.equal((await boxes(page)).length, 6);
    const tray = page.getByRole("button", { name: "Show DEMO-106 in place of the focused pane" });
    await tray.waitFor();
    await page.getByText("DEMO-107 added to the desk; DEMO-106 was parked").first().waitFor();
    await page.waitForTimeout(800);
    const stored = await storedDesk(db);
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104", "DEMO-105", "DEMO-107"]);
    assert.deepEqual(stored.parked.map(p => p.key), ["DEMO-106"]);
    assert.equal(stored.preset, "grid-3x2");

    // Scrolled down in the first pane, the second maximized, then restored: the first is where it was.
    const first = page.locator('[data-desk-pane="1:DEMO-101"] [data-pane-size]');
    await first.evaluate(el => (el.scrollTop = 200));
    const scrolled = await first.evaluate(el => el.scrollTop);
    assert.ok(scrolled > 50, "the pane scrolls");
    await page.getByRole("button", { name: "More actions on DEMO-102" }).click();
    await page.getByRole("menuitem", { name: "Maximize" }).click();
    await page.waitForFunction(() => document.querySelectorAll("section[data-desk-pane]:not([hidden])").length === 1);
    const [only] = await boxes(page);
    assert.ok(only.width > 900, `the maximized pane fills the desk (${only.width}px)`);
    await page.getByRole("menu").waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll("section[data-desk-pane]:not([hidden])").length === 6);
    assert.equal(await first.evaluate(el => el.scrollTop), scrolled, "its scroll survived");

    // The parked chip comes back in place of the focused pane.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("3");
    await tray.click();
    await page.locator('[data-desk-pane="1:DEMO-104"]').waitFor();
    await page.locator('[data-desk-pane="1:DEMO-103"]').waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Show DEMO-103 in place of the focused pane" }).waitFor();
  }));

test("desk on a phone: tabs switch the issue shown, nothing overflows; axe clean in both themes", () =>
  withApp({ viewport: { width: 390, height: 844 }, seed: seedDesk(["DEMO-101", "DEMO-102"]) }, async ({ page, base }) => {
    await page.goto(base + "/issues/desk");
    const tabs = page.getByRole("tablist", { name: "Issues on the desk" });
    await tabs.waitFor();
    assert.equal(await page.getByRole("separator").count(), 0, "no dividers on a phone");
    await page.locator('[data-desk-pane="1:DEMO-101"]').getByText("Test task number 1").first().waitFor();
    assert.equal(await page.locator('[data-desk-pane="1:DEMO-102"]').isVisible(), false);
    await tabs.getByRole("tab", { name: "DEMO-102" }).click();
    await page.locator('[data-desk-pane="1:DEMO-102"]').getByText("Test task number 2").first().waitFor();
    assert.equal(await page.locator('[data-desk-pane="1:DEMO-101"]').isVisible(), false);
    // Arrows move between tabs.
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tabs.getByRole("tab", { name: "DEMO-101" }).getAttribute("aria-selected"), "true");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(200);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `no sideways scroll at ${width}px (${over}px)`);
    }
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      await page.setViewportSize({ width, height });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await page.waitForTimeout(800);
        assert.deepEqual(await axeViolations(page), [], `axe at ${width}px, ${colorScheme}`);
      }
    }
  }));
