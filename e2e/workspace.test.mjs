import { test } from "node:test";
import assert from "node:assert/strict";
import { holdRoute, withApp } from "./harness.mjs";
import { openHistory, showAllNew } from "./workspace-helpers.mjs";

const NOW = Date.now();

/**
 * Drags a block by its handle with a real pointer to `target`: an area (its middle) or a block (just
 * before it, on its leading side). The slot where it would land shows while it moves, before any drop.
 */
async function dragWorkspace(page, source, target) {
  const handle = source.getByRole("button", { name: /^Move / });
  const from = await handle.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  const onBlock = await target.evaluate(element => element.hasAttribute("data-tile"));
  const column = onBlock && (await target.evaluate(element => element.closest("[data-drop-area]")?.getAttribute("data-axis") === "column"));
  const x = onBlock && !column ? to.x + Math.min(8, to.width / 4) : to.x + to.width / 2;
  const y = onBlock && column ? to.y + Math.min(6, to.height / 4) : to.y + to.height / 2;
  await page.mouse.move(x, y, { steps: 8 });
  await page.locator("[data-drop-slot]").waitFor();
  await page.mouse.up();
}

/** Opens a block's menu and picks `item`. */
async function blockMenu(page, block, item) {
  await block.getByRole("button", { name: /^More for / }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("Workspace Studio previews, applies and rolls back a scoped layout without losing the dashboard", async () => {
  await withApp({}, async ({ page, base, db, context }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.stats"]').getByRole("button", { name: /^More for / }).click();
    assert.equal(await page.getByRole("menuitem", { name: "Move up", exact: true }).getAttribute("aria-disabled"), "true", "a boundary between areas is not a reorder target");
    await page.keyboard.press("Escape");
    const activity = page.locator('[data-anchor="dashboard.activity"]');
    await activity.getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await activity.getByRole("button", { name: /^Show /, pressed: false }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    const html = await (await context.request.get(base + "/", { headers: { Accept: "text/html" } })).text();
    // The server's page itself, not the empty shell: otherwise the check below could never fail.
    assert.match(html, /<section\b[^>]*data-workspace-anchor="dashboard.tasks"/, "the server drew the Dashboard");
    assert.equal(/<section\b[^>]*data-workspace-anchor="dashboard.activity"[^>]*>/.test(html), false, "the personalized SSR markup never shows a hidden section");
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Log time", exact: true }).first().waitFor();
    await page.getByRole("heading", { name: "Recent activity" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("heading", { name: "Recent activity" }).count(), 0);
    await page.goto(`${base}/settings/workspace`);
    await (await openHistory(page)).getByRole("button", { name: "Go back to this: The original layout", exact: true }).click();
    await page.getByRole("button", { name: "Apply layout" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show /, pressed: true }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 2);
    await page.getByRole("button", { name: "Reset to default" }).click();
    // Given time to make one, an already default layout makes no draft to apply.
    for (let i = 0; i < 10; i++) {
      assert.equal(await page.getByRole("button", { name: "Apply layout", exact: true }).count(), 0, "an already default layout does not need another revision");
      await page.waitForTimeout(100);
    }
  });
});

test("Studio drag and drop previews valid moves and explains invalid drops", async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    const activity = page.locator('[data-anchor="dashboard.activity"]');
    const secondary = page.locator('[data-drop-area="dashboard.secondary"]');
    await dragWorkspace(page, activity, secondary);
    await page.getByText(/Preview, not applied yet/).waitFor();
    await secondary.locator('[data-anchor="dashboard.activity"]').waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
    const [beforeInvalid] = await db.q("SELECT draft_revision, patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    await dragWorkspace(page, activity, page.locator('[data-drop-area="dashboard.header"]'));
    await page.getByText(/This block can't go in Header/).first().waitFor();
    const [afterInvalid] = await db.q("SELECT draft_revision, patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    assert.equal(afterInvalid.draft_revision, beforeInvalid.draft_revision, "an invalid drop cannot create another draft revision");
    assert.equal(afterInvalid.patches, beforeInvalid.patches, "an invalid drop preserves the pending intent");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await secondary.locator('[data-anchor="dashboard.activity"]').waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    const customize = page.locator('[data-anchor="dashboard.customize"]');
    const quickActions = page.locator('[data-anchor="dashboard.quickActions"]');
    await dragWorkspace(page, customize, quickActions);
    await page.getByText(/Preview, not applied yet/).waitFor();
    const [reordered] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    const operation = JSON.parse(reordered.patches).at(-1).operations[0];
    assert.deepEqual(operation, { type: "reorder", operationId: operation.operationId, areaId: "dashboard.header", anchorIds: ["dashboard.headerTimer", "dashboard.period", "dashboard.customize", "dashboard.quickActions"] });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1, "drag alone never applies a revision");
  });
});

test("Discovery survives editing and rollback on an older catalog until explicit dismissal", async () => {
  await withApp({
    seed: async db => {
      await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('old', 1, 'dashboard', 'desktop', 1, '0.9.0', 'product-1', ?, '[]', '[]')", NOW);
    },
  }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    const discovery = page.locator("#workspace-discovery");
    await discovery.getByText("New", { exact: true }).first().waitFor();
    await showAllNew(page);
    const before = await discovery.getByRole("button", { name: "Dismiss" }).count();
    assert.ok(before > 0);
    const stats = page.locator('[data-anchor="dashboard.stats"]');
    await stats.getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await stats.getByRole("button", { name: /^Show /, pressed: false }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 2);
    assert.equal((await db.q("SELECT catalog_version FROM workspace_revisions WHERE revision_number = 2"))[0].catalog_version, "0.9.0");
    await showAllNew(page);
    assert.equal(await discovery.getByRole("button", { name: "Dismiss" }).count(), before);
    // The history lists the original layout, then "old" (seeded), then the one in use: back to "old".
    await (await openHistory(page)).getByRole("button", { name: /^Go back to this: / }).nth(1).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await stats.getByRole("button", { name: /^Show /, pressed: true }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 3);
    await showAllNew(page);
    assert.equal(await discovery.getByRole("button", { name: "Dismiss" }).count(), before);
    await discovery.locator("[data-discovery-anchor]").first().getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.waitForFunction(count => [...document.querySelectorAll("#workspace-discovery button")].filter(button => button.textContent === "Dismiss").length === count, before - 1);
    assert.equal(await discovery.getByRole("button", { name: "Dismiss" }).count(), before - 1);
    assert.equal(JSON.parse((await db.q("SELECT dismissed_anchor_ids FROM workspace_discovery WHERE user_id = 1"))[0].dismissed_anchor_ids).length, 1, "exactly the one dismissed anchor is stored");
  });
});

test("Area discovery is placed with attributed telemetry and without an implicit apply", async () => {
  await withApp({
    seed: async db => {
      await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('old', 1, 'dashboard', 'desktop', 1, '0.9.0', 'product-1', ?, '[]', '[]')", NOW);
      await db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", NOW);
    },
  }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    const area = page.locator('[data-discovery-area="dashboard.primary"]');
    await showAllNew(page);
    await area.waitFor();
    await area.getByRole("button", { name: "Place", exact: true }).click();
    await area.waitFor({ state: "detached" });
    const [state] = await db.q("SELECT placed_area_ids, dismissed_area_ids FROM workspace_discovery WHERE user_id = 1");
    assert.deepEqual(JSON.parse(state.placed_area_ids), ["dashboard.primary"]);
    assert.deepEqual(JSON.parse(state.dismissed_area_ids), []);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1, "placing an area cannot create a layout revision");
    const events = (await db.q("SELECT payload FROM workspace_flow_events")).map(row => JSON.parse(row.payload)).filter(event => event.areaId === "dashboard.primary");
    assert.deepEqual(events.map(event => event.kind).sort(), ["discovery.placed", "discovery.seen"]);
    assert.ok(events.every(event => event.anchorId === undefined));
  });
});

test("Mobile Studio applies a tab order and preserves every navigation destination", async () => {
  await withApp({ viewport: { width: 320, height: 760 } }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    const board = page.locator('[data-anchor="mobile.board"]');
    await blockMenu(page, board, "Move up");
    await page.getByRole("button", { name: "Apply layout" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    const tabs = page.getByRole("navigation", { name: "Quick sections" });
    await tabs.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tab-bar] [data-workspace-control]')].map(element => element.getAttribute('data-workspace-control')).join(',') === 'mobile.tabs.board,mobile.tabs.home,mobile.timer.start,mobile.tabs.issues,mobile.tabs.more');
    const ids = await tabs.locator("[data-workspace-control]").evaluateAll(elements => elements.map(element => element.getAttribute("data-workspace-control")));
    assert.deepEqual(ids, ["mobile.tabs.board", "mobile.tabs.home", "mobile.timer.start", "mobile.tabs.issues", "mobile.tabs.more"]);
    for (const name of ["Dashboard", "Board", "Issues", "More"]) {
      assert.equal(await tabs.getByText(name, { exact: true }).count(), 1);
    }
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    await page.getByRole("button", { name: "Reset to default", exact: true }).click();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tab-bar] [data-workspace-control]')].map(element => element.getAttribute('data-workspace-control')).join(',') === 'mobile.tabs.home,mobile.tabs.board,mobile.timer.start,mobile.tabs.issues,mobile.tabs.more');
  });
});

test("Desktop shell renders navigation order and explicit overlay launchers", async () => {
  await withApp({}, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    const search = page.locator('[data-anchor="shell.search"]');
    await blockMenu(page, search, "Move down");
    await page.getByText(/Preview, not applied yet/).waitFor();
    await blockMenu(page, search, "Move down");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    await page.locator('aside nav[data-workspace-anchor="shell.navigation"]').waitFor();
    const shellOrder = await page.locator('[data-workspace-area="shell.navigation"] > .contents > [data-workspace-anchor]').evaluateAll(elements => elements.map(element => element.getAttribute("data-workspace-anchor")));
    assert.deepEqual(shellOrder, ["shell.notifications", "shell.navigation", "shell.search"]);
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    const todos = page.locator('[data-anchor="shell.todos"]');
    await blockMenu(page, todos, "Behind a button");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    const launcher = page.locator('[data-workspace-area="shell.overlays"] [data-workspace-control="shell.todos.open"]');
    await launcher.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("region", { name: "Floating TODO list", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "TODO", exact: true }).count(), 0);
  });
});

test("Mobile More owns secondary anchors independently of the desktop shell", async () => {
  await withApp({ viewport: { width: 320, height: 760 } }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await db.q("UPDATE settings SET todos_in_menu = 0 WHERE user_id = 1");
    await page.reload();
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    await blockMenu(page, page.locator('[data-anchor="mobile.notifications"]'), "Move up");
    await page.getByText(/Preview, not applied yet/).waitFor();
    await blockMenu(page, page.locator('[data-anchor="mobile.dock"]'), "More");
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Apply layout" && !button.disabled));
    const [saved] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    assert.equal(JSON.parse(saved.patches).length, 2, "rapid edits retain both manual intents");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    await page.getByRole("navigation", { name: "Quick sections" }).getByRole("button", { name: "More", exact: true }).click();
    const more = page.getByRole("dialog");
    await more.locator('[data-workspace-control="mobile.notifications.open"]').waitFor();
    const controls = await more.locator("[data-workspace-control], [data-workspace-anchor='mobile.dock']").evaluateAll(elements => elements.map(element => element.getAttribute("data-workspace-control") ?? element.getAttribute("data-workspace-anchor")));
    // "Move to More" puts the block at the end of More.
    assert.deepEqual(controls, ["mobile.notifications.open", "mobile.todos.open", "mobile.dock"]);
    assert.equal(await page.locator('[data-tab-bar] [data-workspace-area="mobile.dock"]').count(), 0);
    await page.keyboard.press("Escape");
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    await page.locator('[data-anchor="shell.notifications"]').getByRole("button", { name: /^Show / }).click();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    await page.locator('header [data-workspace-control="mobile.notifications.open"]').waitFor();
    await page.getByRole("navigation", { name: "Quick sections" }).getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog").locator('[data-workspace-control="mobile.notifications.open"]').waitFor();
  });
});

test("Reset revokes committed constraints only after preview and apply", async () => {
  await withApp({
    seed: async db => {
      const constraints = [{ id: "pin-stats", kind: "pin", status: "explicit", author: "user", scope: { surfaceId: "dashboard", deviceClass: "desktop" }, anchorId: "dashboard.stats" }];
      await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('pinned', 1, 'dashboard', 'desktop', 1, '1.0.0', 'product-1', ?, '[]', ?)", NOW, JSON.stringify(constraints));
    },
  }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    const stats = page.locator('[data-anchor="dashboard.stats"]');
    await stats.getByRole("button", { name: /^Pin /, pressed: true }).waitFor();
    assert.equal(await stats.getByRole("button", { name: /^Pin / }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Reset to default", exact: true }).click();
    await Promise.race([
      page.getByText(/Preview, not applied yet/).waitFor(),
      page.locator("[role='alert']").waitFor().then(async () => { throw new Error(await page.locator("[role='alert']").textContent()); }),
    ]);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1, "reset alone cannot revoke a committed constraint");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 2);
    assert.deepEqual(JSON.parse((await db.q("SELECT constraints FROM workspace_revisions WHERE revision_number = 2"))[0].constraints), []);
    await stats.getByRole("button", { name: /^Pin /, pressed: false }).waitFor();
  });
});

test("Workspace recovers a committed presentation after a lost acknowledgement", { timeout: 120_000 }, async () => {
  await withApp({}, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.route("**/api/trpc/workspace.acknowledge*", route => route.abort());
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    await page.unroute("**/api/trpc/workspace.acknowledge*");
    await page.reload();
    await page.getByText("Layout saved. It shows as soon as it's safe.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Show the saved layout", exact: true }).click();
    await page.getByText("Layout saved. It shows as soon as it's safe.", { exact: true }).waitFor({ state: "detached" });
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show /, pressed: false }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1, "recovery must not commit another revision");
    assert.equal((await db.q("SELECT status FROM workspace_presentations WHERE surface_id = 'dashboard'"))[0].status, "stable");
    await page.goto(base + "/");
    await page.getByRole("heading", { name: "Recent activity" }).waitFor({ state: "detached" });
  });
});

test("The layout editor draws each change at once on the block, and shows what is on the page now", async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    const activity = page.locator('[data-anchor="dashboard.activity"]');
    // The server's preview held back: the block must change before it answers.
    const { release } = await holdRoute(page, "**/api/trpc/workspace.saveDraft*");
    await activity.getByRole("button", { name: "Show Recent activity", exact: true }).click();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
    await activity.getByRole("img", { name: "Changed in this preview" }).waitFor();
    release();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
    // Size from the block's menu: the block takes it at once.
    const summary = page.locator('[data-anchor="dashboard.summary"]');
    await summary.getByRole("button", { name: "More for Summary", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Compact", exact: true }).click();
    await page.locator('[data-anchor="dashboard.summary"][data-variant="compact"]').waitFor();
    await page.getByText(/Preview, not applied yet/).waitFor();
    // What the page shows now, then back to the preview.
    await page.getByRole("radio", { name: "Now on the page", exact: true }).click();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="true"]').waitFor();
    await page.getByRole("radio", { name: "Preview", exact: true }).click();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0, "nothing applied by editing");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    const operations = JSON.parse((await db.q("SELECT operations FROM workspace_revisions"))[0].operations).map(item => item.operation);
    assert.ok(operations.some(operation => operation.type === "visibility" && operation.anchorId === "dashboard.activity" && operation.visible === false));
    assert.ok(operations.some(operation => operation.type === "variant" && operation.anchorId === "dashboard.summary" && operation.variant === "compact"));
    assert.equal(await page.getByRole("img", { name: "Changed in this preview" }).count(), 0, "applied: nothing differs any more");
  });
});

test("A block moves with a finger on its handle, which alone keeps the finger from scrolling the page", async () => {
  await withApp({ viewport: { width: 390, height: 900 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    // More before Issues: the timer's tab keeps its place, as it must.
    const handle = page.locator('[data-anchor="mobile.more"]').getByRole("button", { name: "Move More", exact: true });
    // In the middle of the screen: near an edge the page scrolls on purpose, to reach a far area.
    await handle.evaluate(element => element.scrollIntoView({ block: "center" }));
    const from = await handle.boundingBox();
    const to = await page.locator('[data-anchor="mobile.issues"]').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const point = (x, y) => [{ x: Math.round(x), y: Math.round(y) }];
    // The handle alone takes the finger from the page (the rest of the block, and the page, still scroll).
    assert.equal(await handle.evaluate(element => getComputedStyle(element).touchAction), "none");
    assert.equal(await page.locator('[data-anchor="mobile.more"]').evaluate(element => getComputedStyle(element).touchAction), "auto");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x + from.width / 2, from.y + from.height / 2) });
    for (let step = 1; step <= 8; step++) {
      const x = from.x + from.width / 2 + ((to.x + 6) - (from.x + from.width / 2)) * step / 8;
      const y = from.y + from.height / 2 + ((to.y + to.height / 2) - (from.y + from.height / 2)) * step / 8;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x, y) });
    }
    await page.locator("[data-drop-slot]").waitFor();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.getByText(/Preview, not applied yet/).waitFor();
    const order = await page.locator('[data-drop-area="mobile.tabs"] [data-tile]').evaluateAll(tiles => tiles.map(tile => tile.getAttribute("data-anchor")));
    assert.deepEqual(order, ["mobile.home", "mobile.board", "mobile.timer.active", "mobile.more", "mobile.issues"], "the dragged tab went before Issues");
  });
});
