import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

const NOW = Date.now();

async function dragWorkspace(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent("dragstart", { dataTransfer });
    await target.dispatchEvent("dragover", { dataTransfer });
    await target.dispatchEvent("drop", { dataTransfer });
    await source.dispatchEvent("dragend", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

test("Workspace Studio previews, applies and rolls back a scoped layout without losing the dashboard", async () => {
  await withApp({}, async ({ page, base, db, context }) => {
    await page.goto(`${base}/settings/workspace`);
    assert.equal(await page.locator('[data-anchor="dashboard.stats"]').getByRole("button", { name: "Move up" }).isDisabled(), true, "a boundary between areas is not a reorder target");
    const activity = page.locator('[data-anchor="dashboard.activity"]');
    await activity.getByRole("checkbox", { name: "Visible" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await activity.getByRole("checkbox", { name: "Hidden" }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    const html = await (await context.request.get(base + "/")).text();
    assert.equal(/<section\b[^>]*data-workspace-anchor="dashboard.activity"[^>]*>/.test(html), false, "the personalized SSR markup never shows a hidden section");
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Log time", exact: true }).first().waitFor();
    await page.getByRole("heading", { name: "Recent activity" }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("heading", { name: "Recent activity" }).count(), 0);
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Go back to this: The original layout", exact: true }).click();
    await page.getByRole("button", { name: "Apply layout" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("checkbox", { name: "Visible" }).waitFor();
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
    const before = await discovery.getByRole("button", { name: "Dismiss" }).count();
    assert.ok(before > 0);
    const stats = page.locator('[data-anchor="dashboard.stats"]');
    await stats.getByRole("checkbox", { name: "Visible" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await stats.getByRole("checkbox", { name: "Hidden" }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 2);
    assert.equal((await db.q("SELECT catalog_version FROM workspace_revisions WHERE revision_number = 2"))[0].catalog_version, "0.9.0");
    assert.equal(await discovery.getByRole("button", { name: "Dismiss" }).count(), before);
    // The history lists the original layout, then "old" (seeded), then the one in use: back to "old".
    await page.locator("#workspace-history").getByRole("button", { name: /^Go back to this: / }).nth(1).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await stats.getByRole("checkbox", { name: "Visible", checked: true }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 3);
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
    await board.getByRole("button", { name: "Move up" }).click();
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
    await search.getByRole("button", { name: "Move down" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await search.getByRole("button", { name: "Move down" }).click();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await page.goto(base + "/");
    await page.locator('aside nav[data-workspace-anchor="shell.navigation"]').waitFor();
    const shellOrder = await page.locator('[data-workspace-area="shell.navigation"] > .contents > [data-workspace-anchor]').evaluateAll(elements => elements.map(element => element.getAttribute("data-workspace-anchor")));
    assert.deepEqual(shellOrder, ["shell.notifications", "shell.navigation", "shell.search"]);
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    const todos = page.locator('[data-anchor="shell.todos"]');
    await todos.getByRole("combobox", { name: "Area", exact: true }).click();
    await page.getByRole("option", { name: "Behind a button", exact: true }).click();
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
    await page.locator('[data-anchor="mobile.notifications"]').getByRole("button", { name: "Move up" }).click();
    await page.locator('[data-anchor="mobile.dock"]').getByRole("combobox", { name: "Area", exact: true }).click();
    await page.getByRole("option", { name: "More", exact: true }).click();
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
    assert.deepEqual(controls, ["mobile.dock", "mobile.notifications.open", "mobile.todos.open"]);
    assert.equal(await page.locator('[data-tab-bar] [data-workspace-area="mobile.dock"]').count(), 0);
    await page.keyboard.press("Escape");
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    await page.locator('[data-anchor="shell.notifications"]').getByRole("checkbox", { name: "Visible", exact: true }).click();
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
    await stats.getByRole("checkbox", { name: "Pinned", checked: true }).waitFor();
    assert.equal(await stats.getByRole("checkbox", { name: "Pinned" }).getAttribute("aria-checked"), "true");
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
    await stats.getByRole("checkbox", { name: "Pinned", checked: false }).waitFor();
  });
});

test("Workspace recovers a committed presentation after a lost acknowledgement", { timeout: 120_000 }, async () => {
  await withApp({}, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("checkbox", { name: "Visible" }).click();
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
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("checkbox", { name: "Hidden" }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1, "recovery must not commit another revision");
    assert.equal((await db.q("SELECT status FROM workspace_presentations WHERE surface_id = 'dashboard'"))[0].status, "stable");
    await page.goto(base + "/");
    await page.getByRole("heading", { name: "Recent activity" }).waitFor({ state: "detached" });
  });
});
