// The Layout view as one drawing with layers (Edit, Use, Paths, Friction, New), a details panel for the
// block selected, and a footer that holds the draft's actions and every status line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AXE, withApp } from "./harness.mjs";

const DAY = 86_400_000;
const SCOPE = { surfaceId: "dashboard", deviceClass: "desktop" };
const grid = (marks = []) => {
  const cells = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (const [x, y, n] of marks) cells[y][x] = n;
  return cells;
};
const point = (controlId, anchorId, uses, cells = grid(), modalities = { pointer: uses, touch: 0, keyboard: 0, unknown: 0 }) => ({ controlId, anchorId, semanticRevision: 1, activations: uses, successes: 0, failures: 0, exposures: 50, activationRate: uses / 50, modalities, cells });

async function presentedDescriptor(db, page, base) {
  await page.goto(base + "/");
  for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM workspace_descriptors WHERE surface_id = 'dashboard'"))[0].n === 0; i++) await new Promise(r => setTimeout(r, 100));
  const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
  return JSON.parse(stored.descriptor);
}

/** One stored period of this page: use, paths (one leading to the sidebar), trouble on the timeline, one thing looked for. */
async function seedPeriod(db, descriptor) {
  const period = {
    evidenceId: "evidence_layers", scope: SCOPE, descriptor, semanticRevision: 1, algorithmVersion: 1, origin: "local",
    coverage: { firstAt: Date.now() - 7 * DAY, lastAt: Date.now() - DAY, activeDays: 5, sessions: 5, exposures: 50, droppedEvents: 0, gaps: 0 },
    heat: [
      point("dashboard.customize.open", "dashboard.customize", 40, grid([[6, 1, 30], [0, 5, 10]])),
      point("dashboard.tasks.openBoard", "dashboard.tasks", 20, grid([[3, 3, 20]]), { pointer: 12, touch: 0, keyboard: 8, unknown: 0 }),
      point("dashboard.timeline.gap", "dashboard.timeline", 10),
      point("dashboard.activity", "dashboard.activity", 5),
    ],
    flows: [
      { fromControlId: "dashboard.tasks.openBoard", toControlId: "dashboard.timeline.gap", count: 12 },
      { fromControlId: "dashboard.timeline.gap", toControlId: "dashboard.customize.open", count: 3 },
      { fromControlId: "dashboard.tasks.openBoard", toControlId: "shell.nav.board", count: 4 },
    ],
    friction: [{ controlId: "dashboard.timeline.gap", abandoned: 2, failures: 1, backtracks: 0, loops: 0 }],
    expectations: [{ id: "gap-layers", pattern: "placement", areaId: "dashboard.header", destinationControlId: "dashboard.logTime", occurrences: 6, coverage: 0.5, confidence: 0.7, state: "unconfirmed" }],
  };
  await db.q("INSERT INTO workspace_flow_aggregates (user_id, id, surface_id, device_class, effective_revision, origin, payload, created_at) VALUES (1, ?, 'dashboard', 'desktop', ?, 'local', ?, ?)", period.evidenceId, descriptor.effectiveRevision, JSON.stringify(period), period.coverage.lastAt);
}

const flowOn = db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now());
const toolbar = page => page.getByRole("toolbar", { name: "Layers" });
const chip = (page, name) => toolbar(page).getByRole("button", { name, exact: true });

async function violations(page, selector = "body") {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await page.evaluate(AXE);
  return page.evaluate(async rootSelector => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Missing surface: ${rootSelector}`);
    return (await axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.filter(item => item.impact === "serious" || item.impact === "critical").map(item => ({ id: item.id, nodes: item.nodes.slice(0, 2).map(node => node.target.join(" ")) }));
  }, selector);
}

test("Layers toggle, combine, and are remembered on this device", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 1280, height: 1000 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    await page.goto(`${base}/settings/workspace`);
    const canvas = page.locator("[data-layout-canvas]");
    await canvas.waitFor();
    assert.equal(await chip(page, "Edit").getAttribute("aria-pressed"), "true", "Edit is on by default");
    assert.equal(await chip(page, "Use").getAttribute("aria-pressed"), "false");
    assert.equal(await canvas.locator("[data-heat]").count(), 0, "use is not laid over until asked");
    assert.equal(await page.getByRole("combobox", { name: "Period of use" }).count(), 0, "no period to choose with no data layer on");

    // Edit + Use: the handles stay, the heat comes on, dots where the clicks landed, counts on the top three.
    await chip(page, "Use").click();
    const customize = canvas.locator('[data-anchor="dashboard.customize"]');
    await customize.getByText("Customize dashboard: 40 uses", { exact: true }).waitFor({ state: "attached" });
    assert.deepEqual((await customize.locator("[data-hit]").evaluateAll(dots => dots.map(dot => dot.getAttribute("data-hit")))).sort(), ["0,5", "6,1"]);
    assert.ok(await customize.getByRole("button", { name: /^Move / }).count() === 1, "Edit and Use together");
    const badged = await canvas.locator("[data-use-badge]").evaluateAll(badges => badges.map(badge => badge.closest("[data-anchor]").getAttribute("data-anchor")));
    assert.deepEqual(badged.sort(), ["dashboard.customize", "dashboard.tasks", "dashboard.timeline"]);
    await page.getByRole("combobox", { name: "Period of use" }).waitFor();

    // Paths on too, then a reload: both still on, the drawing the same.
    await chip(page, "Paths").click();
    await page.locator("[data-paths] [data-path-from]").first().waitFor({ state: "attached" });
    await page.reload();
    await canvas.waitFor();
    assert.equal(await chip(page, "Use").getAttribute("aria-pressed"), "true", "remembered across a reload");
    assert.equal(await chip(page, "Paths").getAttribute("aria-pressed"), "true");
    await customize.locator("[data-heat]").waitFor({ state: "attached" });

    // Edit off: the page to look at, no handles, no ghosts.
    await chip(page, "Edit").click();
    assert.equal(await canvas.getByRole("button", { name: /^Move / }).count(), 0);
    assert.equal(await canvas.locator('[data-tile][data-visible="false"]').count(), 0);
    await chip(page, "Edit").click();
    await canvas.getByRole("button", { name: /^Move / }).first().waitFor();

    // Every data layer off: the period select goes too.
    await chip(page, "Use").click();
    await chip(page, "Paths").click();
    await page.getByRole("combobox", { name: "Period of use" }).waitFor({ state: "detached" });
  }));

test("Data layers are flat with no data, and say how to get it with collection off", { timeout: 120_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1000 }, seed: flowOn }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByText("No clicks yet in this period", { exact: true }).waitFor();
    for (const name of ["Use", "Paths", "Friction"]) assert.equal(await chip(page, name).isDisabled(), true, `${name} has nothing to draw`);
    assert.equal(await page.locator("[data-layout-canvas] [data-heat]").count(), 0);
  });
  await withApp({ viewport: { width: 1280, height: 1000 } }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    const turnOn = page.getByRole("button", { name: "Turn on usage collection", exact: true });
    await turnOn.waitFor();
    assert.equal(await chip(page, "Use").isDisabled(), true);
    await turnOn.click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Collect interaction maps");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_flow_settings WHERE enabled"))[0].n, 0, "never turned on for the user");
  });
});

test("Paths draw arrows between the right blocks, thicker for the busier", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 1280, height: 1000 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    await page.goto(`${base}/settings/workspace`);
    await chip(page, "Paths").click();
    const paths = page.locator("[data-paths]");
    const busy = paths.locator('[data-path-from="dashboard.tasks"][data-path-to="dashboard.timeline"]');
    const quiet = paths.locator('[data-path-from="dashboard.timeline"][data-path-to="dashboard.customize"]');
    await busy.waitFor({ state: "attached" });
    const width = async locator => Number(await locator.getAttribute("stroke-width"));
    assert.ok(await width(busy) > await width(quiet), "the busier path is thicker");
    // Off this page: the arrow ends at the frame's edge, named.
    await paths.locator('[data-path-from="dashboard.tasks"][data-path-to=""]').waitFor({ state: "attached" });
    await page.locator("[data-path-exit]").getByText("Board", { exact: false }).waitFor();
    // The arrow joins the two blocks it names: it starts inside the first and ends inside the second.
    const ends = await busy.evaluate(element => {
      const path = element;
      const svg = path.ownerSVGElement.getBoundingClientRect();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      return { start: { x: svg.left + start.x, y: svg.top + start.y }, end: { x: svg.left + end.x, y: svg.top + end.y } };
    });
    const inside = (box, at) => at.x >= box.x - 2 && at.x <= box.x + box.width + 2 && at.y >= box.y - 2 && at.y <= box.y + box.height + 2;
    assert.ok(inside(await page.locator('[data-layout-canvas] [data-anchor="dashboard.tasks"]').boundingBox(), ends.start), "starts on My issues");
    assert.ok(inside(await page.locator('[data-layout-canvas] [data-anchor="dashboard.timeline"]').boundingBox(), ends.end), "ends on Period trend");
  }));

test("Friction outlines the block where use went wrong, and only it", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 1280, height: 1000 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    await page.goto(`${base}/settings/workspace`);
    await chip(page, "Friction").click();
    const outlined = await page.locator("[data-layout-canvas] [data-friction]").evaluateAll(tiles => tiles.map(tile => tile.getAttribute("data-anchor")));
    assert.deepEqual(outlined, ["dashboard.timeline"]);
    await page.locator('[data-anchor="dashboard.timeline"]').getByText("Period trend: 2 left halfway · 1 failed · 0 back and forth", { exact: true }).waitFor({ state: "attached" });
  }));

test("Selecting a block shows only its details; nothing selected shows the page", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 1280, height: 1000 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    await page.goto(`${base}/settings/workspace`);
    const details = page.getByRole("complementary", { name: "Details" });
    // The page: its most used, what was looked for, and how to see one block.
    await details.getByText("Select a block to see its details.", { exact: true }).waitFor();
    await details.getByRole("listitem", { name: "Wanted near Header → Log time" }).waitFor();
    await details.getByRole("button", { name: "Relevant: Wanted near Header → Log time", exact: true }).waitFor();
    assert.deepEqual(await details.getByRole("list", { name: "Most used" }).getByRole("listitem").allTextContents(), ["Customize dashboard40", "My issues20", "Period trend10"]);

    // A click on a block's body (not on its buttons) selects it.
    const tasks = page.locator('[data-layout-canvas] [data-anchor="dashboard.tasks"]');
    await tasks.getByRole("button", { name: "Details for My issues", exact: true }).click();
    await page.locator('[data-anchor="dashboard.tasks"][data-selected="true"]').waitFor();
    assert.equal(await tasks.getByRole("button", { name: "Details for My issues" }).getAttribute("aria-pressed"), "true");
    await details.getByRole("heading", { name: "My issues", exact: true }).waitFor();
    await details.getByText("20 clicks · seen 50 times", { exact: true }).waitFor();
    await details.getByText("mouse 12 · keys 8", { exact: true }).waitFor();
    await details.getByRole("list", { name: "Next used" }).getByText("Period trend", { exact: true }).waitFor();
    await details.getByRole("list", { name: "Next used" }).getByText(/Board/).waitFor();
    // Only this block: nothing of the page summary, no other block's numbers.
    assert.equal(await details.getByText("Select a block to see its details.").count(), 0);
    assert.equal(await details.getByText("Customize dashboard").count(), 0);
    // Its edit actions are here too, for touch and keyboard.
    await details.getByRole("button", { name: "Hide", exact: true }).waitFor();

    // A click on a block's own button does not select it.
    await page.locator('[data-anchor="dashboard.summary"]').getByRole("button", { name: /^More for / }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[data-anchor="dashboard.summary"][data-selected="true"]').count(), 0);

    // Keyboard: Enter on another block's body selects it; Escape in the panel goes back to the page.
    await page.locator('[data-anchor="dashboard.timeline"]').getByRole("button", { name: "Details for Period trend", exact: true }).focus();
    await page.keyboard.press("Enter");
    await details.getByRole("heading", { name: "Period trend", exact: true }).waitFor();
    await details.getByText("2 left halfway · 1 failed · 0 back and forth", { exact: true }).waitFor();
    await details.getByRole("button", { name: "Close details", exact: true }).click();
    await details.getByText("Select a block to see its details.", { exact: true }).waitFor();

    // "See as table": the period's numbers, plain headers.
    await details.getByRole("button", { name: "See as table", exact: true }).click();
    await details.getByRole("table", { name: "How often each block was used" }).getByRole("rowheader", { name: "Customize dashboard", exact: true }).waitFor();
  }));

test("On a phone the details open in a sheet", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 390, height: 844 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    await page.goto(`${base}/settings/workspace`);
    assert.equal(await page.getByRole("complementary", { name: "Details" }).count(), 0, "no side panel on a phone");
    await page.locator('[data-anchor="dashboard.tasks"]').getByRole("button", { name: "Details for My issues", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "My issues" });
    await sheet.getByText("20 clicks · seen 50 times", { exact: true }).waitFor();
    assert.deepEqual(await violations(page, '[role="dialog"]'), []);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));
  }));

test("New: a chip on the new blocks, placed or dismissed from the details", { timeout: 120_000 }, () =>
  withApp({
    viewport: { width: 1280, height: 1000 },
    seed: db => db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('old', 1, 'dashboard', 'desktop', 1, '0.9.0', 'product-1', ?, '[]', '[]')", Date.now()),
  }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    const news = toolbar(page).getByRole("button", { name: /^New \d+$/ });
    await news.waitFor();
    assert.equal(await news.getAttribute("aria-pressed"), "true", "on while there is something new");
    const before = Number((await news.textContent()).replace(/\D/g, ""));
    const chips = page.locator("[data-layout-canvas] [data-new-chip]");
    assert.ok(await chips.count() > 0, "new blocks carry a chip");
    const anchorId = await chips.first().evaluate(element => element.closest("[data-anchor]")?.getAttribute("data-anchor"));
    assert.ok(anchorId, "the first chip sits on a block");
    const block = page.locator(`[data-layout-canvas] [data-anchor="${anchorId}"]`);
    await block.getByRole("button", { name: /^Details for / }).click();
    const details = page.getByRole("complementary", { name: "Details" });
    await details.getByRole("button", { name: "Dismiss", exact: true }).click();
    await block.locator("[data-new-chip]").waitFor({ state: "detached" });
    await toolbar(page).getByRole("button", { name: before - 1 > 0 ? `New ${before - 1}` : /^New/ }).waitFor({ state: before - 1 > 0 ? "visible" : "detached" });
  }));

test("The footer holds the draft and its status: the drawing never moves on an edit", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 1280, height: 900 } }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    const canvas = page.locator("[data-layout-canvas]");
    await canvas.waitFor();
    await page.getByRole("button", { name: "Turn on usage collection", exact: true }).waitFor();
    // In view before measuring: the click below must not have to scroll to reach it.
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const footer = page.locator("[data-workspace-footer]");
    const slot = footer.locator("[data-status-slot]");
    const slotBox = await slot.boundingBox();
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
    await footer.getByText(/Preview, not applied yet/).waitFor();
    assert.deepEqual(await canvas.boundingBox(), box, "the drawing stays where it was");
    assert.equal((await slot.boundingBox()).height, slotBox.height, "the status slot keeps its height");
    await footer.getByRole("button", { name: "Discard draft", exact: true }).waitFor();
    await footer.getByRole("button", { name: "Apply layout", exact: true }).click();
    await footer.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.deepEqual(await canvas.boundingBox(), box);
    // The footer stays in view at the bottom.
    const footerBox = await footer.boundingBox();
    assert.ok(footerBox.y + footerBox.height <= 900 + 1, "the footer is on screen");

    // History: a sheet with the revisions, going back from it.
    await footer.getByRole("button", { name: "History", exact: true }).click();
    const history = page.locator("#workspace-history");
    await history.getByRole("button", { name: "Go back to this: The original layout", exact: true }).click();
    await footer.getByText(/Preview, not applied yet/).waitFor();
    await page.locator("#workspace-history").waitFor({ state: "detached" });
    await footer.getByRole("button", { name: "Apply layout", exact: true }).click();
    await footer.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
  }));

test("More: files download at once, collection and deletion behind their own steps", { timeout: 120_000 }, () =>
  withApp({ viewport: { width: 1280, height: 900 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    await page.goto(`${base}/settings/workspace`);
    const more = page.getByRole("button", { name: "More options", exact: true });
    await more.click();
    const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
    for (const item of ["Suggestions", "Compare two periods", "Export usage map (.flowmap)", "Import usage map (.flowmap)", "Export layout (.workspace)", "Import layout (.workspace)", "Usage collection", "Delete usage data"]) {
      assert.ok(items.some(text => text.includes(item)), `${item} in More`);
    }
    // The layout file: straight to a download, no text box on the page.
    const layout = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export layout (.workspace)" }).click();
    assert.equal(JSON.parse(readFileSync(await (await layout).path(), "utf8")).format, "workspace");
    assert.equal(await page.locator("textarea[readonly]").count(), 0);
    // The usage map of the period shown: a download, no picture on the page.
    await more.click();
    const map = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export usage map (.flowmap)" }).click();
    assert.equal(JSON.parse(readFileSync(await (await map).path(), "utf8")).format, "flowmap");
    assert.equal(await page.locator("img[alt*='FlowMap'], img[src^='blob:']").count(), 0, "no picture on the page");
    // Collection: its switch in a small dialog of its own.
    await more.click();
    await page.getByRole("menuitem", { name: /^Usage collection/ }).click();
    const dialog = page.getByRole("dialog", { name: "Usage collection" });
    await dialog.locator("#workspace-flowmap").getByRole("checkbox", { name: "Collect interaction maps", checked: true }).waitFor();
    await page.keyboard.press("Escape");
    // Suggestions in a sheet.
    await more.click();
    await page.getByRole("menuitem", { name: "Suggestions" }).click();
    await page.locator("#workspace-planner").getByRole("button", { name: "Suggest improvements", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
  }));

test("Every layer, the panel and the sheets pass axe in light and dark, with no sideways scroll at 320", { timeout: 240_000 }, () =>
  withApp({ viewport: { width: 1280, height: 1000 }, seed: flowOn }, async ({ page, base, db }) => {
    await seedPeriod(db, await presentedDescriptor(db, page, base));
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(`${base}/settings/workspace`);
      await page.locator("[data-layout-canvas]").waitFor();
      for (const name of ["Use", "Paths", "Friction"]) {
        await chip(page, name).click();
        assert.deepEqual(await violations(page, '[data-scroll-key="settings-category"]'), [], `${scheme}: Edit + ${name}`);
      }
      await page.locator('[data-anchor="dashboard.tasks"]').getByRole("button", { name: "Details for My issues", exact: true }).click();
      assert.deepEqual(await violations(page, '[data-scroll-key="settings-category"]'), [], `${scheme}: block selected`);
      await page.getByRole("button", { name: "History", exact: true }).click();
      assert.deepEqual(await violations(page, '[role="dialog"]'), [], `${scheme}: History`);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 320, height: 760 });
      await page.locator("[data-layout-canvas]").waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1), `${scheme}: no sideways scroll at 320`);
      assert.deepEqual(await violations(page, '[data-scroll-key="settings-category"]'), [], `${scheme}: 320`);
      // Off again for the next pass (the choice is remembered).
      await page.setViewportSize({ width: 1280, height: 1000 });
      for (const name of ["Use", "Paths", "Friction"]) await chip(page, name).click();
    }
  }));
