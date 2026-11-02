// The Desk in the workflow: an issue's page sends itself to the desk (its title's grip dragged to
// an edge, Alt+Shift+arrows, the Layout button, a long press on a phone), the other places stay
// empty slots to open an issue in; Shift-click on an issue link opens it beside; issues dragged
// from a list or the board; several picked in Issues opened together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

const pane = key => ({ connectionId: 1, key, remoteId: key });
const layout = (keys, preset) => ({ v: 1, preset, tracks: {}, panes: keys.map(pane), parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null });
const seedDesk = (keys, preset) => db =>
  db.q("INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)", JSON.stringify(layout(keys, preset)));
const storedDesk = async db => JSON.parse((await db.q("SELECT layout FROM desks WHERE user_id = 1 AND name IS NULL"))[0]?.layout ?? "null");
/** The stored desk's slots: each issue's key, "_" for an empty slot. */
const storedShape = async db => (await storedDesk(db))?.panes.map(p => (p.empty ? "_" : p.key)) ?? [];
/** The slots on screen in reading order (top to bottom, then left to right). */
const onScreen = page =>
  page.locator("section[data-desk-pane]:visible").evaluateAll(els =>
    els
      .map(el => ({ key: el.dataset.deskPane.startsWith("empty-") ? "_" : el.dataset.deskPane.split(":")[1], box: el.getBoundingClientRect() }))
      .sort((a, b) => Math.round(a.box.top) - Math.round(b.box.top) || a.box.left - b.box.left)
      .map(p => p.key),
  );

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () =>
    (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
      .filter(v => v.impact === "serious" || v.impact === "critical")
      .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
  );
}

/**
 * Shift-click on a link of the sidebar's favorites: its short list scrolls under the rows below
 * it, where the pointer can't always reach, so the click is the event itself.
 */
const shiftClick = link => link.evaluate(a => a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true, button: 0 })));

/** The app went to the Desk (an in-app navigation: no page load to wait for). */
const onDesk = page => page.waitForFunction(() => location.pathname === "/issues/desk");

/** On the desk: another arrangement from the Layout picker, its popover closed again; one more place is an empty slot. */
async function chooseLayout(page, name) {
  await page.getByRole("button", { name: "Layout" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator("[data-radix-popper-content-wrapper]").waitFor({ state: "detached" });
  await page.locator("[data-empty-slot]").waitFor();
}

async function openIssue(page, base, key, title) {
  await page.goto(`${base}/issues/1/${key}`);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
}

/**
 * An issue dragged in from outside (a list, the board: what their rows and cards carry) over a point
 * of `selector` (a share of its box); `window.__drop()` then drops it there.
 */
const dragIn = (page, selector, key, at = { x: 0.5, y: 0.5 }) =>
  page.evaluate(
    ({ selector, key, at }) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      const point = { clientX: box.left + box.width * at.x, clientY: box.top + box.height * at.y };
      const target = document.elementFromPoint(point.clientX, point.clientY);
      const dt = new DataTransfer();
      dt.setData("application/x-inkledger-issue", JSON.stringify({ connectionId: 1, key, remoteId: key }));
      target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true, ...point }));
      window.__drop = () => target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, ...point }));
    },
    { selector, key, at },
  );

test("desk flow: the title's grip dragged to the right edge puts the issue on the right, an empty slot on the left that opens another", () =>
  withApp({ viewport: { width: 1280, height: 800 } }, async ({ page, base, db }) => {
    await openIssue(page, base, "DEMO-101", "Test task number 1");
    const grip = await page.locator("[data-title-grip]").boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 30, grip.y + 30, { steps: 3 });
    // Over the middle of the page: the snap bar, no place yet.
    const overlay = page.locator("[data-snap-overlay]");
    await overlay.locator("[data-snap-preset]").first().waitFor();
    await page.mouse.move(1270, 420, { steps: 10 });
    await overlay.getByText("On the desk: right half (Side by side)").waitFor();
    // Esc puts it back: nothing moves.
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    await page.mouse.up();
    assert.match(page.url(), /\/issues\/1\/DEMO-101$/);

    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 30, grip.y + 30, { steps: 3 });
    await page.mouse.move(1270, 420, { steps: 10 });
    await overlay.getByText("On the desk: right half (Side by side)").waitFor();
    await page.mouse.up();
    await onDesk(page);
    await page.locator('[data-desk-pane="1:DEMO-101"]').getByText("Test task number 1").first().waitFor();
    assert.deepEqual(await onScreen(page), ["_", "DEMO-101"]);
    assert.deepEqual(await storedShape(db), ["_", "DEMO-101"]);
    assert.equal((await storedDesk(db)).preset, "cols-2");

    // The empty slot: its search opens another issue in its place.
    const slot = page.getByRole("region", { name: "Open an issue here" });
    await slot.getByRole("combobox").click();
    await page.getByPlaceholder("Search an issue…").fill("DEMO-103");
    await page.getByRole("option", { name: /^DEMO-103 / }).click();
    await page.locator('[data-desk-pane="1:DEMO-103"]').waitFor();
    assert.deepEqual(await onScreen(page), ["DEMO-103", "DEMO-101"]);
    assert.equal(await page.locator("[data-empty-slot]").count(), 0);
    await page.waitForTimeout(500);
    assert.deepEqual(await storedShape(db), ["DEMO-103", "DEMO-101"]);
  }));

test("desk flow: Alt+Shift+→ on an issue page, then the Layout button's slots; axe clean with the popover open", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-102"], "single") }, async ({ page, base, db }) => {
    await openIssue(page, base, "DEMO-101", "Test task number 1");
    await page.locator("body").click({ position: { x: 600, y: 600 } });
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await onDesk(page);
    await page.locator('[data-desk-pane="1:DEMO-101"]').waitFor();
    assert.deepEqual(await storedShape(db), ["DEMO-102", "DEMO-101"]);

    await openIssue(page, base, "DEMO-103", "Test task number 3");
    await page.getByRole("button", { name: "Open DEMO-103 on the desk" }).click();
    const slots = page.getByRole("group", { name: "Places on the desk for DEMO-103" });
    await slots.waitFor();
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(300);
      assert.deepEqual(await axeViolations(page), [], `axe with the Layout popover, ${colorScheme}`);
    }
    // One Tab stop: the arrows go from slot to slot.
    // Two on the desk already: arrangements for three. One Tab stop, the arrows go from slot to slot.
    await slots.getByRole("button", { name: "big on the left (Large on the left)" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "top right corner (Large on the left)");
    await slots.getByRole("button", { name: "big on the left (Large on the left)" }).click();
    await onDesk(page);
    await page.locator('[data-desk-pane="1:DEMO-103"]').waitFor();
    const stored = await storedDesk(db);
    assert.equal(stored.preset, "main-left");
    assert.deepEqual(await storedShape(db), ["DEMO-103", "DEMO-102", "DEMO-101"]);
  }));

test("desk flow: Shift-click adds from a list (toast with the count), opens two side by side from an issue page, fills an empty slot on the desk", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: db => db.q("UPDATE issues SET favorite = 1 WHERE key = 'DEMO-104'") }, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    const link = page.getByRole("link", { name: "DEMO-102", exact: true }).first();
    await link.waitFor();
    await link.click({ modifiers: ["Shift"] });
    await page.getByText("DEMO-102 added to the desk (1/4)").waitFor();
    assert.match(page.url(), /\/issues$/, "stays on the list");
    assert.equal(await page.context().pages().length, 1, "no new window");
    await page.getByRole("button", { name: "Open desk" }).waitFor();

    // From an issue page: the Desk with the two side by side (the one there before parked).
    await openIssue(page, base, "DEMO-101", "Test task number 1");
    await shiftClick(page.locator('a[href="/issues/1/SHOP-7"]').first());
    await onDesk(page);
    await page.locator('[data-desk-pane="1:SHOP-7"]').waitFor();
    assert.deepEqual(await onScreen(page), ["DEMO-101", "SHOP-7"]);
    assert.deepEqual((await storedDesk(db)).parked.map(p => p.key), ["DEMO-102"]);

    // On the desk: a layout with room for one more keeps an empty slot; Shift-click fills it.
    await chooseLayout(page, "Large on the left");
    assert.deepEqual(await onScreen(page), ["DEMO-101", "SHOP-7", "_"]);
    await shiftClick(page.locator('a[href="/issues/1/DEMO-104"]').first());
    await page.locator('[data-desk-pane="1:DEMO-104"]').waitFor();
    assert.equal(await page.locator("[data-empty-slot]").count(), 0);
    assert.deepEqual(await onScreen(page), ["DEMO-101", "SHOP-7", "DEMO-104"]);
  }));

test("desk flow: a row dragged onto the sidebar's Desk; a board card carries the issue; drops on an empty slot and on the desk's edge", () =>
  withApp({ viewport: { width: 1280, height: 800 } }, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    const link = page.getByRole("link", { name: "DEMO-105", exact: true }).first();
    await link.waitFor();
    const desk = page.getByRole("link", { name: /^Desk/ }).first();
    await link.dragTo(desk);
    await page.getByText("DEMO-105 added to the desk (1/4)").waitFor();
    assert.deepEqual(await storedShape(db), ["DEMO-105"]);

    // A board card's drag carries the issue (beside the board's own types).
    await page.goto(base + "/board");
    // Read once the card's own handler ran (the window hears the event last).
    await page.evaluate(() => window.addEventListener("dragstart", e => (window.__dragTypes = [...e.dataTransfer.types])));
    const card = page.locator("[draggable=true]").filter({ has: page.getByText("Test task number 6", { exact: true }) });
    await card.waitFor();
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40, { steps: 5 });
    await page.waitForFunction(() => window.__dragTypes);
    const types = await page.evaluate(() => window.__dragTypes);
    await page.mouse.up();
    assert.ok(types.includes("application/x-inkledger-issue") && types.includes("application/x-from-status"), JSON.stringify(types));

    // On the desk: an empty slot takes an issue dropped on it.
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-105"]').waitFor();
    await chooseLayout(page, "Side by side");
    await dragIn(page, "[data-empty-slot]", "DEMO-106");
    // Over the slot: it says so, and the desk draws no snap place.
    await page.getByText("Drop it to open it here").waitFor();
    assert.equal(await page.locator("[data-snap-overlay]").count(), 0);
    await page.evaluate(() => window.__drop());
    await page.locator('[data-desk-pane="1:DEMO-106"]').waitFor();
    assert.deepEqual(await onScreen(page), ["DEMO-105", "DEMO-106"]);

    // Dragged over the desk's right edge with two panes: big on the right, the overlay says so; dropped there.
    await dragIn(page, "[data-desk-grid]", "DEMO-107", { x: 0.99, y: 0.5 });
    await page.locator("[data-snap-overlay]").getByText("Big on the right").waitFor();
    await page.evaluate(() => window.__drop());
    await page.locator('[data-desk-pane="1:DEMO-107"]').waitFor();
    await page.locator("[data-snap-overlay]").waitFor({ state: "detached" });
    await page.waitForTimeout(500);
    const stored = await storedDesk(db);
    assert.equal(stored.preset, "main-right");
    assert.deepEqual(await storedShape(db), ["DEMO-107", "DEMO-105", "DEMO-106"]);
  }));

test("desk flow: x picks rows in Issues, Open on desk opens them together; five can't; a full desk parks one for a fifth", () =>
  withApp({ viewport: { width: 1280, height: 800 } }, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    await page.getByText("Test task number 1", { exact: true }).first().waitFor();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("j");
      await page.keyboard.press("x");
    }
    const bar = page.getByRole("region", { name: "Picked issues" });
    await bar.getByText("3 picked").waitFor();
    assert.equal(await page.locator("tr[data-picked]").count(), 3);
    // x again unpicks the selected row.
    await page.keyboard.press("x");
    await bar.getByText("2 picked").waitFor();
    await page.keyboard.press("x");
    await bar.getByRole("button", { name: "Open on desk" }).click();
    await onDesk(page);
    await page.locator("section[data-desk-pane]").nth(2).waitFor();
    assert.equal((await onScreen(page)).length, 3);
    assert.equal((await storedDesk(db)).preset, "main-left");

    // Five picked: the button says why it can't.
    await page.goto(base + "/issues");
    await page.getByText("Test task number 1", { exact: true }).first().waitFor();
    for (const n of [1, 2, 3, 4, 5]) await page.getByRole("checkbox", { name: `Pick DEMO-10${n} to open on the desk` }).first().check();
    await bar.getByText("5 picked").waitFor();
    await bar.getByText("At most 4 fit on the desk").waitFor();
    assert.equal(await bar.getByRole("button", { name: "Open on desk" }).isDisabled(), true);
    await bar.getByRole("button", { name: "Clear" }).click();
    await bar.waitFor({ state: "detached" });

    // A full desk: a fifth issue Shift-clicked parks the last one, and says so.
    await db.q("UPDATE desks SET layout = ? WHERE user_id = 1 AND name IS NULL", JSON.stringify(layout(["DEMO-101", "DEMO-102", "DEMO-103", "DEMO-104"], "quad")));
    await page.getByRole("link", { name: "DEMO-109", exact: true }).first().click({ modifiers: ["Shift"] });
    await page.getByText("DEMO-109 added to the desk; DEMO-104 was parked").waitFor();
  }));

test("desk flow on a phone: a long press on the title opens the places in a sheet; one opens the desk", () =>
  withApp({ viewport: { width: 390, height: 844 } }, async ({ page, base, db }) => {
    await openIssue(page, base, "DEMO-101", "Test task number 1");
    const title = page.getByRole("heading", { level: 1, name: "Test task number 1" });
    const box = await title.boundingBox();
    // A short tap is no press.
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const sheet = page.getByRole("dialog", { name: "Open DEMO-101 on the desk" });
    await sheet.waitFor();
    await page.waitForTimeout(400);
    assert.deepEqual(await axeViolations(page), [], "axe with the sheet open");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `no sideways scroll (${over}px)`);
    await sheet.getByRole("button", { name: "left half (Side by side)" }).click();
    await onDesk(page);
    assert.deepEqual(await storedShape(db), ["DEMO-101", "_"]);
    // The phone shows the issues alone: one tab, no empty slot.
    await page.getByRole("tab", { name: "DEMO-101" }).waitFor();
    assert.equal(await page.locator("[data-empty-slot]").count(), 0);
  }));

test("desk flow: an empty slot is named, stays inside its place with a long title, and is axe clean in both themes; ✕ closes it", () =>
  withApp({
    viewport: { width: 1280, height: 800 },
    seed: async db => {
      await db.q("INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)", JSON.stringify({ ...layout(["DEMO-101"], "cols-2"), panes: [pane("DEMO-101"), { empty: true, id: "1" }] }));
      // A title far wider than the slot: it is cut, never pushes the slot's content under the next pane.
      await db.q("UPDATE issues SET summary = ?, seen_at = 1 WHERE key = 'DEMO-103'", "Manage the stock and the extra allowance when the app goes over what is available ".repeat(3).trim());
    },
  }, async ({ page, base, db }) => {
    await page.goto(base + "/issues/1/DEMO-102");
    await page.getByRole("heading", { level: 1, name: "Test task number 2" }).waitFor();
    await page.goto(base + "/issues/desk");
    const slot = page.getByRole("region", { name: "Open an issue here" });
    await slot.waitFor();
    // Opened lately: DEMO-102 (just seen), not DEMO-101 (already on the desk).
    await slot.getByRole("button", { name: /^Open DEMO-102 here/ }).waitFor();
    assert.equal(await slot.getByRole("button", { name: /^Open DEMO-101 here/ }).count(), 0);
    await slot.getByRole("button", { name: /^Open DEMO-103 here/ }).waitFor();
    const spill = await slot.evaluate(el => {
      const right = el.getBoundingClientRect().right;
      return { scroll: el.scrollWidth - el.clientWidth, past: [...el.querySelectorAll("*")].filter(c => c.getBoundingClientRect().right > right + 0.5).map(c => c.tagName + "." + c.className.toString().slice(0, 40)) };
    });
    assert.deepEqual(spill, { scroll: 0, past: [] }, "nothing in the empty slot reaches past its right edge");
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(400);
      assert.deepEqual(await axeViolations(page), [], `axe on the empty slot, ${colorScheme}`);
    }
    await slot.getByRole("button", { name: "Close this empty slot" }).click();
    await slot.waitFor({ state: "detached" });
    await page.waitForTimeout(500);
    assert.deepEqual(await storedShape(db), ["DEMO-101"]);
    assert.equal((await storedDesk(db)).preset, "single");
  }));
