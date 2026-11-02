// The spec's mandatory end-to-end flows (studio/flowmap-adaptive-workspace.md §21 "E2E obbligatori"),
// each one whole in the browser: what the other workspace suites check in pieces, here in the order a
// user lives it. Numbers in the test names are the spec's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { AXE, withApp } from "./harness.mjs";

const DAY = 86_400_000;
const DASHBOARD = { surfaceId: "dashboard", deviceClass: "desktop" };
const SIDEBAR = { surfaceId: "shell-desktop", deviceClass: "desktop" };

async function waitUntil(check, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const count = async (db, sql, ...params) => (await db.q(`SELECT count(*)::int AS n FROM ${sql}`, ...params))[0].n;

/** The .workspace checksum, as anyone who read the format can compute it (contracts/workspace/canonical). */
function workspaceChecksum(body) {
  const canonical = value => {
    if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
    if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).map(key => [key.normalize("NFC"), key]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map(([normalized, key]) => `${JSON.stringify(normalized)}:${canonical(value[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(`inkledger-workspace-fingerprint-workspace-v1\n${canonical(body)}`).digest("hex");
}

/** FlowMap on, then the page that presents `scope` opened once: its descriptor is what events are attributed to. */
async function presentedDescriptor(db, page, base, scope = DASHBOARD) {
  await db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?) ON CONFLICT (user_id) DO UPDATE SET enabled = true", Date.now());
  await page.goto(base + "/");
  await waitUntil(async () => (await count(db, "workspace_descriptors WHERE surface_id = ? AND device_class = ?", scope.surfaceId, scope.deviceClass)) > 0, `the ${scope.surfaceId} layout to be presented`);
  const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = ? AND device_class = ? ORDER BY created_at DESC LIMIT 1", scope.surfaceId, scope.deviceClass);
  return JSON.parse(stored.descriptor);
}

/**
 * Events in the collector's own format (src/lib/workspace/collector.ts), stored as the ingest stores
 * them: `sessions` sessions, one per day over five days, each running `steps` in order.
 */
async function seedSessions(db, scope, descriptor, steps, { sessions = 15, prefix = "flow", daysAgo = 0 } = {}) {
  for (let index = 0; index < sessions; index++) {
    const at = Date.now() - ((index % 5) + daysAgo) * DAY - 60_000;
    let sequence = 0;
    for (const step of steps) {
      const [kind, controlId, anchorId, destinationControlId] = step;
      const event = { eventSchemaVersion: 1, id: `${prefix}-${index}-${++sequence}`, kind, scope, controlId, anchorId, ...(destinationControlId ? { destinationControlId } : {}), semanticRevision: 1, descriptor, clientInstanceId: "ssr", presentationEpoch: 1, sessionId: `${prefix}-session-${index}`, sequence, occurredAt: at + sequence * 1_000, modality: "keyboard" };
      await db.q("INSERT INTO workspace_flow_events (user_id, id, surface_id, device_class, effective_revision, occurred_at, payload, received_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)", event.id, scope.surfaceId, scope.deviceClass, descriptor.effectiveRevision, event.occurredAt, JSON.stringify(event), event.occurredAt);
    }
  }
}

/** A tRPC call made by the page itself (its cookie, its origin), as the app's client sends it (superjson). */
function trpc(page, path, input, method = "POST") {
  return page.evaluate(async ({ path, input, method, body }) => {
    const response = method === "GET"
      ? await fetch(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`)
      : await fetch(`/api/trpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ?? JSON.stringify({ json: input }) });
    return { status: response.status, body: await response.json() };
  }, { path, input, method, body: typeof input === "string" ? input : undefined });
}

const preview = page => page.getByText(/Preview, not applied yet/);
async function applyLayout(page) {
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  await preview(page).waitFor({ state: "detached" });
}

/** Each tab's presentation of `scope` on a saved (not default) layout: its status, pending activation and descriptor. */
async function presented(db, scope = DASHBOARD) {
  const rows = await db.q("SELECT status, presented_descriptor, pending FROM workspace_presentations WHERE surface_id = ? AND device_class = ? AND presented_descriptor::json->>'sourceActiveRevision' <> 'default' ORDER BY presented_epoch DESC", scope.surfaceId, scope.deviceClass);
  return rows.map(row => ({ status: row.status, pending: row.pending, descriptor: JSON.parse(row.presented_descriptor) }));
}

// ─── #1 ───────────────────────────────────────────────────────────────────────────────────────────

test("#1 manual edit, complementary suggestions, partial acceptance, another edit, apply, activation, undo", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    const descriptor = await presentedDescriptor(db, page, base);
    // My issues → timeline and back, every session: two neighbours in the main column the rule-based
    // planner can bring together, one way or the other (Ollama is off in tests).
    await seedSessions(db, DASHBOARD, descriptor, [
      ["control.activate", "dashboard.tasks.openBoard", "dashboard.tasks"],
      ["control.activate", "dashboard.timeline.gap", "dashboard.timeline"],
      ["action.succeeded", "dashboard.timeline.gap", "dashboard.timeline"],
      ["control.activate", "dashboard.tasks.openBoard", "dashboard.tasks"],
    ]);
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await page.getByRole("button", { name: "Preview .flowmap", exact: true }).first().waitFor();

    // 1. A manual edit: Quick numbers hidden.
    const stats = page.locator('[data-anchor="dashboard.stats"]');
    await stats.getByRole("button", { name: "Show Quick numbers", exact: true }).click();
    await preview(page).waitFor();
    await page.locator('[data-anchor="dashboard.stats"][data-visible="false"]').waitFor();

    // 2. Suggestions asked for on top of it: separate cards, the manual choice left alone.
    await page.getByRole("button", { name: "Suggest improvements", exact: true }).click();
    const planner = page.locator("#workspace-planner");
    const cards = planner.locator("article").filter({ has: page.getByRole("button", { name: "Add selected changes to the draft", exact: true }) });
    await cards.first().waitFor();
    assert.ok(await cards.count() >= 2, "at least two complementary candidates");
    for (const card of await cards.all()) {
      assert.equal(await card.getByText(/Quick numbers/).count(), 0, "no suggestion rewrites the choice just made");
      // Each card says what it changes and how sure it is, never one opaque score.
      for (const dimension of ["Steps saved", "How sure", "Getting used to it", "Risk of change"]) await card.getByText(dimension, { exact: true }).waitFor();
    }
    const [suggestedDraft] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
    assert.equal(JSON.parse(suggestedDraft.patches).length, 1, "suggesting adds nothing to the draft by itself");
    assert.equal(await count(db, "workspace_revisions"), 0);

    // Each card declares its own operation: two different orders never read the same.
    const operationTexts = await Promise.all((await cards.all()).map(card => card.locator("label").allTextContents()));
    assert.equal(new Set(operationTexts.map(texts => texts.join("\n"))).size, operationTexts.length, `every card says what it changes: ${JSON.stringify(operationTexts)}`);

    // 3. Partial acceptance: the first card taken, the second put aside with "Not now".
    await cards.nth(1).getByRole("button", { name: "Not now", exact: true }).click();
    await cards.nth(0).getByRole("button", { name: "Add selected changes to the draft", exact: true }).click();
    await waitUntil(async () => {
      const [row] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
      return row && JSON.parse(row.patches).length === 2;
    }, "the accepted suggestion in the draft");
    const accepted = JSON.parse((await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')"))[0].patches);
    assert.equal(accepted[0].operations[0].type, "visibility", "the manual edit stays first and untouched");
    const suggestion = accepted[1];
    assert.equal(suggestion.author, "user", "an accepted operation becomes the user's");
    assert.equal(suggestion.intent.status, "explicit");
    assert.match(suggestion.provenance.parentPatchId, /^suggestion_/, "and keeps where it came from");
    assert.equal(suggestion.evidence.length, 1, "and the evidence it was based on");
    assert.equal(suggestion.operations.length, 1);
    assert.equal(suggestion.operations[0].type, "reorder");
    const acceptedOrder = suggestion.operations[0].anchorIds;

    // 4. Another edit after the suggestion: Summary made compact from its menu.
    const summary = page.locator('[data-anchor="dashboard.summary"]');
    await summary.getByRole("button", { name: "More for Summary", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Compact", exact: true }).click();
    await page.locator('[data-anchor="dashboard.summary"][data-variant="compact"]').waitFor();
    await waitUntil(async () => {
      const [row] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
      return row && JSON.parse(row.patches).length === 3;
    }, "the third change in the draft");
    assert.equal(await count(db, "workspace_revisions"), 0, "nothing applied while editing");

    // 5. Apply, 6. activation acknowledged by this tab on exactly the new revision.
    await applyLayout(page);
    const [revision] = await db.q("SELECT id, operations FROM workspace_revisions WHERE revision_number = 1");
    const operations = JSON.parse(revision.operations);
    assert.deepEqual(operations.map(item => [item.operation.type, item.origin]), [["visibility", "user"], ["reorder", "user"], ["variant", "user"]]);
    assert.deepEqual(operations[1].operation.anchorIds, acceptedOrder, "only the accepted candidate was applied");
    await waitUntil(async () => (await presented(db)).some(row => row.descriptor.sourceActiveRevision === revision.id), "the new layout acknowledged");
    const [shown] = (await presented(db)).filter(row => row.descriptor.sourceActiveRevision === revision.id);
    assert.equal(shown.status, "stable");
    assert.equal(shown.pending, null, "no activation left pending");
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE effective_revision = ?", shown.descriptor.effectiveRevision);
    assert.ok(stored, "the presented descriptor is the one stored for the new revision");
    assert.deepEqual(JSON.parse(stored.descriptor), shown.descriptor);
    const order = await page.locator('[data-drop-area="dashboard.primary"] [data-tile]').evaluateAll(tiles => tiles.filter(tile => tile.closest("[data-drop-area]")?.getAttribute("data-drop-area") === "dashboard.primary").map(tile => tile.getAttribute("data-anchor")));
    assert.deepEqual(order.filter(id => acceptedOrder.includes(id)), acceptedOrder, "the editor shows the applied order");

    // 7. Undo: back to the original layout, through a preview and a new step in the history.
    await page.getByRole("button", { name: "Go back to this: The original layout", exact: true }).click();
    await preview(page).waitFor();
    assert.equal(await count(db, "workspace_revisions"), 1, "undo is a preview first");
    await applyLayout(page);
    await page.locator('[data-anchor="dashboard.stats"][data-visible="true"]').waitFor();
    await page.locator('[data-anchor="dashboard.summary"][data-variant="default"]').waitFor();
    const [undo] = await db.q("SELECT id, caused_by_revision FROM workspace_revisions WHERE revision_number = 2");
    assert.equal(undo.caused_by_revision, revision.id, "history is extended, never rewritten");
    assert.equal(await count(db, "workspace_revisions"), 2);
    await waitUntil(async () => (await presented(db)).some(row => row.descriptor.sourceActiveRevision === undo.id && row.status === "stable"), "the undo acknowledged");
    const restored = await page.locator('[data-drop-area="dashboard.primary"] [data-tile]').evaluateAll(tiles => tiles.filter(tile => tile.closest("[data-drop-area]")?.getAttribute("data-drop-area") === "dashboard.primary").map(tile => tile.getAttribute("data-anchor")));
    assert.deepEqual(restored, ["dashboard.timeline", "dashboard.summary", "dashboard.tasks", "dashboard.activity", "dashboard.recap"]);
  });
});

// ─── #3 ───────────────────────────────────────────────────────────────────────────────────────────

test("#3 entering a page, searching for another: the gap shows, a rejection changes nothing, a confirmation becomes a rule only through preview and apply", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    const descriptor = await presentedDescriptor(db, page, base, SIDEBAR);
    // In Issues (A), the user opens the search and picks Board (B) — or, in other sessions, Reports.
    for (const [prefix, destination] of [["board", "shell.nav.board"], ["reports", "shell.nav.reports"]]) {
      await seedSessions(db, SIDEBAR, descriptor, [
        ["control.activate", "shell.nav.issues", "shell.navigation"],
        ["control.activate", "shell.search.open", "shell.search"],
        ["search.opened", "shell.search.open", "shell.search"],
        ["search.selected", "shell.search.select", "shell.search", destination],
        ["navigation.completed", destination, "shell.navigation"],
      ], { sessions: 10, prefix });
    }
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await page.getByRole("radio", { name: "Expectation", exact: true }).click();
    const board = "Hard to find from Sidebar sections → Board";
    const reports = "Hard to find from Sidebar sections → Reports";
    for (const name of [board, reports]) await page.getByRole("rowheader", { name, exact: true }).waitFor();
    const row = name => page.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await row(board).getByText(/not reviewed$/).waitFor();

    // Rejected: marked, and nothing else — no rule, no draft, no layout.
    await page.getByRole("button", { name: `Not relevant: ${board}`, exact: true }).click();
    await row(board).getByText(/· not relevant$/).waitFor();
    assert.deepEqual((await db.q("SELECT status FROM workspace_flow_feedback")).map(item => item.status), ["rejected"]);
    assert.equal(await page.getByRole("button", { name: "Use in layout", exact: true }).count(), 0, "a rejected gap offers nothing to apply");
    assert.equal(await count(db, "workspace_drafts"), 0);
    assert.equal(await count(db, "workspace_revisions"), 0);

    // Confirmed: still only a mark until the user asks to use it.
    await page.getByRole("button", { name: `Relevant: ${reports}`, exact: true }).click();
    await row(reports).getByText(/· confirmed$/).waitFor();
    await row(board).getByText(/· not relevant$/).waitFor();
    assert.equal(await count(db, "workspace_drafts"), 0, "confirming creates no draft");
    assert.equal(await count(db, "workspace_revisions"), 0, "confirming creates no rule");
    const use = page.getByRole("button", { name: "Use in layout", exact: true });
    assert.equal(await use.count(), 1, "only the confirmed gap can be used");
    await use.click();
    await preview(page).waitFor();
    const [draft] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
    const [patch] = JSON.parse(draft.patches);
    assert.equal(patch.intent.kind, "expectHere");
    assert.deepEqual(patch.proposedConstraints.map(constraint => [constraint.kind, constraint.anchorId, constraint.areaId, constraint.author]), [["expectHere", "shell.navigation", "shell.navigation", "user"]]);
    assert.equal(await count(db, "workspace_revisions"), 0, "a rule is only a preview until apply");

    await applyLayout(page);
    const [revision] = await db.q("SELECT constraints FROM workspace_revisions");
    assert.deepEqual(JSON.parse(revision.constraints).map(constraint => [constraint.kind, constraint.anchorId, constraint.areaId, constraint.status, constraint.author]), [["expectHere", "shell.navigation", "shell.navigation", "explicit", "user"]], "one rule, from the confirmed gap alone");
  });
});

// ─── #6 ───────────────────────────────────────────────────────────────────────────────────────────

// The server ships one catalogue (CATALOG_V1, no tombstones) and has no way to load another in a test: a
// "release" is a layout saved under an older catalogue (0.9.0), which also names a block this release removed.
test("#6 after a release: own choices kept, the rest on the new default, Discovery, placement, a removed block set aside, rollback on today's catalogue", { timeout: 180_000 }, async () => {
  await withApp({
    viewport: { width: 1280, height: 1400 },
    seed: async db => {
      const user = (operation, id) => ({ operation: { ...operation, operationId: id }, origin: "user", acceptedByUser: true });
      const operations = [
        user({ type: "visibility", anchorId: "dashboard.activity", visible: false }, "old-hide-activity"),
        // A block of the old release, gone from this one with no tombstone.
        user({ type: "variant", anchorId: "dashboard.legacyChart", variant: "expanded" }, "old-legacy"),
      ];
      // And a rule the user confirmed on that block: it no longer has anything to hold.
      const constraints = [{ id: "old-pin-legacy", kind: "pin", status: "explicit", author: "user", scope: DASHBOARD, anchorId: "dashboard.legacyChart" }];
      await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('old', 1, 'dashboard', 'desktop', 1, '0.9.0', 'product-1', ?, ?, ?)", Date.now() - DAY, JSON.stringify(operations), JSON.stringify(constraints));
    },
  }, async ({ page, base, db }) => {
    // The Dashboard still opens on it: the removed block alone is set aside, the user's own choice holds.
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Log time", exact: true }).first().waitFor();
    assert.equal(await page.locator('[data-workspace-anchor="dashboard.activity"]').count(), 0, "the user's hidden block stays hidden after the release");
    await page.getByRole("button", { name: "Customize dashboard", exact: true }).waitFor();

    await page.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
    // Not personalized: on today's ProductDefault.
    for (const anchorId of ["dashboard.stats", "dashboard.summary", "dashboard.tasks"]) await page.locator(`[data-anchor="${anchorId}"][data-visible="true"][data-variant="default"]`).waitFor();
    assert.equal(await page.locator('[data-anchor="dashboard.legacyChart"]').count(), 0, "a removed block is never drawn");

    // Discovery: what this release added to the old layout, areas and blocks, each with Place and Dismiss.
    const discovery = page.locator("#workspace-discovery");
    await discovery.locator('[data-discovery-area="dashboard.primary"]').waitFor();
    const newBlocks = await discovery.locator("[data-discovery-anchor]").evaluateAll(items => items.map(item => item.getAttribute("data-discovery-anchor")));
    assert.ok(newBlocks.includes("dashboard.stats"), "a block of the new release is announced");
    assert.equal(await count(db, "workspace_revisions"), 1, "Discovery alone changes no layout");

    // Placement: an area placed, a block placed, another dismissed; none of it applies a layout.
    await discovery.locator('[data-discovery-area="dashboard.primary"]').getByRole("button", { name: "Place", exact: true }).click();
    await discovery.locator('[data-discovery-area="dashboard.primary"]').waitFor({ state: "detached" });
    await discovery.locator('[data-discovery-anchor="dashboard.stats"]').getByRole("button", { name: "Place", exact: true }).click();
    await discovery.locator('[data-discovery-anchor="dashboard.stats"]').waitFor({ state: "detached" });
    await discovery.locator('[data-discovery-anchor="dashboard.recap"]').getByRole("button", { name: "Dismiss", exact: true }).click();
    await discovery.locator('[data-discovery-anchor="dashboard.recap"]').waitFor({ state: "detached" });
    const [state] = await db.q("SELECT placed_anchor_ids, dismissed_anchor_ids, placed_area_ids FROM workspace_discovery WHERE user_id = 1 AND surface_id = 'dashboard'");
    assert.deepEqual([JSON.parse(state.placed_area_ids), JSON.parse(state.placed_anchor_ids), JSON.parse(state.dismissed_anchor_ids)], [["dashboard.primary"], ["dashboard.stats"], ["dashboard.recap"]]);
    assert.equal(await count(db, "workspace_revisions"), 1);

    // A change on top, applied: the removed block's operation is not carried as if it still existed in a new choice.
    await page.locator('[data-anchor="dashboard.summary"]').getByRole("button", { name: "More for Summary", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Compact", exact: true }).click();
    await preview(page).waitFor();
    await applyLayout(page);
    assert.equal(await count(db, "workspace_revisions"), 2);
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();

    // Rollback to the old release's layout: resolved on today's catalogue (the removed block still set aside).
    await page.locator("#workspace-history").getByRole("button", { name: /^Go back to this: / }).nth(1).click();
    await preview(page).waitFor();
    await applyLayout(page);
    await page.locator('[data-anchor="dashboard.summary"][data-variant="default"]').waitFor();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
    assert.equal(await page.locator('[data-anchor="dashboard.legacyChart"]').count(), 0, "rollback does not bring back code that no longer exists");
    // And to the original layout: today's ProductDefault, the activity shown again.
    await page.getByRole("button", { name: "Go back to this: The original layout", exact: true }).click();
    await preview(page).waitFor();
    await applyLayout(page);
    await page.locator('[data-anchor="dashboard.activity"][data-visible="true"]').waitFor();
    assert.equal(await count(db, "workspace_revisions"), 4, "every step is a new revision, history never rewritten");
    assert.equal(await count(db, "workspace_revisions WHERE id = 'old' AND operations LIKE '%dashboard.legacyChart%' AND constraints LIKE '%old-pin-legacy%'"), 1, "the original document is preserved for recovery");
    // Discovery marks survive every one of these steps.
    assert.equal(await discovery.locator('[data-discovery-anchor="dashboard.stats"], [data-discovery-anchor="dashboard.recap"], [data-discovery-area="dashboard.primary"]').count(), 0);
  });
});

// ─── #10 ──────────────────────────────────────────────────────────────────────────────────────────

test("#10 a .workspace claiming to be the user's own choices is quarantined, inherits no precedence, and its rules wait for an explicit OK", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Preview .workspace", exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download .workspace", exact: true }).click();
    const exported = JSON.parse(readFileSync(await (await downloaded).path(), "utf8"));
    // Forged as the user's own: committed operations "by the user", rules "explicit" and "by the user",
    // a draft patch "by the user" with an explicit intent — with a correct checksum, as anyone can compute it.
    const user = { status: "explicit", author: "user", scope: DASHBOARD };
    exported.revision.operations = [{ operation: { type: "visibility", operationId: "forged-hide-stats", anchorId: "dashboard.stats", visible: false }, origin: "user", acceptedByUser: true }];
    exported.revision.constraints = [{ id: "forged-hide-activity", kind: "hide", anchorId: "dashboard.activity", ...user }];
    exported.draft = {
      draftId: "forged-draft", draftRevision: 3, baseRevision: exported.revision.revisionId, scope: DASHBOARD, status: "ready",
      patches: [{ patchId: "forged-patch", patchSchemaVersion: 1, scope: DASHBOARD, baseRevision: exported.revision.revisionId, catalogVersion: "1.0.0", author: "user", provenance: {}, intent: { kind: "prioritize", status: "explicit", anchorId: "dashboard.summary" }, operations: [{ type: "variant", operationId: "forged-compact", anchorId: "dashboard.summary", variant: "compact" }], evidence: [], proposedConstraints: [{ id: "forged-pin-tasks", kind: "pin", anchorId: "dashboard.tasks", ...user }] }],
    };
    delete exported.checksum;
    exported.checksum = workspaceChecksum(exported);
    await page.getByLabel("Import .workspace", { exact: true }).setInputFiles({ name: "mine.workspace", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
    await Promise.race([
      page.getByText("Imported as a draft to review before applying.", { exact: true }).waitFor(),
      page.locator("#workspace-planner [role='alert']").waitFor().then(async () => { throw new Error(await page.locator("#workspace-planner [role='alert']").textContent()); }),
    ]);

    // Quarantined: kept as sent, and a draft whose every patch and rule is the import's, proposed.
    assert.equal(await count(db, "workspace_imports"), 1);
    assert.equal(await count(db, "workspace_revisions"), 0, "an import never applies itself");
    const [draft] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
    const patches = JSON.parse(draft.patches);
    assert.deepEqual(patches.map(patch => [patch.author, patch.intent.status]), [["import", "proposed"], ["import", "proposed"]]);
    assert.ok(patches.every(patch => patch.provenance.importSource), "each patch names the import it came from");
    assert.deepEqual(patches.flatMap(patch => patch.proposedConstraints).map(constraint => [constraint.kind, constraint.anchorId, constraint.author, constraint.status]), [["hide", "dashboard.activity", "import", "proposed"], ["pin", "dashboard.tasks", "import", "proposed"]]);

    // No inherited precedence: the operations are previewed as proposals, the rules not in force at all.
    await preview(page).waitFor();
    await page.locator('[data-anchor="dashboard.stats"][data-visible="false"]').waitFor();
    await page.locator('[data-anchor="dashboard.summary"][data-variant="compact"]').waitFor();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="true"]').waitFor();
    assert.equal(await page.locator('[data-anchor="dashboard.tasks"]').getByRole("button", { name: "Pin My issues", exact: true }).getAttribute("aria-pressed"), "false", "a forged pin is not a pin");
    const planner = page.locator("#workspace-planner");
    await planner.getByText("The rules it proposes need your separate OK.", { exact: true }).first().waitFor();
    const rule = text => planner.locator("div").filter({ has: page.getByText(text, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Confirm rule", exact: true }) }).last();
    await rule("Always hide Recent activity").waitFor();
    await rule("Keep My issues in place").waitFor();

    // One rule confirmed by hand, in the browser: only then is it in force (still only a preview).
    await rule("Always hide Recent activity").getByRole("button", { name: "Confirm rule", exact: true }).click();
    await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
    await planner.getByText("Always hide Recent activity", { exact: true }).waitFor({ state: "detached" });
    await rule("Keep My issues in place").waitFor();
    assert.equal(await count(db, "workspace_revisions"), 0, "confirming a rule applies nothing");

    await applyLayout(page);
    const [revision] = await db.q("SELECT operations, constraints FROM workspace_revisions");
    const operations = JSON.parse(revision.operations);
    assert.deepEqual(operations.map(item => [item.operation.type, item.operation.anchorId, item.origin]), [["visibility", "dashboard.stats", "import"], ["variant", "dashboard.summary", "import"]], "imported operations stay the import's, never the user's");
    assert.deepEqual(JSON.parse(revision.constraints).map(constraint => [constraint.kind, constraint.anchorId, constraint.author, constraint.status]), [["hide", "dashboard.activity", "user", "explicit"]], "only the rule the user confirmed; the unconfirmed pin is gone");
    assert.equal(await page.locator('[data-anchor="dashboard.tasks"]').getByRole("button", { name: "Pin My issues", exact: true }).getAttribute("aria-pressed"), "false");
  });
});

// ─── #12 ──────────────────────────────────────────────────────────────────────────────────────────

test("#12 use on two layouts is mapped per layout: each period on its own page, nothing laid over the other", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    // Before: the default layout, where Customize was used.
    const before = await presentedDescriptor(db, page, base);
    await seedSessions(db, DASHBOARD, before, [["control.activate", "dashboard.customize.open", "dashboard.customize"]], { sessions: 7, prefix: "before", daysAgo: 6 });
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await waitUntil(async () => (await count(db, "workspace_flow_aggregates")) === 1, "the first period");

    // A new layout (Recent activity hidden), then used differently: My issues, never Customize.
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: "Show Recent activity", exact: true }).click();
    await preview(page).waitFor();
    await applyLayout(page);
    const [revision] = await db.q("SELECT id FROM workspace_revisions");
    await waitUntil(async () => (await count(db, "workspace_descriptors WHERE source_active_revision = ?", revision.id)) > 0, "the new layout's descriptor");
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE source_active_revision = ?", revision.id);
    const after = JSON.parse(stored.descriptor);
    assert.notEqual(after.effectiveRevision, before.effectiveRevision);
    await seedSessions(db, DASHBOARD, after, [["control.activate", "dashboard.tasks.openBoard", "dashboard.tasks"]], { sessions: 5, prefix: "after" });
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await waitUntil(async () => (await count(db, "workspace_flow_aggregates")) === 2, "the second period");
    const periods = await db.q("SELECT id, effective_revision FROM workspace_flow_aggregates ORDER BY created_at");
    assert.deepEqual(periods.map(row => row.effective_revision), [before.effectiveRevision, after.effectiveRevision], "one period per effective revision");

    await page.reload();
    const timeline = page.getByRole("list", { name: "Use over time" });
    await timeline.locator("figure").nth(1).waitFor();
    assert.deepEqual(await timeline.locator("figure").evaluateAll(figures => figures.map(figure => figure.getAttribute("data-period"))), periods.map(row => row.id), "two maps, oldest first, no third one merging them");
    const [old, now] = [timeline.locator(`[data-period="${periods[0].id}"]`), timeline.locator(`[data-period="${periods[1].id}"]`)];
    // Each map draws its own layout with its own use.
    await old.getByText("Customize dashboard: 7 uses", { exact: true }).waitFor({ state: "attached" });
    await old.getByText("My issues: 0 uses", { exact: true }).waitFor({ state: "attached" });
    await old.getByText("Recent activity: 0 uses", { exact: true }).waitFor({ state: "attached" });
    await old.getByText("7 uses", { exact: true }).waitFor();
    await now.getByText("My issues: 5 uses", { exact: true }).waitFor({ state: "attached" });
    await now.getByText("Customize dashboard: 0 uses", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await now.getByText(/^Recent activity: /).count(), 0, "the hidden block is not drawn on the layout that hid it");
    await now.getByText("5 uses", { exact: true }).waitFor();

    // The editor's "Show use" reads the layout on screen alone: the earlier layout's use is not laid over it.
    const show = page.getByRole("button", { name: "Show use", exact: true });
    await show.click();
    assert.equal(await show.getAttribute("aria-pressed"), "true");
    await page.locator('[data-anchor="dashboard.tasks"]').getByText("5 uses", { exact: true }).waitFor();
    assert.equal(await page.locator('[data-anchor="dashboard.customize"]').getByText(/^\d+ uses?$/).count(), 0, "Customize's use belongs to the earlier layout");
  });
});

// ─── #13 ──────────────────────────────────────────────────────────────────────────────────────────

/** Serious and critical axe findings on the settings page (as workspace-a11y.test.mjs measures them). */
async function violations(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  // From the top every time: a control the keyboard scrolled under the sticky header reads as a too small target.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('[data-scroll-key="settings-category"]')?.scrollTo(0, 0);
  });
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const root = document.querySelector('[data-scroll-key="settings-category"]');
    if (!root) throw new Error("Missing Workspace accessibility surface");
    return (await axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.filter(item => item.impact === "serious" || item.impact === "critical").map(item => ({ id: item.id, nodes: item.nodes.slice(0, 2).map(node => node.target.join(" ")), why: item.nodes.slice(0, 2).map(node => node.failureSummary) }));
  });
}

for (const viewport of [{ width: 1400, height: 900 }, { width: 320, height: 760 }]) {
  test(`#13 keyboard only (${viewport.width}px): edit, apply, activation, rollback and a conflict, focus never lost, accessible in every state`, { timeout: 240_000 }, async () => {
    await withApp({ viewport }, async ({ page, base, db }) => {
      // Proof that nothing here is done with a pointer: every trusted pointer press is counted.
      await page.addInitScript(() => {
        window.__pointerPresses = 0;
        addEventListener("pointerdown", event => { if (event.isTrusted) window.__pointerPresses++; }, true);
      });
      /** The keyboard's place after a step: on a control, never dropped to the page body. */
      const focusKept = async step => {
        await page.waitForFunction(() => document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement, null, { timeout: 5_000 }).catch(() => {});
        const where = await page.evaluate(() => document.activeElement === document.body || !document.activeElement ? "body" : `${document.activeElement.tagName} ${document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent?.trim().slice(0, 40)}`);
        assert.notEqual(where, "body", `focus lost after: ${step}`);
      };
      const accessible = async state => {
        assert.deepEqual(await violations(page), [], `axe: ${state}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1), `no page-wide horizontal scroll: ${state}`);
      };
      const press = async (locator, key = "Enter") => {
        await locator.focus();
        await page.keyboard.press(key);
      };

      await page.goto(`${base}/settings/workspace`);
      await page.locator("#workspace-layout").waitFor();
      await accessible("editing, nothing changed");

      // Edit: hide a block with its toggle, size another from its menu, move a third with the keyboard drag.
      await press(page.getByRole("button", { name: "Show Recent activity", exact: true }), "Space");
      await preview(page).waitFor();
      await focusKept("hiding a block");
      await press(page.getByRole("button", { name: "More for Summary", exact: true }));
      await page.getByRole("menuitemradio", { name: "Compact", exact: true }).waitFor();
      await press(page.getByRole("menuitemradio", { name: "Compact", exact: true }));
      await page.locator('[data-anchor="dashboard.summary"][data-variant="compact"]').waitFor();
      await focusKept("sizing from the menu");
      await press(page.getByRole("button", { name: "Move My issues", exact: true }), "Space");
      await page.getByText("My issues picked up. Arrows move it, Enter puts it down, Escape puts it back.", { exact: true }).waitFor();
      await page.keyboard.press("ArrowUp");
      await page.getByText(/^My issues: Main column, place \d of \d\.$/).waitFor();
      await page.keyboard.press("Enter");
      await page.getByText("My issues put down. The preview shows it.", { exact: true }).waitFor();
      await focusKept("moving with the keyboard");
      await waitUntil(async () => (await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')")).some(row => JSON.parse(row.patches).length === 3), "three changes in the draft");
      await accessible("preview");

      // Apply, with the acknowledgement lost on the way: the page says so, then the user shows the saved layout.
      await page.route("**/api/trpc/workspace.acknowledge*", route => route.abort());
      await press(page.getByRole("button", { name: "Apply layout", exact: true }));
      await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent);
      // Focus after a failed apply is the separate todo test below (Workspace.tsx drops it on its error path).
      await page.unroute("**/api/trpc/workspace.acknowledge*");
      await page.reload();
      const saved = page.getByText("Layout saved. It shows as soon as it's safe.", { exact: true });
      await saved.waitFor();
      await accessible("pendingActivation");
      await press(page.getByRole("button", { name: "Show the saved layout", exact: true }));
      await saved.waitFor({ state: "detached" });
      await focusKept("activation from the UI");
      await waitUntil(async () => (await presented(db)).some(row => row.status === "stable"), "the activation acknowledged");
      await page.locator('[data-anchor="dashboard.activity"][data-visible="false"]').waitFor();
      await accessible("activated");
      assert.equal(await count(db, "workspace_revisions"), 1);

      // Rollback: back to the original layout, previewed, then applied.
      await press(page.getByRole("button", { name: "Go back to this: The original layout", exact: true }));
      await preview(page).waitFor();
      await focusKept("rollback preview");
      await accessible("rollback preview");
      await press(page.getByRole("button", { name: "Apply layout", exact: true }));
      await preview(page).waitFor({ state: "detached" });
      await page.locator('[data-anchor="dashboard.activity"][data-visible="true"]').waitFor();
      await focusKept("rollback applied");
      assert.equal(await count(db, "workspace_revisions"), 2);
      await accessible("rolled back");

      // A conflict (a draft saved elsewhere that the rules refuse), resolved by discarding it.
      const patch = [{ patchId: "keyboard-conflict", patchSchemaVersion: 1, scope: { surfaceId: "mobile-tabs", deviceClass: "mobile" }, baseRevision: "default", catalogVersion: "1.0.0", author: "user", provenance: {}, intent: { kind: "reduce", status: "explicit", anchorId: "mobile.timer.active" }, operations: [{ type: "visibility", operationId: "keyboard-hide", anchorId: "mobile.timer.active", visible: false }], evidence: [], proposedConstraints: [] }];
      await db.q("INSERT INTO workspace_drafts (id, user_id, surface_id, device_class, base_revision, draft_revision, status, patches, created_at, updated_at) VALUES ('keyboard-conflict', 1, 'mobile-tabs', 'mobile', 'default', 1, 'ready', ?, ?, ?)", JSON.stringify(patch), Date.now(), Date.now());
      await press(page.getByRole("radio", { name: "Dashboard · desktop", exact: true }), "End");
      await page.getByRole("radio", { name: "Mobile tabs", exact: true, checked: true }).waitFor();
      await page.getByRole("alert").filter({ hasText: "This layout clashes with a rule you confirmed." }).waitFor();
      await focusKept("choosing the part of the app");
      await accessible("conflict");
      await press(page.getByRole("button", { name: "Discard draft", exact: true }));
      await page.getByRole("button", { name: "Apply layout", exact: true }).waitFor({ state: "detached" });
      // Focus after the discard is the separate todo test below (Workspace.tsx focuses a still disabled button).
      assert.equal((await db.q("SELECT status FROM workspace_drafts WHERE id = 'keyboard-conflict'"))[0].status, "discarded");
      await accessible("conflict resolved");

      assert.equal(await page.evaluate(() => window.__pointerPresses), 0, "no pointer was used");
    });
  });
}

/** Where the keyboard is, in words: "body" when it was dropped to the page. */
const focusedElement = page => page.evaluate(() => !document.activeElement || document.activeElement === document.body ? "body" : `${document.activeElement.tagName} ${document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent?.trim().slice(0, 40)}`);

test("#13 keyboard: a failed apply keeps the focus on the page's controls", async () => {
  await withApp({}, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Show Recent activity", exact: true }).focus();
    await page.keyboard.press("Space");
    await preview(page).waitFor();
    await page.route("**/api/trpc/workspace.acknowledge*", route => route.abort());
    await page.getByRole("button", { name: "Apply layout", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent);
    await page.waitForTimeout(300);
    assert.notEqual(await focusedElement(page), "body");
  });
});

test("#13 keyboard: discarding a draft keeps the focus on the page's controls", async () => {
  await withApp({}, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Show Recent activity", exact: true }).focus();
    await page.keyboard.press("Space");
    await preview(page).waitFor();
    await page.getByRole("button", { name: "Discard draft", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Apply layout", exact: true }).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.notEqual(await focusedElement(page), "body");
  });
});

// ─── #14 ──────────────────────────────────────────────────────────────────────────────────────────

test("#14 after Delete FlowMap data nothing derived is delivered again: no late batch, period, map, export or suggestion", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page: studio, base, db, context }) => {
    const descriptor = await presentedDescriptor(db, studio, base);
    await seedSessions(db, DASHBOARD, descriptor, [
      ["control.activate", "dashboard.tasks.openBoard", "dashboard.tasks"],
      ["control.activate", "dashboard.timeline.gap", "dashboard.timeline"],
      ["action.succeeded", "dashboard.timeline.gap", "dashboard.timeline"],
    ]);
    // Another tab on the Dashboard, its collector holding a batch it has not sent yet (it sends every 30 s or on leaving).
    const dashboard = await context.newPage();
    const beacons = [];
    // Read on its way out (a beacon's body is not exposed on the request event), then let through untouched.
    await dashboard.route("**/api/trpc/flowMap.ingest*", async route => {
      beacons.push(route.request().postDataBuffer()?.toString("utf8") ?? null);
      await route.continue();
    });
    await dashboard.goto(base + "/");
    await dashboard.getByRole("button", { name: "Customize dashboard", exact: true }).click();
    await dashboard.keyboard.press("Escape");
    await dashboard.waitForTimeout(1_300);
    assert.equal(beacons.length, 0, "the batch is still queued");

    await studio.goto(`${base}/settings/workspace`);
    await studio.getByRole("button", { name: "Update evidence", exact: true }).click();
    await studio.getByRole("button", { name: "Preview .flowmap", exact: true }).first().waitFor();
    const [evidence] = await db.q("SELECT id FROM workspace_flow_aggregates");
    await studio.getByRole("button", { name: "Suggest improvements", exact: true }).click();
    const add = studio.getByRole("button", { name: "Add selected changes to the draft", exact: true });
    await add.first().click();
    await preview(studio).waitFor();
    const [accepted] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
    assert.equal(JSON.parse(accepted.patches)[0].evidence[0].evidenceId, evidence.id, "the draft points at the evidence before the deletion");

    await studio.getByRole("button", { name: "Delete FlowMap data", exact: true }).click();
    const deleting = studio.waitForResponse(response => response.url().includes("flowMap.delete"));
    await studio.getByRole("button", { name: "Delete data", exact: true }).click();
    assert.equal((await deleting).status(), 200);
    for (const table of ["workspace_flow_events", "workspace_flow_aggregates", "workspace_flow_imports", "workspace_flow_feedback", "workspace_planner_feedback"]) {
      await waitUntil(async () => (await count(db, table)) === 0, `${table} emptied`);
    }

    // The other tab leaves: its queued batch goes out now, after the deletion, and is refused.
    await dashboard.goto(base + "/issues");
    await waitUntil(() => beacons.length > 0, "the queued batch to be sent");
    // One batch per collecting page part (the sidebar has its own): the Dashboard's holds the click made before the deletion.
    const holdsClick = body => JSON.parse(body ?? "{}").json?.events.some(event => event.controlId === "dashboard.customize.open");
    await waitUntil(() => beacons.some(holdsClick), "the Dashboard's queued batch");
    const batch = beacons.find(holdsClick);
    await dashboard.waitForTimeout(500);
    assert.equal(await count(db, "workspace_flow_events"), 0, "a batch arriving after the deletion is not stored");
    const replayOff = await trpc(studio, "flowMap.ingest", batch);
    assert.equal(replayOff.body.result.data.json.received, 0, "refused while FlowMap is off");

    // Even once FlowMap is turned on again, what was collected before the deletion never comes back.
    await studio.getByRole("checkbox", { name: "Collect interaction maps" }).click();
    await studio.waitForFunction(() => document.querySelector('[role="checkbox"][aria-label="Collect interaction maps"]')?.getAttribute("aria-checked") === "true");
    const replayOn = await trpc(studio, "flowMap.ingest", batch);
    assert.equal(replayOn.status, 200);
    assert.equal(replayOn.body.result.data.json.received, 0, "a batch from before the deletion is refused after consent is given again");
    assert.equal(await count(db, "workspace_flow_events"), 0);

    // Derived data: nothing to read, aggregate, export or suggest from.
    const overview = (await trpc(studio, "flowMap.get", { scope: DASHBOARD }, "GET")).body.result.data.json;
    assert.deepEqual([overview.evidence, overview.live, overview.imports], [[], null, []], "flowMap.get is empty");
    const gone = await trpc(studio, "flowMap.export", { scope: DASHBOARD, evidenceId: evidence.id, view: "heat" });
    assert.equal(gone.body.error?.json?.data?.code, "NOT_FOUND", "the deleted period cannot be exported");
    await studio.getByRole("button", { name: "Update evidence", exact: true }).click();
    await waitUntil(async () => (await count(db, "workspace_flow_aggregates")) === 1, "a fresh aggregate");
    const [fresh] = await db.q("SELECT payload FROM workspace_flow_aggregates");
    const aggregate = JSON.parse(fresh.payload);
    assert.deepEqual([aggregate.heat, aggregate.flows, aggregate.friction, aggregate.expectations, aggregate.coverage.activeDays], [[], [], [], [], 0], "the aggregate has no rows");
    await studio.getByRole("button", { name: "Preview .flowmap", exact: true }).first().click();
    const flowmapDownload = studio.waitForEvent("download");
    await studio.getByRole("button", { name: "Download .flowmap", exact: true }).click();
    const exportedMap = JSON.parse(readFileSync(await (await flowmapDownload).path(), "utf8"));
    assert.deepEqual([exportedMap.evidence.heat, exportedMap.evidence.flows, exportedMap.evidence.expectations], [[], [], []], "the export is empty");
    await studio.getByRole("button", { name: "Suggest improvements", exact: true }).click();
    await studio.getByText(/^Not enough use yet: 0\/5 active days and 0\/30 actions\./).waitFor();
    assert.equal(await add.count(), 0, "no suggestion survives the deletion");
    const [draft] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
    const patch = JSON.parse(draft.patches)[0];
    assert.deepEqual([patch.evidence, patch.suggestionSignature, patch.operations.length], [[], undefined, 1], "the accepted change stays, its link to deleted evidence does not");
    await studio.getByRole("button", { name: "Preview .workspace", exact: true }).click();
    const workspaceDownload = studio.waitForEvent("download");
    await studio.getByRole("button", { name: "Download .workspace", exact: true }).click();
    const exportedWorkspace = readFileSync(await (await workspaceDownload).path(), "utf8");
    assert.equal(exportedWorkspace.includes(evidence.id), false, "the .workspace names no deleted evidence");
    await dashboard.close();
  });
});

// ─── #15 ──────────────────────────────────────────────────────────────────────────────────────────

test("#15 a private request becomes a confirmed structured intent, and its text is gone from the draft, the export, the log and the network", { timeout: 180_000 }, async () => {
  // A local model as a fixture: it picks the option that makes Quick numbers larger, and proposes keeping it visible.
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const options = req.url === "/api/chat" ? JSON.parse(JSON.parse(body).messages[1].content).candidates ?? [] : [];
    const wanted = options.find(option => option.operation.type === "variant" && option.operation.anchorId === "dashboard.stats" && option.operation.variant === "expanded");
    res.writeHead(req.url === "/api/chat" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: JSON.stringify({ status: "ready", intent: { kind: "prioritize", anchorId: "dashboard.stats" }, candidateIds: wanted ? [wanted.id] : [], constraints: [{ kind: "keepVisible", anchorId: "dashboard.stats" }] }) } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const secret = "Dr Bianchi asked me privately: Quick numbers bigger before the 7731 audit";
  try {
    await withApp({ viewport: { width: 1280, height: 1400 }, env: { OLLAMA_URL: `http://127.0.0.1:${server.address().port}`, OLLAMA_MODEL: "fixture-model" } }, async ({ page, base, db, log }) => {
      const sent = [];
      page.on("request", request => sent.push({ url: request.url(), body: request.postDataBuffer()?.toString("utf8") ?? "" }));
      await page.goto(`${base}/settings/workspace`);
      const request = page.getByLabel("What would you like to change?", { exact: true });
      await request.fill(secret);
      await page.getByRole("button", { name: "Preview with local AI", exact: true }).click();
      await page.getByRole("heading", { name: "Request preview", exact: true }).waitFor();
      assert.ok(sent.some(item => item.url.includes("planner.interpret") && item.body.includes(secret)), "the text goes to this server once, to be translated");
      assert.equal(await request.inputValue(), "", "the field is emptied once translated");

      // The structured intent confirmed: from here on the text must not travel or stay anywhere.
      const confirmedAt = sent.length;
      await page.getByRole("button", { name: "Add selected changes to the draft", exact: true }).click();
      await preview(page).waitFor();
      await page.getByRole("button", { name: "Confirm rule", exact: true }).click();
      await page.getByRole("button", { name: "Confirm rule", exact: true }).waitFor({ state: "detached" });
      const [draft] = await db.q("SELECT patches FROM workspace_drafts WHERE status NOT IN ('applied','discarded','aborted')");
      const patch = JSON.parse(draft.patches).at(-1);
      assert.deepEqual([patch.author, patch.intent.kind, patch.intent.anchorId, patch.intent.status], ["user", "prioritize", "dashboard.stats", "explicit"], "the intent is structured and the user's");
      assert.equal("originalText" in patch, false);
      assert.equal(draft.patches.includes(secret), false, "not in the draft's patches");

      await page.getByRole("button", { name: "Preview .workspace", exact: true }).click();
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download .workspace", exact: true }).click();
      const exported = readFileSync(await (await downloaded).path(), "utf8");
      assert.equal(JSON.parse(exported).draft.patches.at(-1).intent.kind, "prioritize", "the export carries the intent");
      assert.equal(exported.includes(secret), false, "not in the .workspace export");

      await applyLayout(page);
      const [revision] = await db.q("SELECT operations, constraints FROM workspace_revisions");
      assert.ok(revision.operations.includes("expanded"));
      assert.deepEqual(JSON.parse(revision.constraints).map(constraint => [constraint.kind, constraint.anchorId, constraint.author]), [["keepVisible", "dashboard.stats", "user"]]);

      // Nowhere it was kept: no table, no browser storage, no page text, no request after the confirmation, no server log.
      for (const { table_name: table } of await db.q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'workspace%'")) {
        assert.equal(await count(db, `"${table}" t WHERE t::text LIKE ?`, `%${secret}%`), 0, `not in ${table}`);
      }
      assert.equal(await page.evaluate(text => [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.body.innerText].some(value => value.includes(text)), secret), false, "not in browser storage or on the page");
      const later = sent.slice(confirmedAt);
      assert.ok(later.some(item => item.url.includes("workspace.commit")), "the requests after confirmation were seen");
      assert.deepEqual(later.filter(item => item.url.includes(secret) || item.body.includes(secret) || item.url.includes(encodeURIComponent(secret))).map(item => item.url), [], "no request after the confirmation carries it");
      assert.ok(log().length > 0, "the server's output was captured");
      assert.equal(log().includes(secret), false, "not in the server's log output");
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
