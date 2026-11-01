import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { withApp } from "./harness.mjs";

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
    await page.getByRole("checkbox", { name: "Collect interaction maps" }).click();
    await page.getByRole("checkbox", { name: "Collect interaction maps" }).waitFor();
    await page.waitForFunction(() => document.querySelector('[role="checkbox"][aria-label="Collect interaction maps"]')?.getAttribute("aria-checked") === "true");
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Customize dashboard", exact: true }).click();
    await page.keyboard.press("Escape");
    // Exposures count after a second on screen; leaving the page then sends them (pagehide beacon).
    await page.waitForTimeout(1_300);
    await page.goto(`${base}/settings/workspace`);
    assert.ok(await waitForCount(db, "workspace_flow_events", 1) > 0, "the real collector recorded an allowlisted interaction");
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await page.getByRole("button", { name: "Preview .flowmap", exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Preview .flowmap", exact: true }).first().click();
    await page.getByRole("img", { name: "FlowMap picture drawn on this server" }).waitFor();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download .flowmap", exact: true }).click();
    const download = await downloaded;
    const contents = readFileSync(await download.path(), "utf8");
    const document = JSON.parse(contents);
    assert.equal(document.format, "flowmap");
    assert.equal(document.svg.includes("<script"), false);
    assert.equal("events" in document, false);
    assert.equal("userId" in document, false);
    await page.getByLabel("Import .flowmap", { exact: true }).setInputFiles({ name: "shared.flowmap", mimeType: "application/json", buffer: Buffer.from(contents) });
    await page.getByText("Imported · kept apart", { exact: true }).waitFor();
    assert.equal(await waitForCount(db, "workspace_flow_imports", 1), 1);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
    await page.getByRole("button", { name: "Delete FlowMap data", exact: true }).click();
    const deleting = page.waitForResponse(response => response.url().includes("flowMap.delete"));
    await page.getByRole("button", { name: "Delete data", exact: true }).click();
    const deleted = await deleting;
    assert.equal(deleted.status(), 200, await deleted.text());
    for (const table of ["workspace_flow_events", "workspace_flow_aggregates", "workspace_flow_imports", "workspace_flow_feedback"]) {
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
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await page.getByRole("button", { name: "Preview .flowmap", exact: true }).first().waitFor();
    await page.getByRole("radio", { name: "Expectation", exact: true }).click();
    await page.getByRole("button", { name: "Relevant", exact: true }).click();
    await page.getByText(/\d+ times? · \d+% sure · confirmed/).waitFor();
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
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await page.getByRole("button", { name: "Preview .flowmap", exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Suggest improvements", exact: true }).click();
    await page.getByRole("button", { name: "Add selected changes to the draft", exact: true }).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0, "generation never applies a candidate");
    await page.getByRole("button", { name: "Add selected changes to the draft", exact: true }).click();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 1);
    // What was suggested and accepted: My issues brought next to the timeline, nothing else moved.
    const [applied] = await db.q("SELECT operations FROM workspace_revisions WHERE revision_number = 1");
    assert.deepEqual(JSON.parse(applied.operations).map(item => item.operation.type === "reorder" ? [item.operation.areaId, item.operation.anchorIds] : item.operation.type), [["dashboard.primary", ["dashboard.summary", "dashboard.tasks", "dashboard.timeline", "dashboard.activity", "dashboard.recap"]]]);
    await page.getByRole("button", { name: "Preview .workspace", exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download .workspace", exact: true }).click();
    const contents = readFileSync(await (await downloaded).path(), "utf8");
    const document = JSON.parse(contents);
    assert.equal(document.format, "workspace");
    assert.equal("evidence" in document, false);
    assert.equal("originalText" in document, false);
    await page.getByLabel("Import .workspace", { exact: true }).setInputFiles({ name: "layout.workspace", mimeType: "application/json", buffer: Buffer.from(contents) });
    await Promise.race([
      page.getByText("Imported as a draft to review before applying.", { exact: true }).waitFor(),
      page.locator("#workspace-planner [role='alert']").waitFor().then(async () => { throw new Error(await page.locator("#workspace-planner [role='alert']").textContent()); }),
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
      const request = page.getByLabel("What would you like to change?", { exact: true });
      await request.fill("Make it better");
      await page.getByRole("button", { name: "Preview with local AI", exact: true }).click();
      await page.getByText("Which section should be more prominent?", { exact: true }).waitFor();
      assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
      await request.fill("Make statistics more prominent");
      await page.getByRole("button", { name: "Preview with local AI", exact: true }).click();
      await page.getByRole("heading", { name: "Request preview", exact: true }).waitFor();
      await page.getByText(/Quick numbers: Side column · Expanded/).waitFor();
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
      await page.getByRole("button", { name: "Confirm rule", exact: true }).click();
      await page.getByRole("button", { name: "Confirm rule", exact: true }).waitFor({ state: "detached" });
      assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
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

test("Each page's use over time shows at once, one map per period, oldest first", async () => {
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
    // No click needed: the section is there, the periods in time order, each drawing the page's blocks.
    const timeline = page.getByRole("list", { name: "Use over time" });
    await timeline.waitFor();
    assert.deepEqual(await timeline.locator("figure").evaluateAll(figures => figures.map(figure => figure.getAttribute("data-period"))), ["evidence_earlier", "evidence_later"]);
    await timeline.locator('[data-period="evidence_later"]').getByText("Customize dashboard: 40 uses").waitFor({ state: "attached" });
    await timeline.locator('[data-period="evidence_later"]').getByText("40 uses", { exact: true }).waitFor();
    // The newest period is the one in view.
    assert.equal(await timeline.evaluate(list => list.scrollLeft + list.clientWidth >= list.scrollWidth - 2), true);
  });
});
