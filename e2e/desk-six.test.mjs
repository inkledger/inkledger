// The Desk with up to six issues: the grids of six on a large screen (no pane over another, keys 5
// and 6), a five-pane arrangement chosen from the Layout picker, the "Move to" menu grouped by
// arrangement, Shift-click filling the sixth place (6/6), and six tabs on a 320 px phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

const pane = key => ({ connectionId: 1, key, remoteId: key });
const layout = (keys, preset) => ({ v: 1, preset, tracks: {}, panes: keys.map(pane), parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null });
const seedDesk = (keys, preset) => db =>
  db.q("INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)", JSON.stringify(layout(keys, preset)));
const storedDesk = async db => JSON.parse((await db.q("SELECT layout FROM desks WHERE user_id = 1 AND name IS NULL"))[0]?.layout ?? "null");
const keysOf = n => Array.from({ length: n }, (_, i) => `DEMO-${101 + i}`);
/** The slots shown, each with its box: an issue's key, "_" for an empty slot. */
const boxes = page =>
  page.locator("section[data-desk-pane]:visible").evaluateAll(els =>
    els.map(el => ({ key: el.dataset.deskPane.startsWith("empty-") ? "_" : el.dataset.deskPane.split(":")[1], ...el.getBoundingClientRect().toJSON() })),
  );

/** No two boxes overlap (by more than the hairline between panes), and together they fill the grid. */
async function assertTiled(page) {
  const shown = await boxes(page);
  const grid = await page.locator("[data-desk-grid]").boundingBox();
  for (const [i, a] of shown.entries())
    for (const b of shown.slice(i + 1)) {
      const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      assert.ok(overlap < 2, `${a.key} and ${b.key} overlap: ${JSON.stringify([a, b])}`);
    }
  const area = shown.reduce((sum, box) => sum + box.width * box.height, 0);
  assert.ok(area > grid.width * grid.height * 0.98, `the panes fill the desk (${Math.round(area)} of ${Math.round(grid.width * grid.height)})`);
  return shown;
}

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () =>
    (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
      .filter(v => v.impact === "serious" || v.impact === "critical")
      .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
  );
}

async function open(page, base, keys) {
  await page.goto(base + "/issues/desk");
  for (const key of keys) await page.locator(`[data-desk-pane="1:${key}"]`).getByText(/Test task|Test favorite/).first().waitFor();
}

test("six: three columns over two rows at 1920×1080, no pane over another; 5 and 6 focus the last two; axe clean in both themes", () =>
  withApp({ viewport: { width: 1920, height: 1080 }, seed: seedDesk(keysOf(6), "grid-3x2") }, async ({ page, base }) => {
    await open(page, base, keysOf(6));
    const shown = await assertTiled(page);
    assert.equal(shown.length, 6);
    // Three in a row, two rows: the first three share a top, the last three another one below.
    const tops = [...new Set(shown.map(box => Math.round(box.top)))];
    assert.equal(tops.length, 2, `two rows: ${JSON.stringify(tops)}`);
    assert.equal(shown.filter(box => Math.round(box.top) === tops[0]).length, 3);
    // A divider between each two of a row, one across.
    assert.equal(await page.getByRole("separator").count(), 3);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    for (const n of [5, 6, 1]) {
      await page.keyboard.press(String(n));
      await page.locator(`[data-desk-pane="1:DEMO-10${n}"][aria-current="true"]`).waitFor();
    }
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(500);
      assert.deepEqual(await axeViolations(page), [], `axe with six panes, ${colorScheme}`);
    }
  }));

test("six: a five-pane arrangement from the Layout picker keeps an empty slot; three above two; Move to is grouped by arrangement", () =>
  withApp({ viewport: { width: 1600, height: 900 }, seed: seedDesk(keysOf(4), "quad") }, async ({ page, base, db }) => {
    await open(page, base, keysOf(4));
    await page.getByRole("button", { name: "Layout" }).click();
    // Grouped by how many panes they hold: from four (the desk's issues) to six.
    for (const group of ["4 panes", "5 panes", "6 panes"]) await page.getByRole("group", { name: group }).waitFor();
    assert.equal(await page.getByRole("group", { name: "3 panes" }).count(), 0);
    await page.getByRole("button", { name: "Large on the left, four beside", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator("[data-empty-slot]").waitFor();
    let shown = await assertTiled(page);
    assert.deepEqual(shown.map(box => box.key), [...keysOf(4), "_"]);
    const grid = await page.locator("[data-desk-grid]").boundingBox();
    assert.ok(shown[0].height > grid.height - 4 && shown[0].left < grid.x + 4, `the first is big on the left: ${JSON.stringify(shown[0])}`);
    await page.waitForTimeout(500);
    assert.equal((await storedDesk(db)).preset, "main-left-4");

    await page.getByRole("button", { name: "Layout" }).click();
    await page.getByRole("button", { name: "Three above two", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    shown = await assertTiled(page);
    const top = shown.slice(0, 3), bottom = shown.slice(3);
    assert.ok(top.every(box => Math.abs(box.top - top[0].top) < 2) && bottom.every(box => Math.abs(box.top - bottom[0].top) < 2), "two rows");
    assert.ok(Math.abs(bottom[0].width - top[0].width * 1.5) < 4, `two below, each half the width: ${bottom[0].width} vs ${top[0].width}`);
    // The line between the two below moves them, by keyboard.
    const divider = page.getByRole("separator", { name: "Resize between DEMO-104 and empty slot" });
    await divider.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    const moved = await boxes(page);
    assert.ok(moved[3].width > bottom[0].width + 30, "the first below grew");
    assert.ok(Math.abs(moved[0].width - top[0].width) < 2, "the ones on top stayed");

    // Move to: with five places the menu groups them by arrangement.
    await page.getByRole("button", { name: "More actions on DEMO-101" }).click();
    await page.getByRole("menuitem", { name: "Move to" }).click();
    await page.getByRole("menuitem", { name: "Two above three" }).click();
    await page.getByRole("menuitem", { name: "Bottom right corner" }).click();
    await page.waitForTimeout(500);
    const stored = await storedDesk(db);
    assert.equal(stored.preset, "top-2-bottom-3");
    assert.deepEqual(stored.panes.map(p => (p.empty ? "_" : p.key)), ["DEMO-102", "DEMO-103", "DEMO-104", "_", "DEMO-101"]);
  }));

test("six: Shift-click fills the sixth place (6/6), the seventh parks one", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(keysOf(5), "main-left-4") }, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    await page.getByRole("link", { name: "DEMO-106", exact: true }).first().click({ modifiers: ["Shift"] });
    await page.getByText("DEMO-106 added to the desk (6/6)").waitFor();
    const stored = await storedDesk(db);
    assert.equal(stored.preset, "grid-3x2");
    assert.deepEqual(stored.panes.map(p => p.key), keysOf(6));
    await page.getByRole("link", { name: "DEMO-108", exact: true }).first().click({ modifiers: ["Shift"] });
    await page.getByText("DEMO-108 added to the desk; DEMO-106 was parked").waitFor();
  }));

test("six on a phone: six tabs at 320 px scroll in their row, the page never sideways; axe clean", () =>
  withApp({ viewport: { width: 320, height: 720 }, seed: seedDesk(keysOf(6), "grid-3x2") }, async ({ page, base }) => {
    await page.goto(base + "/issues/desk");
    const tabs = page.getByRole("tablist", { name: "Issues on the desk" });
    await tabs.waitFor();
    assert.equal(await tabs.getByRole("tab").count(), 6);
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok((await over()) <= 0, `no sideways scroll (${await over()}px)`);
    // The last tab is reached in the row (the arrows move to it, and it scrolls into view).
    await tabs.getByRole("tab", { name: "DEMO-101" }).focus();
    await page.keyboard.press("End");
    const last = tabs.getByRole("tab", { name: "DEMO-106" });
    await tabs.getByRole("tab", { name: "DEMO-106", selected: true }).waitFor();
    await page.locator('[data-desk-pane="1:DEMO-106"]').getByText("Test task number 6").first().waitFor();
    const box = await last.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320, `the last tab is in view: ${JSON.stringify(box)}`);
    assert.ok((await over()) <= 0, `still no sideways scroll (${await over()}px)`);
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(500);
      assert.deepEqual(await axeViolations(page), [], `axe with six tabs, ${colorScheme}`);
    }
  }));
