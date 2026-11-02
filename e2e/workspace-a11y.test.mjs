import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

async function violations(page, selector = '[data-scroll-key="settings-category"]') {
  // Contrast is measured on the settled page: mid fade-in, every colour reads lighter than it is.
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  // From the same place every time: a scroll left by an earlier step makes axe see the sticky brand over a control.
  await page.evaluate(rootSelector => {
    window.scrollTo(0, 0);
    document.querySelector(rootSelector)?.scrollTo(0, 0);
  }, selector);
  await page.evaluate(AXE);
  return page.evaluate(async rootSelector => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Missing Workspace accessibility surface: ${rootSelector}`);
    return (await axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.filter(item => item.impact === "serious" || item.impact === "critical").map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.slice(0, 2).map(node => node.target.join(" ")) }));
  }, selector);
}

test("Workspace editing, conflict and presentation states are accessible", { timeout: 120_000 }, async () => {
  await withApp({}, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.locator("#workspace-layout").waitFor();
    assert.deepEqual(await violations(page, 'a[href$="workspace"]'), []);
    assert.deepEqual(await violations(page), []);
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    assert.deepEqual(await violations(page), []);
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    const patch = [{ patchId: "a11y-conflict", patchSchemaVersion: 1, scope: { surfaceId: "mobile-tabs", deviceClass: "mobile" }, baseRevision: "default", catalogVersion: "1.0.0", author: "user", provenance: {}, intent: { kind: "reduce", status: "explicit", anchorId: "mobile.timer.active" }, operations: [{ type: "visibility", operationId: "a11y-hide", anchorId: "mobile.timer.active", visible: false }], evidence: [], proposedConstraints: [] }];
    await db.q("INSERT INTO workspace_drafts (id, user_id, surface_id, device_class, base_revision, draft_revision, status, patches, created_at, updated_at) VALUES ('a11y-conflict', 1, 'mobile-tabs', 'mobile', 'default', 1, 'ready', ?, ?, ?)", JSON.stringify(patch), Date.now(), Date.now());
    await page.reload();
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.deepEqual(await violations(page), []);
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await page.getByRole("button", { name: "Apply layout", exact: true }).waitFor({ state: "detached" });
    const [presentation] = await db.q("SELECT client_instance_id, presented_descriptor FROM workspace_presentations WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
    const descriptor = JSON.parse(presentation.presented_descriptor);
    const pending = { leaseId: "lease-a11y", leaseTokenHash: "a".repeat(64), leaseExpiresAt: Date.now() + 60_000, descriptor, draftRevision: 1, interactionEpoch: 1, presentationEpoch: 2 };
    await db.q("UPDATE workspace_presentations SET status = 'pendingActivation', last_issued_epoch = 2, pending = ? WHERE user_id = 1 AND client_instance_id = ?", JSON.stringify(pending), presentation.client_instance_id);
    await page.reload();
    await page.getByText("Layout saved. It shows as soon as it's safe.", { exact: true }).waitFor();
    assert.deepEqual(await violations(page), []);
    await db.q("UPDATE workspace_presentations SET pending = ? WHERE user_id = 1 AND client_instance_id = ?", JSON.stringify({ ...pending, activationId: "activation-a11y", activationExpiresAt: Date.now() - 1 }), presentation.client_instance_id);
    await page.reload();
    await page.getByText(/Couldn.t confirm the new layout is showing/).waitFor();
    assert.deepEqual(await violations(page), []);
    await db.q("UPDATE workspace_presentations SET status = 'unknown', pending = NULL WHERE user_id = 1 AND client_instance_id = ?", presentation.client_instance_id);
    await page.reload();
    await page.getByText("It's not known which layout this page shows. Nothing changes on its own.", { exact: true }).waitFor();
    assert.deepEqual(await violations(page), []);
    await page.setViewportSize({ width: 320, height: 760 });
    await page.getByRole("radio", { name: "Mobile tabs", exact: true }).click();
    // Keyboard only: Space on the handle picks the block up, an arrow moves it, Enter puts it down.
    const handle = page.locator('[data-anchor="mobile.board"]').getByRole("button", { name: "Move Board", exact: true });
    await handle.focus();
    await page.keyboard.press("Space");
    await page.getByText("Board picked up. Arrows move it, Enter puts it down, Escape puts it back.", { exact: true }).waitFor();
    await page.keyboard.press("ArrowUp");
    await page.getByText(/^Board: Tab bar, place 1 of 5\.$/).waitFor();
    assert.deepEqual(await violations(page), []);
    await page.keyboard.press("Enter");
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    // Focus goes back to the block just moved, not to the top of the page.
    assert.equal(await page.evaluate(() => document.activeElement?.closest("[data-anchor]")?.getAttribute("data-anchor")), "mobile.board");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));
    assert.deepEqual(await violations(page), []);
  });
});

test("Discovery remains accessible at phone width without analytics", async () => {
  await withApp({
    viewport: { width: 320, height: 760 },
    seed: async db => {
      await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('old', 1, 'dashboard', 'desktop', 1, '0.9.0', 'product-1', ?, '[]', '[]')", Date.now());
    },
  }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.locator("#workspace-discovery").waitFor();
    assert.deepEqual(await violations(page), []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));
  });
});
