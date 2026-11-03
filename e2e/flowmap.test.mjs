import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { withApp } from "./harness.mjs";
import { closeOverlay, collectionSwitch, layerChip, openPlanner, updatePeriods, workspaceMore } from "./workspace-helpers.mjs";

/** At least `expected` rows (exactly 0 when expected is 0), or the test fails: a timeout is never an answer. */
async function waitForCount(db, table, expected) {
  for (let i = 0; i < 80; i++) {
    const [row] = await db.q(`SELECT count(*)::int AS n FROM ${table}`);
    if (expected === 0 ? row.n === 0 : row.n >= expected) return row.n;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`${table}: expected ${expected === 0 ? "no rows" : `at least ${expected}`}`);
}

test("FlowMap is opt-in, exports only aggregates and deletes all derived data", { timeout: 120_000 }, async () => {
  await withApp({}, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await (await collectionSwitch(page)).click();
    await page.waitForFunction(() => document.querySelector('[role="checkbox"][aria-label="Collect interaction maps"]')?.getAttribute("aria-checked") === "true");
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Customize dashboard", exact: true }).click();
    await page.keyboard.press("Escape");
    // Exposures count after a second on screen; leaving the page then sends them (pagehide beacon).
    await page.waitForTimeout(1_300);
    await page.goto(`${base}/settings/workspace`);
    assert.ok(await waitForCount(db, "workspace_flow_events", 1) > 0, "the real collector recorded an allowlisted interaction");
    await updatePeriods(page);
    // The usage map of the period shown: downloaded at once, no picture put on the page.
    const downloaded = page.waitForEvent("download");
    await workspaceMore(page, "Export usage map (.flowmap)");
    const download = await downloaded;
    assert.equal(await page.locator("img[alt*='FlowMap'], img[src^='blob:']").count(), 0, "no picture on the page");
    const contents = readFileSync(await download.path(), "utf8");
    const document = JSON.parse(contents);
    assert.equal(document.format, "flowmap");
    assert.equal(document.svg.includes("<script"), false);
    assert.equal("events" in document, false);
    assert.equal("userId" in document, false);
    await page.getByLabel("Import usage map (.flowmap)", { exact: true }).setInputFiles({ name: "shared.flowmap", mimeType: "application/json", buffer: Buffer.from(contents) });
    await page.locator("[data-status-slot]").getByText(/^Usage map imported and kept apart/).waitFor();
    assert.equal(await waitForCount(db, "workspace_flow_imports", 1), 1);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
    await workspaceMore(page, "Delete usage data");
    const deleting = page.waitForResponse(response => response.url().includes("flowMap.delete"));
    await page.getByRole("button", { name: "Delete data", exact: true }).click();
    const deleted = await deleting;
    assert.equal(deleted.status(), 200, await deleted.text());
    for (const table of ["workspace_flow_events", "workspace_flow_aggregates", "workspace_flow_imports", "workspace_flow_feedback", "workspace_planner_feedback"]) {
      assert.equal(await waitForCount(db, table, 0), 0);
    }
    assert.equal((await db.q("SELECT enabled FROM workspace_flow_settings"))[0].enabled, false);
  });
});

/** Period → log time: what an Expectation reads (log time wanted by the period). */
const EXPECTATION_STEPS = [[1, "dashboard.period.next", "dashboard.period", "control.activate"], [2, "dashboard.logTime", "dashboard.quickActions", "control.activate"], [3, "dashboard.logTime", "dashboard.quickActions", "action.succeeded"]];
/** My issues → timeline: neighbours the planner can bring closer (the header's pinned ones never move). */
const PLANNER_STEPS = [[1, "dashboard.tasks.openBoard", "dashboard.tasks", "control.activate"], [2, "dashboard.timeline.gap", "dashboard.timeline", "control.activate"], [3, "dashboard.timeline.gap", "dashboard.timeline", "action.succeeded"]];

async function seedPlannerEvidence(db, page, base, steps = EXPECTATION_STEPS) {
  // FlowMap on first: only then does the Dashboard present (and store) its layout.
  await db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now());
  const presented = page.waitForResponse(response => response.url().includes("workspace.get"));
  await page.goto(base + "/");
  await presented;
  for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM workspace_descriptors WHERE surface_id = 'dashboard'"))[0].n === 0; i++) await new Promise(r => setTimeout(r, 100));
  const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
  const descriptor = JSON.parse(stored.descriptor);
  for (let index = 0; index < 15; index++) {
    const day = index % 5;
    const cycle = Math.floor(index / 5);
    const at = Date.now() - day * 86_400_000;
    for (const [step, controlId, anchorId, kind] of steps) {
      const event = { eventSchemaVersion: 1, id: `evidence-${index}-${step}`, kind, scope: { surfaceId: "dashboard", deviceClass: "desktop" }, controlId, anchorId, semanticRevision: 1, descriptor, clientInstanceId: "ssr", presentationEpoch: 1, sessionId: steps === PLANNER_STEPS ? `session-${index}` : `session-${day}`, sequence: cycle * 3 + step, occurredAt: at, modality: "keyboard" };
      await db.q("INSERT INTO workspace_flow_events (user_id, id, surface_id, device_class, effective_revision, occurred_at, payload, received_at) VALUES (1, ?, 'dashboard', 'desktop', ?, ?, ?, ?)", event.id, descriptor.effectiveRevision, at, JSON.stringify(event), at);
    }
  }
}

test("An Expectation becomes an explicit constraint only through preview and apply", { timeout: 120_000 }, async () => {
  await withApp({}, async ({ page, base, db }) => {
    await seedPlannerEvidence(db, page, base);
    await page.goto(`${base}/settings/workspace`);
    await updatePeriods(page);
    // Things looked for are on the page summary, beside the drawing.
    await page.getByRole("button", { name: /^Relevant: / }).first().click();
    await page.getByText(/\d+ times? · confirmed/).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0, "relevance feedback cannot apply a constraint");
    await page.getByRole("button", { name: "Use in layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    const [expectationDraft] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    const expectationPatch = JSON.parse(expectationDraft.patches).at(-1);
    assert.equal(expectationPatch.intent.kind, "expectHere");
    assert.equal(expectationPatch.intent.status, "explicit");
    assert.equal(expectationPatch.author, "user");
    assert.equal(expectationPatch.proposedConstraints[0].author, "user");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0, "the expectation is only a draft until apply");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    const [expectationRevision] = await db.q("SELECT constraints FROM workspace_revisions WHERE revision_number = 1");
    const [constraint] = JSON.parse(expectationRevision.constraints);
    assert.equal(constraint.kind, "expectHere");
    assert.equal(constraint.author, "user");
    assert.equal(constraint.anchorId, "dashboard.quickActions");
    assert.equal(constraint.areaId, "dashboard.header");
  });
});

test("Planner suggestions require acceptance and workspace imports remain quarantined", { timeout: 120_000 }, async () => {
  await withApp({}, async ({ page, base, db }) => {
    await seedPlannerEvidence(db, page, base, PLANNER_STEPS);
    await page.goto(`${base}/settings/workspace`);
    await updatePeriods(page);
    const planner = await openPlanner(page);
    await planner.getByRole("button", { name: "Suggest improvements", exact: true }).click();
    await page.getByRole("button", { name: "Add selected changes to the draft", exact: true }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0, "generation never applies a candidate");
    await page.getByRole("button", { name: "Add selected changes to the draft", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await closeOverlay(page);
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    // What was suggested and accepted: My issues brought next to the timeline, nothing else moved.
    const [applied] = await db.q("SELECT operations FROM workspace_revisions WHERE revision_number = 1");
    assert.deepEqual(JSON.parse(applied.operations).map(item => item.operation.type === "reorder" ? [item.operation.areaId, item.operation.anchorIds] : item.operation.type), [["dashboard.primary", ["dashboard.summary", "dashboard.tasks", "dashboard.timeline", "dashboard.activity", "dashboard.recap"]]]);
    const downloaded = page.waitForEvent("download");
    await workspaceMore(page, "Export layout (.workspace)");
    const contents = readFileSync(await (await downloaded).path(), "utf8");
    const document = JSON.parse(contents);
    assert.equal(document.format, "workspace");
    assert.equal("evidence" in document, false);
    assert.equal("originalText" in document, false);
    await page.getByLabel("Import layout (.workspace)", { exact: true }).setInputFiles({ name: "layout.workspace", mimeType: "application/json", buffer: Buffer.from(contents) });
    await Promise.race([
      page.getByText("Imported as a draft to review before applying.", { exact: true }).waitFor(),
      page.locator("[data-status-slot] [role='alert']").waitFor().then(async () => { throw new Error(await page.locator("[data-status-slot] [role='alert']").textContent()); }),
    ]);
    const [imported] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    const patch = JSON.parse(imported.patches)[0];
    assert.equal(patch.author, "import");
    assert.equal(patch.intent.status, "proposed");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1, "import alone cannot commit");
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 2, "only explicit apply creates a new revision");
  });
});

test("A private request is clarified, previewed and applied only after separate confirmations", { timeout: 120_000 }, async () => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/api/chat") bodies.push(body);
    const ambiguous = body.includes("Make it better");
    // As a model would: pick, among the options the server listed, the one that matches the request.
    const options = req.url === "/api/chat" ? JSON.parse(JSON.parse(body).messages[1].content).candidates ?? [] : [];
    const wanted = options.find(option => option.operation.type === "variant" && option.operation.anchorId === "dashboard.stats" && option.operation.variant === "expanded");
    const content = ambiguous
      ? { status: "clarify", question: "Which section should be more prominent?" }
      : { status: "ready", intent: { kind: "prioritize", anchorId: "dashboard.stats" }, candidateIds: wanted ? [wanted.id] : [], constraints: [{ kind: "keepVisible", anchorId: "dashboard.stats" }] };
    res.writeHead(req.url === "/api/chat" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: JSON.stringify(content) } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await withApp({ env: { OLLAMA_URL: `http://127.0.0.1:${address.port}`, OLLAMA_MODEL: "fixture-model", OLLAMA_SIMULATOR: "" } }, async ({ page, base, db }) => {
      await page.goto(`${base}/settings/workspace`);
      await openPlanner(page);
      const request = page.getByLabel("What would you like to change?", { exact: true });
      await request.fill("Make it better");
      await page.getByRole("button", { name: "Preview with local AI", exact: true }).click();
      await page.getByText("Which section should be more prominent?", { exact: true }).waitFor();
      assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
      await request.fill("Make statistics more prominent");
      await page.getByRole("button", { name: "Preview with local AI", exact: true }).click();
      await page.getByRole("heading", { name: "Request preview", exact: true }).waitFor();
      await page.getByText(/Quick numbers: Above the timeline · Expanded/).waitFor();
      assert.equal(await request.inputValue(), "", "the original text is discarded after translation");
      assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
      await page.getByRole("button", { name: "Add selected changes to the draft", exact: true }).click();
      await page.getByText(/Preview, not applied yet/).waitFor();
      const [translated] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
      assert.equal(translated.patches.includes("Make statistics more prominent"), false);
      const patch = JSON.parse(translated.patches).at(-1);
      assert.equal(patch.author, "user");
      assert.equal(patch.intent.status, "explicit");
      assert.equal(patch.proposedConstraints[0].status, "proposed");
      await page.getByRole("button", { name: /^Confirm rule: / }).click();
      await page.getByRole("button", { name: /^Confirm rule: / }).waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
      await closeOverlay(page);
      await page.getByRole("button", { name: "Apply layout", exact: true }).click();
      await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
      const [committed] = await db.q("SELECT operations, constraints FROM workspace_revisions WHERE revision_number = 1");
      assert.equal(committed.operations.includes("expanded"), true);
      assert.deepEqual(JSON.parse(committed.constraints).map(constraint => [constraint.kind, constraint.status, constraint.author]), [["keepVisible", "explicit", "user"]]);
      assert.equal(bodies.length, 2);
      assert.ok(bodies.some(body => body.includes("Make it better")));
      assert.ok(bodies.some(body => body.includes("Make statistics more prominent")));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("Adaptation review compares successful outcomes without claiming causality", async () => {
  await withApp({
    seed: async db => {
      await db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now());
    },
  }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    // The Dashboard stores its presented layout on its first read (FlowMap is on).
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM workspace_descriptors WHERE surface_id = 'dashboard'"))[0].n === 0; i++) await new Promise(r => setTimeout(r, 100));
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
    const descriptor = JSON.parse(stored.descriptor);
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" };
    const evidence = (id, effectiveRevision, activations, successes, exposures, daysAgo) => ({
      evidenceId: id,
      scope,
      descriptor: { ...descriptor, effectiveRevision },
      semanticRevision: 1,
      algorithmVersion: 1,
      origin: "local",
      coverage: { firstAt: Date.now() - (daysAgo + 5) * 86_400_000, lastAt: Date.now() - daysAgo * 86_400_000, activeDays: 5, sessions: 5, exposures: 10, droppedEvents: 0, gaps: 0 },
      heat: [{ controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", semanticRevision: 1, activations, successes, failures: 0, exposures, activationRate: activations / exposures, modalities: { pointer: 0, touch: 0, keyboard: activations, unknown: 0 }, cells: Array.from({ length: 8 }, () => Array(8).fill(0)) }],
      flows: [], friction: [], expectations: [],
    });
    const before = evidence("before-eval", "eff-before", 60, 5, 10, 20);
    const after = evidence("after-eval", descriptor.effectiveRevision, 30, 10, 30, 0);
    for (const item of [before, after]) {
      await db.q("INSERT INTO workspace_flow_aggregates (user_id, id, surface_id, device_class, effective_revision, origin, payload, created_at) VALUES (1, ?, 'dashboard', 'desktop', ?, 'local', ?, ?)", item.evidenceId, item.descriptor.effectiveRevision, JSON.stringify(item), Date.now());
    }
    await page.goto(`${base}/settings/workspace`);
    await openPlanner(page, "Compare two periods");
    // Evidence is named by when it was collected: pick each by its first day, as a user would.
    const pick = async (name, item) => {
      const first = await page.evaluate(at => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at), item.coverage.firstAt);
      await page.getByRole("combobox", { name, exact: true }).click();
      await page.getByRole("option", { name: new RegExp(`^${first} –`) }).click();
    };
    await pick("Baseline evidence", before);
    await pick("Current evidence", after);
    await page.getByRole("button", { name: "Compare adaptations", exact: true }).click();
    await page.getByText("Improved", { exact: true }).waitFor();
    await page.getByText("12.00 → 3.00 activations per successful action", { exact: true }).waitFor();
    await page.getByText("A correlation, not a proof of cause.", { exact: true }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
  });
});

test("Each page's use over time: one period per choice of the Use layer, the newest first", async () => {
  await withApp({
    viewport: { width: 1280, height: 1400 },
    seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()),
  }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM workspace_descriptors WHERE surface_id = 'dashboard'"))[0].n === 0; i++) await new Promise(r => setTimeout(r, 100));
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
    const descriptor = JSON.parse(stored.descriptor);
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" };
    const day = 86_400_000;
    const period = (id, daysAgo, uses) => ({
      evidenceId: id, scope, descriptor, semanticRevision: 1, algorithmVersion: 1, origin: "local",
      coverage: { firstAt: Date.now() - (daysAgo + 7) * day, lastAt: Date.now() - daysAgo * day, activeDays: 5, sessions: 5, exposures: 10, droppedEvents: 0, gaps: 0 },
      heat: [{ controlId: "dashboard.customize.open", anchorId: "dashboard.customize", semanticRevision: 1, activations: uses, successes: 0, failures: 0, exposures: 10, activationRate: uses / 10, modalities: { pointer: uses, touch: 0, keyboard: 0, unknown: 0 }, cells: Array.from({ length: 8 }, () => Array(8).fill(0)) }],
      flows: [], friction: [], expectations: [],
    });
    for (const item of [period("evidence_later", 0, 40), period("evidence_earlier", 14, 4)]) {
      await db.q("INSERT INTO workspace_flow_aggregates (user_id, id, surface_id, device_class, effective_revision, origin, payload, created_at) VALUES (1, ?, 'dashboard', 'desktop', ?, 'local', ?, ?)", item.evidenceId, descriptor.effectiveRevision, JSON.stringify(item), item.coverage.lastAt);
    }
    await page.goto(`${base}/settings/workspace`);
    // Use on: every period is a choice, the newest the one drawn, each drawn on the page's blocks.
    await layerChip(page, "Use").click();
    const customize = page.locator('[data-layout-canvas] [data-anchor="dashboard.customize"]');
    await customize.getByText("Customize dashboard: 40 uses", { exact: true }).waitFor({ state: "attached" });
    await customize.locator("[data-use-badge]").getByText("40", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "Period of use" }).click();
    assert.equal(await page.getByRole("option").count(), 2, "one choice per period");
    await page.getByRole("option").nth(1).click();
    await customize.getByText("Customize dashboard: 4 uses", { exact: true }).waitFor({ state: "attached" });
  });
});

test("The Use layer lays the chosen period over the editor's blocks: tint, dots where clicked, counts on the most used", async () => {
  await withApp({
    viewport: { width: 1280, height: 1400 },
    seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()),
  }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM workspace_descriptors WHERE surface_id = 'dashboard'"))[0].n === 0; i++) await new Promise(r => setTimeout(r, 100));
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
    const descriptor = JSON.parse(stored.descriptor);
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" };
    const day = 86_400_000;
    const grid = (marks = []) => {
      const cells = Array.from({ length: 8 }, () => Array(8).fill(0));
      for (const [x, y, n] of marks) cells[y][x] = n;
      return cells;
    };
    const point = (controlId, anchorId, uses, cells = grid()) => ({ controlId, anchorId, semanticRevision: 1, activations: uses, successes: 0, failures: 0, exposures: 50, activationRate: uses / 50, modalities: { pointer: uses, touch: 0, keyboard: 0, unknown: 0 }, cells });
    const period = (id, daysAgo, heat) => ({
      evidenceId: id, scope, descriptor, semanticRevision: 1, algorithmVersion: 1, origin: "local",
      coverage: { firstAt: Date.now() - (daysAgo + 7) * day, lastAt: Date.now() - daysAgo * day, activeDays: 5, sessions: 5, exposures: 50, droppedEvents: 0, gaps: 0 },
      heat, flows: [], friction: [], expectations: [],
    });
    // Customize: 30 clicks near its top right, 10 at its bottom left (cells[y][x]).
    const later = period("evidence_later", 1, [
      point("dashboard.customize.open", "dashboard.customize", 40, grid([[6, 1, 30], [0, 5, 10]])),
      point("dashboard.tasks.openBoard", "dashboard.tasks", 20),
      point("dashboard.timeline.gap", "dashboard.timeline", 10),
      point("dashboard.activity", "dashboard.activity", 5),
    ]);
    const earlier = period("evidence_earlier", 14, [point("dashboard.customize.open", "dashboard.customize", 4)]);
    for (const item of [later, earlier]) {
      await db.q("INSERT INTO workspace_flow_aggregates (user_id, id, surface_id, device_class, effective_revision, origin, payload, created_at) VALUES (1, ?, 'dashboard', 'desktop', ?, 'local', ?, ?)", item.evidenceId, descriptor.effectiveRevision, JSON.stringify(item), item.coverage.lastAt);
    }
    await page.goto(`${base}/settings/workspace`);
    const canvas = page.locator("[data-layout-canvas]");
    await canvas.waitFor();
    assert.equal(await canvas.locator("[data-heat]").count(), 0, "use is not laid over until asked");
    const show = layerChip(page, "Use");
    await show.click();
    assert.equal(await show.getAttribute("aria-pressed"), "true");
    // The newest period by default: the block says its use, the dots sit where the clicks landed, nowhere else.
    const customize = canvas.locator('[data-anchor="dashboard.customize"]');
    await customize.getByText("Customize dashboard: 40 uses", { exact: true }).waitFor({ state: "attached" });
    assert.deepEqual((await customize.locator("[data-hit]").evaluateAll(dots => dots.map(dot => dot.getAttribute("data-hit")))).sort(), ["0,5", "6,1"]);
    assert.equal(await canvas.locator('[data-anchor="dashboard.tasks"] [data-hit]').count(), 0, "no pointer spots, no dots");
    assert.equal(await canvas.locator('[data-anchor="dashboard.summary"] [data-heat]').count(), 0, "an unused block stays flat");
    // Counts printed on the three most used blocks only; the others say theirs to hover and screen readers.
    const badged = await canvas.locator("[data-use-badge]").evaluateAll(badges => badges.map(badge => [badge.closest("[data-anchor]").getAttribute("data-anchor"), badge.textContent]));
    assert.deepEqual(badged.sort(), [["dashboard.customize", "40"], ["dashboard.tasks", "20"], ["dashboard.timeline", "10"]]);
    await canvas.locator('[data-anchor="dashboard.activity"]').getByText("Recent activity: 5 uses", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await canvas.locator('[data-anchor="dashboard.activity"]').getAttribute("title"), "Recent activity: 5 uses");
    // Another period, picked, is laid over instead.
    await page.getByRole("combobox", { name: "Period of use" }).click();
    await page.getByRole("option").last().click();
    await customize.getByText("Customize dashboard: 4 uses", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await canvas.locator('[data-anchor="dashboard.tasks"] [data-heat]').count(), 0);
    // Off again: the page flat.
    await show.click();
    assert.equal(await show.getAttribute("aria-pressed"), "false");
    assert.equal(await canvas.locator("[data-heat]").count(), 0);
    assert.equal(await canvas.locator("[data-use-badge]").count(), 0);
  });
});

test("With FlowMap on and nothing used yet, the editor's page stays flat and says why", async () => {
  await withApp({
    viewport: { width: 1280, height: 1000 },
    seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()),
  }, async ({ page, base }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByText("No clicks yet in this period", { exact: true }).waitFor();
    assert.equal(await layerChip(page, "Use").isDisabled(), true);
    const canvas = page.locator("[data-layout-canvas]");
    assert.ok(await canvas.locator("[data-anchor]").count() >= 5, "the page's blocks are drawn");
    assert.equal(await canvas.locator("[data-heat]").count(), 0, "flat: no use over any block");
  });
});

test("Use shows at once: on the editor's blocks and as this week so far, with nothing stored by looking", { timeout: 120_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    await seedPlannerEvidence(db, page, base, PLANNER_STEPS);
    await page.goto(`${base}/settings/workspace`);
    // No "Update usage periods", no daily period yet: this week's use is there already.
    const show = layerChip(page, "Use");
    await show.click();
    assert.equal(await show.getAttribute("aria-pressed"), "true");
    await page.getByRole("combobox", { name: "Period of use" }).getByText("This week so far", { exact: true }).waitFor();
    const tasks = page.locator('[data-layout-canvas] [data-anchor="dashboard.tasks"]');
    await tasks.getByText(/^My issues: \d+ uses?$/).waitFor({ state: "attached" });
    assert.ok(Number((await tasks.locator("[data-use-badge]").textContent()).trim()) > 0, "the block used shows its count");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_flow_aggregates"))[0].n, 0, "looking stores no period");
  });
});

test("With FlowMap off the editor says how to see use, and takes you to its switch", async () => {
  await withApp({ viewport: { width: 1280, height: 1000 } }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Turn on usage collection", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Collect interaction maps");
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_flow_settings WHERE enabled"))[0].n, 0, "never turned on for the user");
  });
});

test("Clicks across the Dashboard count: the period, the quick actions and their dialogs", { timeout: 120_000 }, () =>
  withApp({ seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()) }, async ({ page, base, db }) => {
    // Clicked at once: the collector's code is still loading, and the clicks must count all the same.
    await page.goto(base + "/");
    await page.getByRole("radio", { name: "Week" }).click();
    await page.getByRole("radio", { name: "Day" }).click();
    await page.getByRole("button", { name: "Log time", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    // On within the app, as a user goes: leaving the Dashboard sends what it collected.
    await page.locator('a[href="/settings"]').first().click();
    await page.waitForURL(/\/settings/);
    const counted = async () => (await db.q("SELECT DISTINCT payload::json->>'controlId' AS id FROM workspace_flow_events WHERE surface_id = 'dashboard' AND payload::json->>'kind' = 'control.activate'")).map(row => row.id).sort();
    for (let i = 0; i < 80 && (await counted()).length < 4; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await counted(), ["dashboard.logTime", "dashboard.period.day", "dashboard.period.week", "dashboard.quickLog.cancel"]);
  }));
