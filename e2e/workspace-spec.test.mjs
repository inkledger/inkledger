// The adaptive workspace spec's test matrix (studio/flowmap-adaptive-workspace.md §21, §22), the
// cases its other suites leave out: each test names the invariant or scenario it holds the app to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdRoute, start, startTimer, trpcProcs, withApp } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const STUDIO_VIEWPORT = { width: 1280, height: 1400 };

/** Until the page has started no request for a while: a late one would still be seen (polls never block it). */
async function quiet(page, ms = 700) {
  let last = Date.now();
  const seen = () => { last = Date.now(); };
  page.on("request", seen);
  const deadline = Date.now() + 10_000;
  while (Date.now() - last < ms && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  page.off("request", seen);
}

async function waitUntil(check, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const count = async (db, table, where = "true") => (await db.q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n;
const callsProcedure = name => url => url.pathname.startsWith("/api/trpc/") && trpcProcs(url).includes(name);

test("E2E #7: applying while a field holds typed text and a timer runs defers activation, keeps both, then activates", { timeout: 180_000 }, () =>
  withApp({ viewport: STUDIO_VIEWPORT }, async ({ page, base, db }) => {
    await page.goto(base + "/issues/DEMO-101");
    await startTimer(page, "DEMO-101");
    await page.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    // The commit leaves only once the user has started typing: the task begins between prepare and the server's commit.
    const hold = await holdRoute(page, callsProcedure("workspace.commit"));
    const committing = page.waitForRequest(request => callsProcedure("workspace.commit")(new URL(request.url())));
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await committing;
    await page.locator('[data-workspace-control="shell.quickStart.open"]').click();
    const input = page.getByPlaceholder("Start timer on… (key or title)");
    await input.fill("half a thought");
    hold.release();
    await waitUntil(async () => await count(db, "workspace_revisions", "status = 'committed'") === 1, "the commit");
    await quiet(page);
    // DEFER: the tab still presents the layout it had; the saved one is committed, not shown.
    const [presented] = await db.q("SELECT status, presented_descriptor::json->>'sourceActiveRevision' AS source FROM workspace_presentations WHERE surface_id = 'dashboard'");
    assert.equal(presented.source, "default", "the open tab was not swapped while typing");
    assert.equal(await input.inputValue(), "half a thought", "the typed text is intact");
    assert.equal(await count(db, "timers", "issue_key = 'DEMO-101' AND state = 'running'"), 1, "the timer still runs");
    assert.equal(await count(db, "workspace_drafts", "status NOT IN ('applied', 'discarded', 'aborted')"), 0, "the committed draft is not left open to apply again");
    // The field is let go: the saved layout now shows in this tab, without applying again.
    await input.fill("");
    await page.keyboard.press("Escape");
    await input.waitFor({ state: "detached" });
    const [committed] = await db.q("SELECT id FROM workspace_revisions WHERE status = 'committed'");
    await waitUntil(async () => {
      const [row] = await db.q("SELECT status, presented_descriptor::json->>'sourceActiveRevision' AS source FROM workspace_presentations WHERE surface_id = 'dashboard'");
      return row.status === "stable" && row.source === committed.id;
    }, "the saved layout to be activated once the field is let go", 150);
    assert.equal(await count(db, "workspace_revisions"), 1, "activated, never committed twice");
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal(await page.getByText(/apply again when you're done/).count(), 0, "nothing asks to apply again what is saved");
    assert.equal(await count(db, "workspace_drafts", "status NOT IN ('applied', 'discarded', 'aborted')"), 0, "the committed draft is not left open to apply again");
  }));

test("C-02: app keyboard shortcuts on the Dashboard and in the Studio never change the layout", { timeout: 180_000 }, () =>
  withApp({ viewport: STUDIO_VIEWPORT }, async ({ page, base, db }) => {
    const keys = ["?", "n", "i", "f", "p", "d", "t", "[", "[", "Alt+ArrowLeft", "Alt+ArrowRight", "g", "Enter", " ", "Delete", "Backspace", "ArrowDown", "ArrowUp", "u", "r", "h", "Control+z", "Meta+z"];
    for (const path of ["/", "/settings/workspace"]) {
      await page.goto(base + path);
      await page.locator("main").first().waitFor();
      await quiet(page);
      for (const key of keys) {
        // Alt+arrows go back and forward on their own: going back to the page may race the browser getting there first.
        if (new URL(page.url()).pathname !== path) await page.goto(base + path).catch(error => { if (!/interrupted by another navigation/.test(String(error))) throw error; });
        await page.waitForURL(url => new URL(url).pathname === path);
        await page.locator("body").focus().catch(() => {});
        await page.keyboard.press(key);
        await page.keyboard.press("Escape");
      }
      // A block focused in the Studio takes its keyboard keys too: only explicit moves and their Apply change it.
      if (path === "/settings/workspace") {
        await page.goto(base + path);
        await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^More for / }).focus();
        for (const key of ["Delete", "Backspace", "h", "Control+z", "Enter", "Escape", "Escape"]) await page.keyboard.press(key);
      }
      await quiet(page);
    }
    assert.equal(await count(db, "workspace_revisions"), 0, "no revision");
    assert.equal(await count(db, "workspace_drafts"), 0, "no draft");
  }));

const DASHBOARD_CHUNK = /\/assets\/Dashboard-[^/]*\.js(\?.*)?$/;

test("T-03: a layout is not committed while the code that draws its page cannot load; once it can, it is", { timeout: 180_000 }, () =>
  withApp({ viewport: STUDIO_VIEWPORT }, async ({ page, base, db, context }) => {
    // On the context: the app's service worker fetches assets too.
    await context.route(DASHBOARD_CHUNK, route => route.abort());
    await page.goto(`${base}/settings/workspace`);
    await page.evaluate(() => { window.__samePage = true; });
    await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /./ }).first().waitFor();
    await quiet(page);
    assert.equal(await count(db, "workspace_revisions"), 0, "nothing committed without the Dashboard's code");
    assert.equal(await count(db, "workspace_prepared"), 0, "not even prepared");
    assert.equal(await page.evaluate(() => window.__samePage === true), true, "the page was not reloaded under the user");
    await page.getByText(/Preview, not applied yet/).waitFor();
    // A browser keeps a module that failed to load: the code comes back with the next page load.
    await context.unroute(DASHBOARD_CHUNK);
    await page.reload();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal(await count(db, "workspace_revisions", "status = 'committed'"), 1);
  }));

/** In the Studio, on one page's layout: every block that can be hidden is, then applied. */
async function hideEverything(page, scopeName) {
  await page.getByRole("radio", { name: scopeName, exact: true }).click();
  await page.locator("[data-anchor]").first().waitFor();
  await quiet(page);
  for (;;) {
    const shown = page.getByRole("button", { name: /^Show /, pressed: true }).and(page.locator(":not([disabled])"));
    if (await shown.count() === 0) break;
    await shown.first().click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await quiet(page, 300);
  }
  if (await page.getByRole("button", { name: "Apply layout", exact: true }).count() === 0) return;
  await page.getByRole("button", { name: "Apply layout", exact: true }).click();
  await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`S-01: with everything hidden that can be, the editor, its reset and the timer's controls stay reachable (${viewport.width}px)`, { timeout: 240_000 }, () =>
    withApp({ viewport: STUDIO_VIEWPORT }, async ({ page, base, db }) => {
      await page.goto(base + "/issues/DEMO-101");
      await startTimer(page, "DEMO-101");
      await page.goto(`${base}/settings/workspace`);
      for (const scopeName of ["Dashboard · desktop", "Dashboard · phone", "Sidebar", "Mobile tabs"]) await hideEverything(page, scopeName);
      assert.equal(await count(db, "workspace_revisions", "status = 'committed'"), 4, "a layout on each page");
      await page.setViewportSize(viewport);
      await page.goto(base + "/");
      await page.locator("main").first().waitFor();
      await quiet(page);
      // The running timer can still be paused, from where the app shows it.
      await page.getByRole("button", { name: "Pause timer DEMO-101" }).filter({ visible: true }).first().waitFor();
      // The way back: from the page as it is now, by clicks alone, to the editor and its reset.
      if (viewport.width < 768) {
        await page.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).first().click();
        await page.getByRole("dialog").getByRole("link", { name: "Settings" }).click();
      } else {
        // The navigation is hidden too: the account menu, which cannot be, still leads there.
        assert.equal(await page.getByRole("link", { name: "Settings" }).filter({ visible: true }).count(), 0, "the navigation is hidden");
        await page.getByRole("button", { name: "Account menu" }).click();
        await page.getByRole("menuitem", { name: "Settings" }).click();
      }
      await page.waitForURL(url => url.pathname.startsWith("/settings"));
      await page.getByRole("link", { name: "Workspace" }).filter({ visible: true }).first().click();
      await page.waitForURL(url => url.pathname === "/settings/workspace");
      await page.getByRole("button", { name: "Reset to default", exact: true }).waitFor();
    }));
}

/** Every animation or transition running for longer than a frame's rounding, from now on. */
async function watchMotion(page) {
  await page.evaluate(() => {
    window.__motion = [];
    const tick = () => {
      for (const animation of document.getAnimations()) {
        const duration = Number(animation.effect?.getComputedTiming().duration ?? 0);
        if (animation.playState === "running" && duration > 1) window.__motion.push(`${animation.constructor.name} ${animation.animationName ?? animation.transitionProperty ?? ""} ${duration}ms on ${animation.effect?.target?.outerHTML?.slice(0, 80)}`);
      }
      window.__motionFrame = requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Drags a Studio block by its handle with a real pointer into an area. */
async function dragBlock(page, source, target) {
  const handle = source.getByRole("button", { name: /^Move / });
  const from = await handle.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.locator("[data-drop-slot]").waitFor();
  await page.mouse.up();
}

test("X-01: with reduced motion nothing animates: a Studio drag, paging Use over time, an activation", { timeout: 180_000 }, () =>
  withApp({
    viewport: STUDIO_VIEWPORT,
    seed: db => db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now()),
  }, async ({ page, base, db }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(base + "/");
    await waitUntil(async () => await count(db, "workspace_descriptors", "surface_id = 'dashboard' AND device_class = 'desktop'") > 0, "the Dashboard's presented layout");
    const [stored] = await db.q("SELECT descriptor FROM workspace_descriptors WHERE surface_id = 'dashboard' AND device_class = 'desktop' LIMIT 1");
    const descriptor = JSON.parse(stored.descriptor);
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" };
    const day = 86_400_000;
    // Enough periods that Use over time pages.
    for (let index = 0; index < 8; index++) {
      const lastAt = Date.now() - (8 - index) * 7 * day;
      const period = {
        evidenceId: `evidence_${index}`, scope, descriptor, semanticRevision: 1, algorithmVersion: 1, origin: "local",
        coverage: { firstAt: lastAt - 7 * day, lastAt, activeDays: 5, sessions: 5, exposures: 10, droppedEvents: 0, gaps: 0 },
        heat: [{ controlId: "dashboard.customize.open", anchorId: "dashboard.customize", semanticRevision: 1, activations: 3 + index, successes: 0, failures: 0, exposures: 10, activationRate: 0.5, modalities: { pointer: 3 + index, touch: 0, keyboard: 0, unknown: 0 }, cells: Array.from({ length: 8 }, () => Array(8).fill(0)) }],
        flows: [], friction: [], expectations: [],
      };
      await db.q("INSERT INTO workspace_flow_aggregates (user_id, id, surface_id, device_class, effective_revision, origin, payload, created_at) VALUES (1, ?, 'dashboard', 'desktop', ?, 'local', ?, ?)", period.evidenceId, descriptor.effectiveRevision, JSON.stringify(period), lastAt);
    }
    await page.goto(`${base}/settings/workspace`);
    const timeline = page.getByRole("list", { name: "Use over time" });
    await timeline.locator("figure").first().waitFor();
    await quiet(page);
    await watchMotion(page);
    // Paging the periods jumps: the strip is where it goes in the very next frame, and stays.
    const before = await timeline.evaluate(list => list.scrollLeft);
    await page.getByRole("button", { name: "Older periods", exact: true }).click();
    const next = await timeline.evaluate(list => new Promise(resolve => requestAnimationFrame(() => resolve(list.scrollLeft))));
    assert.notEqual(next, before, "the strip moved");
    await page.waitForTimeout(400);
    assert.equal(await timeline.evaluate(list => list.scrollLeft), next, "no smooth scroll after the jump");
    // A drag, its drop, and the activation of what it changed.
    await dragBlock(page, page.locator('[data-anchor="dashboard.activity"]'), page.locator('[data-drop-area="dashboard.secondary"]'));
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    await quiet(page);
    assert.deepEqual(await page.evaluate(() => { cancelAnimationFrame(window.__motionFrame); return [...new Set(window.__motion)]; }), []);
  }));

for (const state of ["pendingActivation", "activationUncertain"]) {
  test(`Integration #10: the server's page during ${state} is the saved layout, painted as it hydrates, and claims nothing for the tab`, { timeout: 180_000 }, () =>
    withApp({ viewport: STUDIO_VIEWPORT }, async ({ page, base, db, context }) => {
      await page.goto(`${base}/settings/workspace`);
      await page.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
      await page.getByText(/Preview, not applied yet/).waitFor();
      // The activation starts and its acknowledgement never arrives: this tab is left pending.
      await page.route(url => callsProcedure("workspace.acknowledge")(url), route => route.abort());
      await page.getByRole("button", { name: "Apply layout", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: /./ }).first().waitFor();
      await waitUntil(async () => await count(db, "workspace_presentations", "surface_id = 'dashboard' AND status = 'pendingActivation'") === 1, "the pending tab");
      if (state === "activationUncertain") {
        // Past the activation's deadline: read as uncertain from now on.
        await db.q("UPDATE workspace_presentations SET pending = jsonb_set(pending::jsonb, '{activationExpiresAt}', to_jsonb(?::bigint))::text WHERE surface_id = 'dashboard' AND status = 'pendingActivation'", Date.now() - 1000);
      }
      const rows = async () => db.q("SELECT client_instance_id, status, presented_descriptor, pending FROM workspace_presentations ORDER BY client_instance_id, surface_id, device_class");
      const tabBefore = await rows();
      const html = await (await context.request.get(base + "/", { headers: { accept: "text/html" } })).text();
      const sections = html => [...html.matchAll(/<section\b[^>]*data-workspace-anchor="([^"]+)"/g)].map(match => match[1]);
      const served = sections(html);
      assert.ok(served.length > 0, "the Dashboard is server-rendered");
      assert.equal(served.includes("dashboard.activity"), false, "the saved layout, not the one the pending tab still shows");
      assert.deepEqual(await rows(), tabBefore, "rendering on the server claims no presentation for any tab");
      // A new load of the page: what first paints is what stays once the app has taken over.
      const fresh = await context.newPage();
      const consoleErrors = [];
      fresh.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) consoleErrors.push(message.text()); });
      await fresh.addInitScript(() => {
        window.__painted = null;
        window.__sawActivity = false;
        const read = () => [...document.querySelectorAll("section[data-workspace-anchor]")].map(section => section.getAttribute("data-workspace-anchor"));
        new MutationObserver(() => {
          if (document.querySelector('[data-workspace-anchor="dashboard.activity"]')) window.__sawActivity = true;
        }).observe(document, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", () => { window.__painted = read(); });
      });
      await fresh.goto(base + "/");
      await fresh.getByRole("button", { name: "Log time", exact: true }).first().waitFor();
      await quiet(fresh);
      const hydrated = await fresh.evaluate(() => [...document.querySelectorAll("section[data-workspace-anchor]")].map(section => section.getAttribute("data-workspace-anchor")));
      assert.deepEqual(await fresh.evaluate(() => window.__painted), served, "first paint is the server's page");
      assert.deepEqual(hydrated, served, "and stays so once hydrated");
      assert.equal(await fresh.evaluate(() => window.__sawActivity), false, "no flash of the other layout");
      assert.deepEqual(consoleErrors, []);
      // The pending tab is left to reconcile on its own: still not presented, never assumed.
      const [pending] = await db.q("SELECT status, presented_descriptor::json->>'sourceActiveRevision' AS source FROM workspace_presentations WHERE client_instance_id = ? AND surface_id = 'dashboard' AND device_class = 'desktop'", tabBefore.find(row => row.status === "pendingActivation")?.client_instance_id ?? "");
      assert.equal(pending.source, "default");
      await fresh.close();
      // And that tab itself still says which state it is in, offering to show the saved layout.
      await page.reload();
      await page.getByText(state === "pendingActivation" ? "Layout saved. It shows as soon as it's safe." : /^Couldn't confirm the new layout is showing/).waitFor();
    }));
}

// A dashboard module signed with a key made here and trusted through MODULES_TRUST_EXTRA_KEY (tests only), as e2e/modules.test.mjs.
const MODULE_KEY = generateKeyPairSync("ed25519");
const MODULE_FIXTURES = new URL("./fixtures/modules/", import.meta.url).pathname;
function installWidget(modulesDir) {
  const code = readFileSync(join(MODULE_FIXTURES, "widget", "index.js"));
  const manifest = { id: "widget", version: "1.0.0", product: "inkledger.widget", entry: "index.js", hostApi: { min: 1, max: 1 }, slots: ["dashboard-widget"], name: { en: "widget", it: "widget" }, files: { "index.js": sha256hex(code) } };
  mkdirSync(join(modulesDir, "widget"), { recursive: true });
  writeFileSync(join(modulesDir, "widget", "index.js"), code);
  writeFileSync(join(modulesDir, "widget", "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, "widget", "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", MODULE_KEY.privateKey));
}
const widgetLicence = signEnvelope(Buffer.from(JSON.stringify({ id: "L-widget", email_hash: "h", product: "inkledger.widget", issued: 1, v: 1 })), "inkledger-license-v1\n", MODULE_KEY.privateKey);

test("A-03 / integration #18: a block whose code is refused or unknown draws only its declared fallback, and the rest of the page", { timeout: 180_000 }, async () => {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-spec-modules-")), "modules");
  installWidget(modulesDir);
  // Changed after signing: the desk's renderer must not run.
  writeFileSync(join(modulesDir, "widget", "index.js"), "document.title = 'pwned'; export default {};");
  const app = await start({
    viewport: STUDIO_VIEWPORT,
    env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: MODULE_KEY.publicKey.export({ type: "spki", format: "pem" }).toString(), MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([widgetLicence]), Date.now());
      // Saved by a version that had a block this one does not know, beside a change it does.
      const operations = [
        { operation: { type: "visibility", operationId: "hide-gone", anchorId: "dashboard.gone", visible: false }, origin: "user", acceptedByUser: true },
        { operation: { type: "move", operationId: "move-gone", anchorId: "dashboard.gone", toAreaId: "dashboard.primary" }, origin: "user", acceptedByUser: true },
        { operation: { type: "visibility", operationId: "hide-activity", anchorId: "dashboard.activity", visible: false }, origin: "user", acceptedByUser: true },
      ];
      await db.q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('from-a-newer-build', 1, 'dashboard', 'desktop', 1, '1.0.0', 'product-1', ?, ?, '[]')", Date.now(), JSON.stringify(operations));
    },
  });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Log time", exact: true }).first().waitFor();
    await quiet(page);
    // The refused renderer: nothing of it runs or shows, its desk stays hidden (the slot's declared fallback).
    assert.notEqual(await page.title(), "pwned");
    assert.equal(await page.getByTestId("module-widget").count(), 0);
    assert.equal(await page.getByRole("heading", { name: "On your desk" }).filter({ visible: true }).count(), 0, "no empty desk");
    // The unknown block: nothing drawn for it; the change the saved layout made that this version knows still applies.
    assert.equal(await page.locator('[data-workspace-anchor="dashboard.gone"]').count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Recent activity" }).count(), 0, "the known change of the saved layout applies");
    for (const anchorId of ["dashboard.timeline", "dashboard.stats", "dashboard.summary", "dashboard.tasks", "dashboard.recap"]) await page.locator(`[data-workspace-anchor="${anchorId}"]`).first().waitFor();
    // Applying on top of what was set aside works.
    await page.goto(`${base}/settings/workspace`);
    await page.locator('[data-anchor="dashboard.recap"]').getByRole("button", { name: /^Show / }).click();
    await page.getByText(/Preview, not applied yet/).waitFor();
    await page.getByRole("button", { name: "Apply layout", exact: true }).click();
    await page.getByText(/Preview, not applied yet/).waitFor({ state: "detached" });
    assert.equal(await count(db, "workspace_revisions", "status = 'committed'"), 1);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
