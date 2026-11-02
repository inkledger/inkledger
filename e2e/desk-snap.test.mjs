// The Desk's snapping: a pane dragged by its grip to an edge, a corner or another pane, or moved
// by keyboard (Space, arrows, Enter), from its menu ("Move to"), or with Alt+Shift+arrows; Esc
// puts it back; the live region says each place; a moved pane keeps its scroll.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

const pane = key => ({ connectionId: 1, key, remoteId: key });
const layout = (keys, preset) => ({ v: 1, preset, tracks: {}, panes: keys.map(pane), parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null });
const seedDesk = (keys, preset) => db =>
  db.q("INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)", JSON.stringify(layout(keys, preset)));
const storedDesk = async db => JSON.parse((await db.q("SELECT layout FROM desks WHERE user_id = 1 AND name IS NULL"))[0]?.layout ?? "null");
const shown = page => page.locator("section[data-desk-pane]").evaluateAll(els => els.map(el => el.dataset.deskPane.split(":")[1]));
/** The panes in reading order on screen (top to bottom, then left to right). */
const onScreen = page =>
  page.locator("section[data-desk-pane]").evaluateAll(els =>
    els
      .map(el => ({ key: el.dataset.deskPane.split(":")[1], box: el.getBoundingClientRect() }))
      .sort((a, b) => Math.round(a.box.top) - Math.round(b.box.top) || a.box.left - b.box.left)
      .map(p => p.key),
  );
const live = page => page.locator("[data-desk-live]").textContent();
const gridBox = page => page.locator("section[data-desk-pane]").first().locator("xpath=..").boundingBox();

async function open(page, base, keys) {
  await page.goto(base + "/issues/desk");
  for (const key of keys) await page.locator(`[data-desk-pane="1:${key}"]`).getByText(/Test task|Test favorite/).first().waitFor();
}

/** Presses the grip of `key` and moves the pointer to (x, y) in steps, without letting go. */
async function dragTo(page, key, x, y) {
  const grip = await page.getByRole("button", { name: `Move ${key}` }).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 10, grip.y + grip.height / 2 + 10, { steps: 2 });
  await page.mouse.move(x, y, { steps: 8 });
}

test("snap: a pane dragged to the right edge takes the right half; axe clean with the overlay shown", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102"], "cols-2") }, async ({ page, base, db }) => {
    await open(page, base, ["DEMO-101", "DEMO-102"]);
    const grid = await gridBox(page);
    await dragTo(page, "DEMO-101", grid.x + grid.width - 15, grid.y + grid.height / 2);
    await page.locator("[data-snap-overlay]").getByText("Right half").waitFor();
    assert.equal(await live(page), "DEMO-101: right half");
    // The snap bar offers both arrangements for two panes, the place under the pointer filled.
    assert.equal(await page.locator("[data-snap-overlay] [data-snap-preset]").count(), 4);
    assert.equal(await page.locator('[data-snap-dragging][data-desk-pane="1:DEMO-101"]').count(), 1);
    await page.waitForTimeout(400);
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
    );
    assert.deepEqual(violations, []);
    await page.mouse.up();
    await page.locator("[data-snap-overlay]").waitFor({ state: "detached" });
    assert.deepEqual(await onScreen(page), ["DEMO-102", "DEMO-101"]);
    assert.equal(await live(page), "DEMO-101 dropped: right half");
    await page.waitForTimeout(500);
    const stored = await storedDesk(db);
    assert.equal(stored.preset, "cols-2");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-102", "DEMO-101"]);
  }));

test("snap: with three, the left edge makes the dragged pane the big one; with four, a corner is a quarter", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102", "DEMO-103"], "cols-3") }, async ({ page, base, db }) => {
    await open(page, base, ["DEMO-101", "DEMO-102", "DEMO-103"]);
    let grid = await gridBox(page);
    await dragTo(page, "DEMO-103", grid.x + 15, grid.y + grid.height / 2);
    await page.locator("[data-snap-overlay]").getByText("Big on the left").waitFor();
    await page.mouse.up();
    await page.waitForTimeout(500);
    let stored = await storedDesk(db);
    assert.equal(stored.preset, "main-left");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-103", "DEMO-101", "DEMO-102"]);
    const big = await page.locator('[data-desk-pane="1:DEMO-103"]').boundingBox();
    assert.ok(big.height > grid.height - 4 && big.x < grid.x + 4, `big on the left: ${JSON.stringify(big)}`);

    // A slot of the snap bar: exactly that place of that arrangement.
    await dragTo(page, "DEMO-101", grid.x + grid.width / 2, grid.y + grid.height / 2);
    await page.waitForTimeout(300);
    const slot = await page.locator('[data-snap-overlay] [data-snap-preset="main-top"][data-snap-slot="2"]').boundingBox();
    await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2, { steps: 4 });
    await page.locator("[data-snap-overlay]").getByText("Bottom right corner, with the big one on top").waitFor();
    await page.mouse.up();
    await page.waitForTimeout(500);
    stored = await storedDesk(db);
    assert.equal(stored.preset, "main-top");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-103", "DEMO-102", "DEMO-101"]);

    await db.q("UPDATE desks SET layout = ? WHERE user_id = 1 AND name IS NULL", JSON.stringify(layout(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104"], "quad")));
    await open(page, base, ["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104"]);
    grid = await gridBox(page);
    await dragTo(page, "DEMO-101", grid.x + grid.width - 15, grid.y + grid.height - 15);
    await page.locator("[data-snap-overlay]").getByText("Bottom right corner").waitFor();
    await page.mouse.up();
    await page.waitForTimeout(500);
    stored = await storedDesk(db);
    assert.equal(stored.preset, "quad");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-102", "DEMO-103", "DEMO-104", "DEMO-101"]);
    assert.deepEqual(await onScreen(page), ["DEMO-102", "DEMO-103", "DEMO-104", "DEMO-101"]);
  }));

test("snap: over the middle of another pane they swap, and the moved pane keeps its scroll; Esc puts one back", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102", "DEMO-103"], "main-left") }, async ({ page, base, db }) => {
    await open(page, base, ["DEMO-101", "DEMO-102", "DEMO-103"]);
    // Every pane scrolled a little: whichever the page moves, none may lose its place.
    const scrollers = page.locator("section[data-desk-pane] [data-pane-size]");
    const scrollTops = () => scrollers.evaluateAll(els => Object.fromEntries(els.map(el => [el.closest("section").dataset.deskPane, el.scrollTop])));
    await scrollers.evaluateAll(els => els.forEach((el, i) => (el.scrollTop = 60 + 40 * i)));
    const scrolled = await scrollTops();
    assert.ok(scrolled["1:DEMO-103"] > 50 && scrolled["1:DEMO-102"] > 50, `the panes scroll: ${JSON.stringify(scrolled)}`);
    const before = await storedDesk(db);

    // Esc in the middle of a drag: nothing moves, nothing is saved.
    const grid = await gridBox(page);
    await dragTo(page, "DEMO-101", grid.x + grid.width - 15, grid.y + grid.height / 2);
    await page.locator("[data-snap-overlay]").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("[data-snap-overlay]").waitFor({ state: "detached" });
    await page.mouse.up();
    assert.equal(await live(page), "DEMO-101: move cancelled");
    await page.waitForTimeout(600);
    assert.deepEqual(await storedDesk(db), before);
    assert.deepEqual(await shown(page), ["DEMO-101", "DEMO-102", "DEMO-103"]);
    assert.equal(await page.locator("[data-drag-ghost]").count(), 0, "no picture left behind");

    const target = await page.locator('[data-desk-pane="1:DEMO-103"]').boundingBox();
    await dragTo(page, "DEMO-101", target.x + target.width / 2, target.y + target.height / 2);
    await page.locator("[data-snap-overlay]").getByText("In place of DEMO-103").waitFor();
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.deepEqual((await storedDesk(db)).panes.map(p => p.key), ["DEMO-103", "DEMO-102", "DEMO-101"]);
    const moved = await page.locator('[data-desk-pane="1:DEMO-103"]').boundingBox();
    assert.ok(moved.height > grid.height - 4, "DEMO-103 is the big one now");
    assert.deepEqual(await scrollTops(), scrolled, "every pane kept its scroll");
  }));

test("snap by keyboard: Space picks up, arrows say each place, Enter drops, the focus stays on the grip", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102"], "cols-2") }, async ({ page, base, db }) => {
    await open(page, base, ["DEMO-101", "DEMO-102"]);
    const grip = page.getByRole("button", { name: "Move DEMO-101" });
    await grip.focus();
    await page.keyboard.press("Space");
    assert.match(await live(page), /^DEMO-101 picked up/);
    await page.locator("[data-snap-overlay]").getByText("Left half").waitFor();
    for (let i = 0; i < 6 && (await live(page)) !== "DEMO-101: right half"; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await live(page), "DEMO-101: right half");
    await page.keyboard.press("Enter");
    await page.locator("[data-snap-overlay]").waitFor({ state: "detached" });
    assert.deepEqual(await onScreen(page), ["DEMO-102", "DEMO-101"]);
    assert.equal(await live(page), "DEMO-101 dropped: right half");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-snap-grip") === "1:DEMO-101");

    // Space again, around to the top half, then Esc: back where it was.
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    assert.equal(await live(page), "DEMO-101: top half");
    await page.keyboard.press("Escape");
    assert.equal(await live(page), "DEMO-101: move cancelled");
    await page.waitForTimeout(500);
    const stored = await storedDesk(db);
    assert.equal(stored.preset, "cols-2");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-102", "DEMO-101"]);
  }));

test("snap from the pane menu (Move to) and with Alt+Shift+arrows, which never goes back in history", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102"], "cols-2") }, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    await page.locator('aside a[href="/issues/desk"]').click();
    await page.waitForURL(u => u.pathname === "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').getByText("Test task number 2").first().waitFor();
    // The pane is named by its key and title.
    await page.getByRole("region", { name: "DEMO-101 · Test task number 1" }).waitFor();

    await page.getByRole("button", { name: "More actions on DEMO-101" }).click();
    await page.getByRole("menuitem", { name: "Move to" }).click();
    await page.getByRole("menuitem", { name: "Bottom half" }).click();
    await page.waitForTimeout(500);
    let stored = await storedDesk(db);
    assert.equal(stored.preset, "rows-2");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-102", "DEMO-101"]);
    assert.equal(await live(page), "DEMO-101 moved: bottom half");

    // Swap with the other one, from the same menu.
    await page.getByRole("button", { name: "More actions on DEMO-101" }).click();
    await page.getByRole("menuitem", { name: "Move to" }).click();
    await page.getByRole("menuitem", { name: "Swap with DEMO-102" }).click();
    await page.waitForTimeout(500);
    assert.deepEqual((await storedDesk(db)).panes.map(p => p.key), ["DEMO-101", "DEMO-102"]);

    // The second pane focused, Alt+Shift+← sends it to the left half; the page stays.
    await page.getByRole("menu").waitFor({ state: "detached" });
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("2");
    await page.locator('[data-desk-pane="1:DEMO-102"][aria-current="true"]').waitFor();
    await page.keyboard.press("Alt+Shift+ArrowLeft");
    await page.waitForTimeout(500);
    assert.equal(new URL(page.url()).pathname, "/issues/desk");
    stored = await storedDesk(db);
    assert.equal(stored.preset, "cols-2");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-102", "DEMO-101"]);
    assert.equal(await live(page), "DEMO-102 moved: left half");
    // Still the focused one: Alt+Shift+↓ sends it to the bottom.
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await page.waitForTimeout(500);
    stored = await storedDesk(db);
    assert.equal(stored.preset, "rows-2");
    assert.deepEqual(stored.panes.map(p => p.key), ["DEMO-101", "DEMO-102"]);
  }));
