// What the layout workspace promises outside its Studio: nothing for who never customized,
// no layout swapped under a user's typing, no last write wins, and files that cannot elevate
// themselves. Each test is a regression of a defect found on 1 Nov (docs/work/flowmap-consolidation.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withApp, trpcProcs } from "./harness.mjs";

const WORKSPACE_PROCS = /^(workspace|flowMap|planner)\./;

// The two file checksums, as anyone who read the formats can compute them (contracts/workspace).
const sha256 = text => createHash("sha256").update(text).digest("hex");
function flowMapChecksum(body) {
  const normalize = value => {
    if (typeof value === "string") return value.normalize("NFC");
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  return sha256(`flowmap-v1\n${JSON.stringify(normalize(body))}`);
}
function workspaceChecksum(body) {
  const canonical = value => {
    if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
    if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const keys = Object.keys(value).filter(key => value[key] !== undefined).map(key => [key.normalize("NFC"), key]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map(([normalized, key]) => `${JSON.stringify(normalized)}:${canonical(value[key])}`).join(",")}}`;
  };
  return sha256(`inkledger-workspace-fingerprint-workspace-v1\n${canonical(body)}`);
}

function recordProcedures(page) {
  const seen = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/trpc/")) seen.push(...trpcProcs(url));
  });
  return seen;
}

async function waitUntil(check, what) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

for (const viewport of [{ width: 1400, height: 900 }, { width: 375, height: 800 }]) {
  test(`A user who never customized asks nothing of the workspace and writes nothing (${viewport.width}px)`, () =>
    withApp({ viewport }, async ({ page, base, db }) => {
      const seen = recordProcedures(page);
      for (const path of ["/", "/issues", "/settings", "/"]) {
        await page.goto(base + path);
        await page.locator("main").first().waitFor();
        await page.waitForTimeout(400);
      }
      assert.deepEqual(seen.filter(name => WORKSPACE_PROCS.test(name)), []);
      for (const table of ["workspace_presentations", "workspace_descriptors", "workspace_revisions", "workspace_drafts"]) {
        assert.equal((await db.q(`SELECT count(*)::int AS n FROM ${table}`))[0].n, 0, `${table} stays empty`);
      }
    }));
}

test("Customize lists the six Dashboard sections by name and its first change makes the layout live", () =>
  withApp({}, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Customize dashboard" }).click();
    const items = page.getByRole("dialog").getByRole("checkbox");
    await items.first().waitFor();
    const labels = await page.getByRole("dialog").locator("label").allTextContents();
    assert.deepEqual(labels.map(label => label.trim()), ["Period trend", "Quick numbers", "Summary", "My issues", "Recent activity", "Your week"]);
    await page.getByRole("dialog").getByRole("checkbox", { name: "Recent activity" }).click();
    await page.getByRole("heading", { name: "Recent activity" }).waitFor({ state: "detached" });
    await waitUntil(async () => (await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n === 1, "the first revision");
    const seen = recordProcedures(page);
    await page.reload();
    await page.locator("main").first().waitFor();
    assert.equal(await page.getByRole("heading", { name: "Recent activity" }).count(), 0, "still hidden after a reload");
    await waitUntil(() => seen.some(name => name === "workspace.get"), "the now customized Dashboard to ask for its layout");
  }));

test("A customized phone Dashboard never shows the default first", () =>
  withApp({
    viewport: { width: 390, height: 800 },
    seed: async db => {
      const hide = JSON.stringify([{ operation: { type: "visibility", operationId: "hide-activity", anchorId: "dashboard.activity", visible: false }, origin: "user", acceptedByUser: true }]);
      for (const deviceClass of ["desktop", "mobile"]) {
        await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES (?, 1, 'dashboard', ?, 1, '1.0.0', 'product-1', ?, ?, '[]')", `seeded-${deviceClass}`, deviceClass, Date.now(), hide);
      }
    },
  }, async ({ page, base }) => {
    // From the very first paint: the hidden section must never appear, not even for a frame.
    await page.addInitScript(() => {
      window.__sawActivity = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-workspace-anchor="dashboard.activity"]')) window.__sawActivity = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Log time", exact: true }).first().waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.__sawActivity), false);
  }));

test("Cancelling a half-typed time entry does not hold the layout back afterwards", () =>
  withApp({}, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Log time", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Log time" });
    await dialog.getByRole("textbox", { name: "Comment" }).fill("half a thought");
    // Closed by its X, not by Escape or by logging: the typed text goes with the dialog.
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Customize dashboard" }).click();
    await page.getByRole("dialog").getByRole("checkbox", { name: "Your week" }).click();
    await waitUntil(async () => (await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n === 1, "the change to apply");
    assert.equal(await page.getByText("Finish what you are typing, then try again").count(), 0);
  }));

test("Two tabs editing the layout: the second is told it changed, nothing is overwritten", () =>
  withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db, context }) => {
    const other = await context.newPage();
    await page.goto(`${base}/settings/workspace`);
    await other.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.stats"]').getByRole("checkbox", { name: "Visible" }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    // The second tab still shows the layout before the first tab's draft, and edits it.
    await other.locator('[data-anchor="dashboard.activity"]').getByRole("checkbox", { name: "Visible" }).click();
    await other.getByRole("alert").filter({ hasText: "The layout changed meanwhile: reload it and try again." }).waitFor();
    const [draft] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
    const touched = JSON.parse(draft.patches).flatMap(patch => patch.operations.map(operation => operation.anchorId));
    assert.deepEqual(touched, ["dashboard.stats"], "the first tab's intent is still the draft");
    await other.reload();
    await other.getByText(/Preview, not applied yet/).waitFor();
    await other.locator('[data-anchor="dashboard.activity"]').getByRole("checkbox", { name: "Visible" }).click();
    await waitUntil(async () => {
      const [latest] = await db.q("SELECT patches FROM workspace_drafts ORDER BY updated_at DESC LIMIT 1");
      return JSON.parse(latest.patches).length === 2;
    }, "both intents in one draft once the second tab is up to date");
  }));

test("A forged .flowmap is kept apart, redrawn and never turns into a layout", () =>
  withApp({ seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()) }, async ({ page, base, db }) => {
    const descriptor = { effectiveRevision: "eff-forged", sourceActiveRevision: "default", workspaceFingerprint: "fp", productDefaultVersion: "product-1", catalogVersion: "1.0.0", resolverVersion: 1, constraintsFingerprint: "c", feedbackFingerprint: "f", discoveryFingerprint: "d", rendererBindingsFingerprint: "r" };
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" };
    const body = {
      format: "flowmap", version: 1, generatedAt: Date.now(), scope, view: "heat",
      evidence: { evidenceId: "evidence_forged", scope, descriptor, semanticRevision: 1, algorithmVersion: 1, origin: "local", coverage: { firstAt: Date.now() - 86_400_000, lastAt: Date.now(), activeDays: 9, sessions: 9, exposures: 9, droppedEvents: 0, gaps: 0 }, heat: [], flows: [], friction: [], expectations: [] },
      catalog: { catalogVersion: "1.0.0", areas: [], anchors: [], controls: [], tombstones: [] },
      workspace: { placements: [], catalogVersion: "1.0.0", productDefaultVersion: "product-1", resolverVersion: 1 },
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>FORGED</text></svg>',
    };
    const checksum = flowMapChecksum(body);
    const file = join(tmpdir(), `forged-${Date.now()}.flowmap`);
    writeFileSync(file, JSON.stringify({ ...body, checksum }));
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("checkbox", { name: "Collect interaction maps", checked: true }).waitFor();
    await page.locator('input[type="file"][accept*="flowmap"]').setInputFiles(file);
    await page.getByText("Imported · kept apart").waitFor();
    const imports = await db.q("SELECT document FROM workspace_flow_imports");
    assert.equal(imports.length, 1, "a well-formed file is accepted, then distrusted");
    for (const row of imports) {
      const stored = JSON.parse(row.document);
      assert.equal(stored.evidence.origin, "import");
      assert.equal(stored.svg.includes("FORGED"), false, "the picture is drawn here, not kept as sent");
    }
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_drafts"))[0].n, 0);
  }));

test("Searches that find nothing say something may be missing, without naming it", () =>
  withApp({
    viewport: { width: 1280, height: 1400 },
    seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()),
  }, async ({ page, base, db }) => {
    await page.goto(base + "/");
    await waitUntil(async () => (await db.q("SELECT count(*)::int AS n FROM workspace_descriptors WHERE surface_id = 'shell-desktop'"))[0].n > 0, "the sidebar's presented layout");
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'shell-desktop' LIMIT 1");
    const descriptor = JSON.parse(stored.descriptor);
    let sequence = 0;
    // Enough use to reason on (5 days, 30 activations), and searches that end with nothing chosen.
    for (let index = 0; index < 30; index++) {
      const at = Date.now() - (index % 5) * 86_400_000;
      for (const kind of ["control.activate", "search.opened", "search.abandoned"]) {
        const event = { eventSchemaVersion: 1, id: `search-${index}-${kind}`, kind, scope: { surfaceId: "shell-desktop", deviceClass: "desktop" }, controlId: "shell.search.open", anchorId: "shell.search", semanticRevision: 1, descriptor, clientInstanceId: "ssr", presentationEpoch: 1, sessionId: `session-${index}`, sequence: ++sequence, occurredAt: at, modality: "keyboard" };
        await db.q("INSERT INTO workspace_flow_events (user_id, id, surface_id, device_class, effective_revision, occurred_at, payload, received_at) VALUES (1, ?, 'shell-desktop', 'desktop', ?, ?, ?, ?)", event.id, descriptor.effectiveRevision, at, JSON.stringify(event), at);
      }
    }
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("radio", { name: "Sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Update evidence", exact: true }).click();
    await page.getByRole("radio", { name: "Expectation", exact: true }).click();
    const gap = page.getByRole("rowheader", { name: /^Something looked for may be missing/ });
    await gap.first().waitFor();
    assert.equal((await gap.first().textContent()).includes("→"), false, "no destination is invented");
  }));

test("An imported layout from a newer version stays read-only", () =>
  withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db }) => {
    await page.goto(`${base}/settings/workspace`);
    await page.getByRole("button", { name: "Preview .workspace", exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download .workspace", exact: true }).click();
    const exported = JSON.parse(await (await (await downloaded).createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString("utf8")));
    // As a newer version would write it: an entry this one cannot read, with its digest and a fresh checksum.
    const payload = Buffer.from('{"future":true}');
    exported.revision.opaque = [{ version: 1, entryType: "future.layout", schemaVersion: 2, payloadBase64url: payload.toString("base64url"), sha256: createHash("sha256").update(payload).digest("hex"), byteLength: payload.length }];
    delete exported.checksum;
    exported.checksum = workspaceChecksum(exported);
    const file = join(tmpdir(), `future-${Date.now()}.workspace`);
    writeFileSync(file, JSON.stringify(exported));
    await page.locator('input[type="file"][accept*="workspace"]').setInputFiles(file);
    await page.getByText(/come from a newer version/).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_imports WHERE has_unknown_content"))[0].n, 1, "accepted into quarantine, content kept");
    // Applying it is refused: what is shown is the read-only notice, never a new revision.
    const apply = page.getByRole("button", { name: "Apply layout", exact: true });
    if (await apply.count()) {
      await apply.click();
      await page.getByRole("alert").filter({ hasText: /newer version/ }).waitFor();
    }
    assert.equal((await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n, 0, "nothing applied");
  }));
