// Settings → Store for someone who may use modules but not get them: only the modules
// granted to them, each to turn on or off and set up; nothing of the catalogue, licences
// or installs (and no Store call the server would refuse), clean for axe in every look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AXE, start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const FIXTURES = new URL("./fixtures/modules/", import.meta.url).pathname;
const SLOTS = { tune: ["settings"], hello: ["sidebar-footer"] };

const license = id =>
  signEnvelope(Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

function install(modulesDir, id) {
  const code = readFileSync(join(FIXTURES, id, "index.js"));
  const manifest = { id, version: "1.0.0", product: `inkledger.${id}`, entry: "index.js", hostApi: { min: 1, max: 1 }, slots: SLOTS[id], name: { en: id === "tune" ? "Tune" : "Hello", it: id === "tune" ? "Tune" : "Hello" }, files: { "index.js": sha256hex(code) } };
  mkdirSync(join(modulesDir, id), { recursive: true });
  writeFileSync(join(modulesDir, id, "index.js"), code);
  writeFileSync(join(modulesDir, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, id, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function axeSerious(page) {
  await page.evaluate(AXE);
  return page.evaluate(
    async tags =>
      (await axe.run(document, { runOnly: { type: "tag", values: tags } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
    TAGS,
  );
}

test("a member with a module granted sees only it in the Store, switches it and sets it up", async () => {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-granted-")), "modules");
  for (const id of ["tune", "hello"]) install(modulesDir, id);
  const app = await start({
    viewport: { width: 1280, height: 900 },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license("tune"), license("hello")]), Date.now());
      // Mario is a member here: modules to use, Tune granted, nothing of the Store.
      await db.q("UPDATE users SET role = 'member', role_id = NULL, permissions = '[\"useModules\"]', module_grants = '[\"tune\"]' WHERE id = 1");
    },
    // A store that would answer: whatever the page shows, it is not because the store is off.
    env: { STORE_URL: "http://127.0.0.1:9", MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  try {
    const { page, base, db } = app;
    const storeCalls = [];
    const refused = [];
    page.on("request", r => {
      if (/\/trpc\/[^?]*store\./.test(r.url())) storeCalls.push(r.url());
    });
    page.on("response", r => {
      if (r.status() === 403) refused.push(r.url());
    });
    await page.goto(base + "/settings/store");
    const card = page.locator('[data-store-item="tune"]');
    await card.waitFor();
    // Only the granted module; no catalogue, licence import, layout switch or device-wide off switch.
    assert.equal(await page.locator('[data-store-item="hello"]').count(), 0, "a module not granted isn't shown");
    assert.equal(await page.getByRole("button", { name: "Restore licence…" }).count(), 0);
    assert.equal(await page.getByRole("radiogroup").count(), 0, "no layout switch");
    assert.equal(await page.locator("#store-off").count(), 0, "no device-wide off switch");

    // Off and on again, for this account.
    const toggle = card.getByRole("switch", { name: /Tune/ });
    await toggle.click();
    await page.getByText("Tune is off").first().waitFor();
    await toggle.click();
    await page.getByText("Tune is on").first().waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM module_storage WHERE user_id = 1 AND module_id = 'tune' AND key = '__off'"))[0].n, 0);

    // Its menu: settings and its own progress, nothing of licences or removal.
    await card.getByRole("button", { name: /manage Tune/ }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.getByRole("menuitem").allTextContents();
    assert.ok(items.some(i => /Settings/.test(i)), items.join(", "));
    assert.ok(!items.some(i => /Uninstall|Remove licence|Servers|Download licence|Copy licence/.test(i)), items.join(", "));
    await menu.getByRole("menuitem", { name: /Settings/ }).click();
    await page.getByTestId("tune-save").click();
    await page.getByTestId("tune-said").filter({ hasText: "Saved" }).waitFor();
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM audit_events WHERE action = 'modules.configure' AND actor_user_id = 1"))[0].n === 0; i++) await page.waitForTimeout(100);
    assert.equal((await db.q("SELECT count(*)::int AS n FROM audit_events WHERE action = 'modules.configure' AND actor_user_id = 1"))[0].n, 1, "the setting is audited");
    await page.keyboard.press("Escape");

    // Clean for axe in light, dark and high contrast (the look as it is: only checked here).
    for (const [scheme, contrast] of [["light", "no-preference"], ["dark", "no-preference"], ["light", "more"], ["dark", "more"]]) {
      await page.emulateMedia({ colorScheme: scheme, contrast });
      await page.goto(base + "/settings/store");
      await card.waitFor();
      await page.waitForTimeout(800);
      assert.deepEqual(await axeSerious(page), [], `${scheme} ${contrast}`);
    }
    assert.deepEqual(storeCalls, [], "no Store call the server would refuse");
    assert.deepEqual(refused, [], "nothing refused");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});

test("a member who may acquire modules browses the catalogue and requests one, but manages nothing", async () => {
  const catalog = { v: 1, items: ["hello", "tune"].map(id => ({ id, product: `inkledger.${id}`, version: "1.0.0", hostApi: { min: 1, max: 1 }, name: { en: id === "tune" ? "Tune" : "Hello", it: id }, tagline: { en: "A module.", it: "Un modulo." }, mode: "request", price: { amount: 0, currency: "EUR" }, methods: { card: true, bitcoin: "soon" } })) };
  const store = createServer((req, res) => {
    res.writeHead(req.url === "/catalog" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/catalog" ? catalog : { error: "nope" }));
  });
  await new Promise(r => store.listen(0, "127.0.0.1", r));
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-acquire-")), "modules");
  install(modulesDir, "tune");
  const app = await start({
    viewport: { width: 1280, height: 900 },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license("tune")]), Date.now());
      // Mario gets modules but holds none: Tune is on the server, not granted to him.
      await db.q("UPDATE users SET role = 'member', role_id = NULL, permissions = '[\"acquireModules\",\"useModules\"]', module_grants = '[]' WHERE id = 1");
    },
    env: { STORE_URL: `http://127.0.0.1:${store.address().port}`, MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  try {
    const { page, base } = app;
    const refused = [];
    page.on("response", r => {
      if (r.status() === 403) refused.push(r.url());
    });
    await page.goto(base + "/settings/store");
    const hello = page.locator('[data-store-item="hello"]');
    await hello.waitFor();
    await hello.getByRole("button", { name: "Request" }).waitFor();
    // Tune is on the server but not his: no switch, no management; he may get a licence of his own (one per person).
    const tune = page.locator('[data-store-item="tune"]');
    await tune.waitFor();
    assert.equal(await tune.getByRole("switch").count(), 0);
    assert.equal(await tune.getByRole("button", { name: /manage Tune/ }).count(), 0);
    await tune.getByRole("button", { name: "Request" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Restore licence…" }).count(), 0);
    // The request form opens for a module not on the server.
    await hello.getByRole("button", { name: "Request" }).click();
    await page.getByRole("dialog").getByLabel(/email/i).first().waitFor();
    await page.keyboard.press("Escape");
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(base + "/settings/store");
      await hello.waitFor();
      await page.waitForTimeout(800);
      assert.deepEqual(await axeSerious(page), [], scheme);
    }
    assert.deepEqual(refused, [], "nothing refused");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    store.close();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});

test("Ugo, a member, sees only the module assigned to him and the one offered to his team", async () => {
  const catalog = { v: 1, items: ["hello", "tune", "svg"].map(id => ({ id, product: `inkledger.${id}`, version: "1.0.0", hostApi: { min: 1, max: 1 }, name: { en: id === "tune" ? "Tune" : id === "hello" ? "Hello" : "Svg", it: id }, tagline: { en: "A module.", it: "Un modulo." }, mode: "request", price: { amount: 0, currency: "EUR" }, methods: { card: true, bitcoin: "soon" } })) };
  const store = createServer((req, res) => {
    res.writeHead(req.url === "/catalog" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/catalog" ? catalog : { error: "nope" }));
  });
  await new Promise(r => store.listen(0, "127.0.0.1", r));
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-ugo-")), "modules");
  install(modulesDir, "tune");
  const app = await start({
    viewport: { width: 1280, height: 900 },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license("tune")]), Date.now());
      // Ugo (the signed-in account, a member): Tune assigned to him (a licence his team paid), Hello offered to his team.
      await db.q("UPDATE users SET username = 'ugo', display_name = 'Ugo', role = 'member', role_id = NULL, permissions = '[\"useModules\"]', module_grants = '[\"tune\"]' WHERE id = 1");
      const [{ id: team }] = await db.q("INSERT INTO teams (name, created_at) VALUES ('Design', 1) RETURNING id");
      await db.q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, 1, 'member')", team);
      await db.q("INSERT INTO module_licences (licence_id, product, holder_user_id, payer_kind, payer_id, created_at) VALUES ('L-tune', 'inkledger.tune', 1, 'team', ?, 1)", team);
      await db.q("INSERT INTO module_offers (product, team_id, created_at) VALUES ('inkledger.hello', ?, 1)", team);
    },
    env: { STORE_URL: `http://127.0.0.1:${store.address().port}`, MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  try {
    const { page, base } = app;
    const refused = [];
    page.on("response", r => {
      if (r.status() === 403) refused.push(r.url());
    });
    await page.goto(base + "/settings/store");
    const tune = page.locator('[data-store-item="tune"]');
    const hello = page.locator('[data-store-item="hello"]');
    await tune.waitFor();
    await hello.waitFor();
    assert.equal(await page.locator('[data-store-item="svg"]').count(), 0, "not offered, not held: not shown");
    assert.deepEqual((await page.locator("[data-store-item]").evaluateAll(els => els.map(e => e.getAttribute("data-store-item")))).sort(), ["hello", "tune"]);
    // Assigned: he switches it and sets it up; the licence is his team's (nothing to download, nothing to buy).
    await tune.getByRole("switch", { name: /Tune/ }).waitFor();
    assert.equal(await tune.getByRole("button", { name: "Request" }).count(), 0);
    await tune.getByRole("button", { name: /manage Tune/ }).click();
    const items = await page.getByRole("menu").getByRole("menuitem").allTextContents();
    assert.ok(!items.some(i => /licence|Uninstall/i.test(i)), items.join(", "));
    await page.keyboard.press("Escape");
    // Offered to his team: he may request it for himself.
    await hello.getByRole("button", { name: "Request" }).waitFor();
    assert.equal(await hello.getByRole("switch").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Restore licence…" }).count(), 0);
    // The pointer off the badge (its hover dims it).
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    assert.deepEqual(await axeSerious(page), []);
    assert.deepEqual(refused, [], "nothing refused");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    store.close();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
