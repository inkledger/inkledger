// Add-on modules end to end: signed with a key made here and trusted through
// MODULES_TRUST_EXTRA_KEY (tests only), loaded into the sidebar slot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const FIXTURES = new URL("./fixtures/modules/", import.meta.url).pathname;

const license = id =>
  signEnvelope(
    Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })),
    "inkledger-license-v1\n",
    KEY.privateKey,
  );

function bundle(id) {
  const code = readFileSync(join(FIXTURES, id, "index.js"));
  const manifest = {
    id,
    version: "1.0.0",
    product: `inkledger.${id}`,
    entry: "index.js",
    hostApi: { min: 1, max: 1 },
    slots: { edge: ["panel-edge"], widget: ["dashboard-widget"], perch: ["dashboard-perch", "dashboard-widget", "settings"], stage: ["app-stage"], scene: ["dashboard-backdrop", "dashboard-action"], kit: ["settings", "sidebar-footer", "sidebar-rail", "mobile-more", "mobile-dock"] }[id] ?? ["sidebar-footer"],
    name: { en: id, it: id },
    files: { "index.js": sha256hex(code) },
  };
  return { manifest, signature: signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey), code };
}

/** A signed module installed in the server's folder before it starts. */
function install(modulesDir, id) {
  const { manifest, signature, code } = bundle(id);
  mkdirSync(join(modulesDir, id), { recursive: true });
  writeFileSync(join(modulesDir, id, "index.js"), code);
  writeFileSync(join(modulesDir, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, id, "manifest.sig"), signature);
}

const licensed = (...ids) => db =>
  db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(ids.map(license)), Date.now());

async function withModules({ modules = [], seed, path = "/issues", viewport, userAgent }, body) {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-modules-")), "modules");
  for (const id of modules) install(modulesDir, id);
  const app = await start({ seed, viewport, userAgent, env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" } });
  try {
    await app.page.goto(app.base + path);
    await app.page.getByRole("link", { name: "Board" }).first().waitFor();
    await body({ ...app, modulesDir });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
}

test("a licensed module draws in the sidebar and keeps its data", () =>
  withModules({ modules: ["hello"], seed: licensed("hello") }, async ({ page }) => {
    const hello = page.getByTestId("module-hello");
    await hello.waitFor();
    assert.equal(await hello.textContent(), "hello idle 0");
    await hello.click();
    await page.waitForTimeout(500);
    await page.reload();
    await page.getByTestId("module-hello").filter({ hasText: "hello idle 1" }).waitFor();
  }));

test("a module hears time logged, as the server confirmed it, with the issue it was on (WP-17)", () =>
  withModules(
    {
      modules: ["hello"],
      seed: async db => {
        await licensed("hello")(db);
        const now = Date.now();
        const [{ id }] = await db.q(
          "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
          now,
        );
        await db.q(
          `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
           VALUES (1, ?, 'I_1', 'acme/web#1', 'Login fails on Safari', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
          id, now,
        );
      },
    },
    async ({ page, base, db }) => {
      const [{ id: gh }] = await db.q("SELECT id FROM connections WHERE type = 'github'");
      await page.goto(`${base}/issues/${gh}/I_1`);
      await page.getByTestId("module-hello").waitFor();
      await page.getByRole("button", { name: "Log time" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Time spent").fill("30m");
      const y = new Date(Date.now() - 86_400_000);
      await dialog.getByLabel("Start", { exact: true }).fill(`${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}T10:00`);
      await dialog.getByRole("button", { name: "Log", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      const hello = page.getByTestId("module-hello");
      await page.waitForFunction(() => document.querySelector('[data-testid="module-hello"]')?.dataset.heard);
      assert.deepEqual(JSON.parse(await hello.getAttribute("data-heard")), [{ e: "worklog-logged", seconds: 1800, ref: { connectionId: gh, key: "acme/web#1" } }]);
      // Deleted: the time moved back.
      await page.getByRole("button", { name: "Delete worklog" }).first().click();
      await page.getByRole("alertdialog").getByRole("button", { name: /Delete/ }).click();
      await page.waitForFunction(() => (JSON.parse(document.querySelector('[data-testid="module-hello"]')?.dataset.heard ?? "[]")).length === 2);
      assert.deepEqual(JSON.parse(await hello.getAttribute("data-heard"))[1], { e: "worklog-changed", seconds: -1800, ref: { connectionId: gh, key: "acme/web#1" } });
    },
  ));

test("without a licence a module stays off; the Store badge says so and can uninstall it", () =>
  withModules({ modules: ["hello"], path: "/settings/store" }, async ({ page }) => {
    const card = page.locator('[data-store-item="hello"]');
    await card.getByRole("button", { name: "Manage hello (Needs a licence)" }).click();
    assert.equal(await page.getByTestId("module-hello").count(), 0);
    await page.getByText("No licence on this server.").waitFor();
    await page.getByRole("menuitem", { name: "Uninstall" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Uninstall" }).click();
    await card.waitFor({ state: "detached" });
  }));

test("the Store badge removes a licence after confirming, and the module stops", () =>
  withModules({ modules: ["hello"], seed: licensed("hello"), path: "/settings/store" }, async ({ page }) => {
    await page.getByTestId("module-hello").waitFor();
    const card = page.locator('[data-store-item="hello"]');
    await card.getByRole("button", { name: "Manage hello (Active)" }).click();
    await page.getByText(/^Licence L-hell/).waitFor();
    await page.getByRole("menuitem", { name: "Remove licence" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove licence" }).click();
    await card.getByRole("button", { name: "Manage hello (Needs a licence)" }).waitFor();
    await page.reload();
    await card.waitFor();
    assert.equal(await page.getByTestId("module-hello").count(), 0);
  }));

test("a module changed after signing is refused, and the app runs on", () =>
  withModules({ modules: ["hello"], seed: licensed("hello"), path: "/settings/store" }, async ({ page, modulesDir }) => {
    writeFileSync(join(modulesDir, "hello", "index.js"), "document.title = 'pwned';");
    await page.reload();
    await page.locator('[data-store-item="hello"]').filter({ hasText: "Refused" }).waitFor();
    assert.equal(await page.getByTestId("module-hello").count(), 0);
    assert.notEqual(await page.title(), "pwned");
  }));

test("a module that throws on mount does not break the app", () =>
  withModules({ modules: ["boom", "hello"], seed: licensed("boom", "hello") }, async ({ page }) => {
    await page.getByTestId("module-hello").waitFor();
    await page.getByRole("link", { name: "Board", exact: true }).click();
    await page.waitForURL(u => u.pathname === "/board");
  }));

test("with all modules off, opening the Store loads none (its data must not wake them)", () =>
  withModules({ modules: ["hello"], seed: licensed("hello"), path: "/settings/store?modules=off" }, async ({ page }) => {
    await page.locator('[data-store-item="hello"]').waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.getByTestId("module-hello").count(), 0);
  }));

test("removing the licence of a running module leaves no page error", () =>
  withModules({ modules: ["kit"], seed: licensed("kit"), path: "/settings/store" }, async ({ page }) => {
    await page.getByTestId("kit-sidebar-footer").waitFor();
    // The module keeps writing right up to the moment it stops.
    await page.evaluate(() => {
      window.__kitWrite = setInterval(() => void 0, 50);
    });
    const card = page.locator('[data-store-item="kit"]');
    await card.getByRole("button", { name: "Manage kit (Active)" }).click();
    await page.getByRole("menuitem", { name: "Remove licence" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove licence" }).click();
    await card.getByRole("button", { name: "Manage kit (Needs a licence)" }).waitFor();
    await page.waitForTimeout(500);
  }));

test("?modules=off loads no module", () =>
  withModules({ modules: ["hello"], seed: licensed("hello"), path: "/issues?modules=off" }, async ({ page }) => {
    await page.waitForTimeout(800);
    assert.equal(await page.getByTestId("module-hello").count(), 0);
  }));

test("a module on the panel edge takes no room and lets clicks through", async () => {
  const measure = async page => {
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    return {
      collapse: (await page.getByRole("button", { name: /^Collapse/ }).first().boundingBox())?.y,
      scrolls: await nav.evaluate(n => n.scrollHeight > n.clientHeight),
      main: (await page.locator("main").boundingBox())?.height,
    };
  };
  let before;
  await withModules({}, async ({ page }) => {
    before = await measure(page);
  });
  await withModules({ modules: ["edge"], seed: licensed("edge") }, async ({ page }) => {
    const edge = page.getByTestId("module-edge");
    await edge.waitFor();
    assert.deepEqual(await measure(page), before);
    // The panel's bottom-left corner holds it.
    const box = await edge.boundingBox();
    const main = await page.locator("main").boundingBox();
    assert.ok(Math.abs(box.x - main.x) < 2 && Math.abs(box.y + box.height - (main.y + main.height)) < 20, JSON.stringify({ box, main }));
    // A click on it reaches what is below.
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-module]") === null, { x: box.x + 20, y: box.y + 20 });
    assert.ok(hit, "clicks pass through");
  });
});

test("on a phone the panel edge stands on the tab bar's top edge", () =>
  withModules({ modules: ["edge"], seed: licensed("edge"), viewport: { width: 390, height: 844 } }, async ({ page }) => {
    const edge = page.getByTestId("module-edge");
    await edge.waitFor();
    const box = await edge.boundingBox();
    const bar = await page.getByRole("navigation", { name: "Quick sections" }).boundingBox();
    assert.ok(Math.abs(box.y + box.height - bar.y) <= 1, JSON.stringify({ box, bar }));
  }));

test("module settings open from the Store badge; uninstalling asks first", () =>
  withModules({ modules: ["kit"], seed: licensed("kit"), path: "/settings/store" }, async ({ page }) => {
    const card = page.locator('[data-store-item="kit"]');
    await card.getByRole("button", { name: "Manage kit (Active)" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("dialog").getByText("kit settings", { exact: true }).waitFor();
    await page.getByTestId("kit-settings").waitFor();
    // Real weather is off in tests: the host answers null, no error.
    await page.locator('[data-module="kit"][data-weather="null"]').waitFor({ state: "attached" });
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Manage kit (Active)" }).click();
    await page.getByRole("menuitem", { name: "Uninstall" }).click();
    await page.getByRole("alertdialog").getByText(/starts from zero/).waitFor();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    assert.equal(await card.count(), 1);
  }));

test("the Store switch turns one module off and back on, and it stays off after a reload", () =>
  withModules({ modules: ["kit", "hello"], seed: licensed("kit", "hello"), path: "/settings/store" }, async ({ page }) => {
    await page.getByTestId("module-hello").waitFor();
    await page.getByTestId("kit-sidebar-footer").waitFor();
    await page.getByRole("switch", { name: "kit on" }).click();
    await page.getByTestId("kit-sidebar-footer").waitFor({ state: "detached" });
    await page.locator('[data-store-item="kit"]').getByRole("button", { name: "Manage kit (Off)" }).waitFor();
    assert.equal(await page.getByTestId("module-hello").count(), 1, "the other module keeps running");
    await page.reload();
    await page.getByTestId("module-hello").waitFor();
    assert.equal(await page.getByTestId("kit-sidebar-footer").count(), 0);
    await page.getByRole("switch", { name: "kit on" }).click();
    await page.getByTestId("kit-sidebar-footer").waitFor();
  }));

test("progress exports to a file and comes back from it", () =>
  withModules({ modules: ["kit"], seed: licensed("kit"), path: "/settings/store" }, async ({ page }) => {
    const set = value =>
      page.evaluate(v => fetch("/api/trpc/modules.storageSet?batch=1", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ 0: { json: { moduleId: "kit", key: "state", value: v } } }),
      }).then(r => r.status), value);
    assert.equal(await set({ level: 7 }), 200);
    const card = page.locator('[data-store-item="kit"]');
    await card.getByRole("button", { name: "Manage kit (Active)" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Export progress" }).click()]);
    assert.equal(download.suggestedFilename(), "kit.iklprogress");
    const file = await download.path();
    assert.equal(await set({ level: 1 }), 200);
    await page.locator('input[type="file"][accept^=".iklprogress"]').setInputFiles(file);
    await page.getByText("Progress of kit restored").waitFor();
    await page.waitForEvent("load");
    const level = await page.evaluate(() => fetch(`/api/trpc/modules.storageGet?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { moduleId: "kit", key: "state" } } }))}`).then(r => r.json()));
    assert.equal(level[0].result.data.json.value.level, 7);
  }));

test("the folded sidebar shows the rail slot instead of the footer, mounted once", () =>
  withModules({ modules: ["kit"], seed: licensed("kit"), path: "/" }, async ({ page }) => {
    await page.getByTestId("kit-sidebar-footer").waitFor();
    await page.getByRole("button", { name: /^Collapse/ }).first().click();
    await page.getByTestId("kit-sidebar-rail").waitFor();
    assert.equal(await page.getByTestId("kit-sidebar-footer").count(), 0);
    const mounts = await page.evaluate(() => window.__kitMounts);
    assert.equal(mounts["sidebar-rail"], 1);
    assert.equal(mounts["sidebar-footer"], 0);
  }));

test("on a phone a module gets a row in More and a dock on the tab bar that covers no tab", () =>
  withModules({ modules: ["kit"], seed: licensed("kit"), path: "/", viewport: { width: 390, height: 844 } }, async ({ page }) => {
    const dock = page.getByTestId("kit-mobile-dock");
    await dock.waitFor();
    const bar = await page.getByRole("navigation", { name: "Quick sections" }).boundingBox();
    const d = await dock.boundingBox();
    assert.ok(d.y + d.height <= bar.y + 1, JSON.stringify({ d, bar }));
    // The page's last row scrolls clear of the docked control. The shell (and the dock) is up
    // before the page has drawn all it reads: scroll to the end once the page stops growing.
    await page.locator("main h1").first().waitFor();
    let height = -1;
    for (let i = 0; i < 20; i++) {
      const now = await page.evaluate(() => document.body.scrollHeight);
      if (now === height) break;
      height = now;
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const main = await page.locator("main").boundingBox();
    const docked = await dock.boundingBox();
    assert.ok(main.y + main.height <= docked.y + 1, JSON.stringify({ main, docked }));
    await dock.click();
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog").getByTestId("kit-mobile-more").waitFor();
  }));

test("a dashboard backdrop sits behind the page, lets clicks through and stays on the Dashboard", async () => {
  for (const viewport of [undefined, { width: 390, height: 844 }]) {
    await withModules({ modules: ["scene"], seed: licensed("scene"), path: "/", viewport }, async ({ page }) => {
      const scene = page.getByTestId("module-scene");
      await scene.waitFor({ state: "attached" });
      const main = page.locator("main");
      assert.equal(await main.evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "panel turns see-through");
      // The page, not the scene, takes the pointer.
      const box = await main.boundingBox();
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-module]") === null, { x: box.x + box.width / 2, y: box.y + 200 });
      assert.ok(hit, "the scene steals no clicks");
      const action = page.getByRole("button", { name: "Look out" });
      await action.click();
      assert.equal(await action.getAttribute("data-clicked"), "yes");
      // Elsewhere: no scene, opaque panel.
      await page.goto(page.url().replace(/\/$/, "") + "/issues");
      await page.getByRole("link", { name: "Board" }).first().waitFor();
      assert.equal(await scene.count(), 0);
      assert.notEqual(await main.evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
    });
  }
});

test("backdrop visibility (Settings → Appearance) changes how much of the scene shows", () =>
  withModules({ modules: ["scene"], seed: licensed("scene"), path: "/settings/appearance" }, async ({ page }) => {
    const level = () => page.locator("[data-backdrop-visibility]").getAttribute("data-backdrop-visibility");
    await page.getByRole("radio", { name: "Scenic" }).click();
    await page.waitForTimeout(300);
    await page.getByRole("link", { name: "Dashboard" }).first().click();
    await page.getByTestId("module-scene").waitFor({ state: "attached" });
    assert.equal(await level(), "scenic");
    await page.reload();
    await page.getByTestId("module-scene").waitFor({ state: "attached" });
    assert.equal(await level(), "scenic", "saved for the user");
  }));

test("a module on the day timeline scrolls under the page header, never over it", () =>
  withModules({ modules: ["perch"], seed: licensed("perch"), path: "/" }, async ({ page }) => {
    const perch = page.getByTestId("module-perch");
    await perch.waitFor();
    // A colour nothing else on the page has, drawn over the whole perch.
    await perch.evaluate(el => (el.style.background = "rgb(255 0 255)"));
    // Scroll the panel until the timeline's top is well under the sticky header, once the page
    // has stopped moving (data landing late changes the header's height and what is above).
    // Found the same way in each step: the sticky header, the timeline's bar, the scrolling panel.
    const SEL = { header: "main h1", sticky: "div.lg\\:sticky", bar: '[data-module="perch"]', box: ".h-56" };
    const settled = () =>
      page.waitForFunction(
        sel => {
          const h = document.querySelector(sel.header)?.closest(sel.sticky);
          const bar = document.querySelector(sel.bar)?.closest(sel.box);
          if (!h || !bar) return false;
          const now = JSON.stringify([h.getBoundingClientRect(), bar.getBoundingClientRect()]);
          const same = window.__still === now;
          window.__still = now;
          return same;
        },
        SEL,
        { polling: 150, timeout: 10_000 },
      );
    await settled();
    await page.evaluate(sel => {
      const h = document.querySelector(sel.header).closest(sel.sticky);
      const bar = document.querySelector(sel.bar).closest(sel.box);
      const main = document.getElementById("main");
      main.scrollTop += bar.getBoundingClientRect().top - h.getBoundingClientRect().top - 20;
    }, SEL);
    await settled();
    // The header as it is now, right before the picture.
    const header = await page.evaluate(sel => {
      const h = document.querySelector(sel.header)?.closest(sel.sticky);
      if (!h) return null;
      const r = h.getBoundingClientRect();
      // Whole pixel rows inside the header only: at a fractional scroll the row its bottom
      // edge falls in is shared with what scrolls under it, and that is not "over" it.
      const top = Math.ceil(r.top) + 1;
      return { x: Math.ceil(r.left), y: top, width: Math.floor(r.width) - 1, height: Math.floor(r.bottom) - 1 - top };
    }, SEL);
    assert.ok(header, "the sticky header and the timeline are on the page");
    const shot = (await page.screenshot({ clip: header })).toString("base64");
    // The browser decodes the picture: how many magenta pixels show in the header.
    const magenta = await page.evaluate(async b64 => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200) n++;
      return n;
    }, shot);
    assert.equal(magenta, 0, "nothing of the perch paints over the header");
  }));

test("a module stands on the day timeline's entries, never in the way of a click; a hidden card leaves no desk", () =>
  withModules({ modules: ["perch"], seed: licensed("perch"), path: "/" }, async ({ page }) => {
    const perch = page.getByTestId("module-perch");
    await perch.waitFor();
    const fit = await page.locator('[data-module="perch"]').first().evaluate(el => {
      const bar = el.closest(".h-56").getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return {
        // The entries' baseline (bottom-6) at the bar's left end, reaching to its top.
        onBaseline: Math.abs(bar.bottom - r.bottom - 1.5 * rem) < 1 && Math.abs(r.left - bar.left) < 1 && Math.abs(r.top - bar.top) < 1,
        clickable: getComputedStyle(el).pointerEvents !== "none",
      };
    });
    assert.deepEqual(fit, { onBaseline: true, clickable: false });
    const r = await perch.boundingBox();
    const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-module]"), { x: r.x + r.width / 2, y: r.y + r.height / 2 });
    assert.equal(under, null, "clicks go through");
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("heading", { name: "On your desk" }).isVisible(), false);
    // Its server cache: what one device put, the page reads back.
    assert.deepEqual(await page.evaluate(() => window.__perchFile()), [3000, "image/webp", true]);
    // The module opens its own settings over the page (a click on the Bonsai does).
    await page.evaluate(() => window.__perchSettings());
    await page.getByRole("dialog").getByText("Perch options here").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }));

test("an app-wide module mounts once for every page, and reads the surface catalog and the stage; the host draws no light of its own", () =>
  withModules({ modules: ["stage"], seed: licensed("stage"), path: "/" }, async ({ page, base }) => {
    await page.waitForFunction(() => window.__stageMounts === 1);
    const seen = await page.evaluate(() => {
      const { catalog, root, panel } = window.__stage();
      const kinds = Object.keys(catalog ?? {});
      // Every surface on the screen is a kind the catalog knows, at an elevation it allows.
      const bad = [...document.querySelectorAll("[data-surface]")].filter(el => {
        const p = catalog[el.getAttribute("data-surface")];
        const e = Number(el.getAttribute("data-elev") ?? 0);
        return !p || e > p.maxElevation || (e > 0 && !p.cast);
      });
      return {
        kinds: ["control", "card", "panel", "menu", "dialog", "ground", "glass"].every(k => kinds.includes(k)),
        panelCasts: catalog.panel.cast,
        root,
        panel,
        bad: bad.length,
        marked: document.querySelectorAll("[data-surface]").length > 10,
        // The old light (host.ambient) draws nothing any more.
        leftovers: document.querySelectorAll("[data-lit], [data-lit-on], [data-dashboard-light], [data-dashboard-night]").length,
      };
    });
    assert.deepEqual(seen, { kinds: true, panelCasts: true, root: true, panel: true, bad: 0, marked: true, leftovers: 0 });
    // Pages come and go; the module stays mounted (no restart of what it draws).
    for (const name of ["Issues", "Board", "Dashboard"]) {
      await page.getByRole("link", { name }).first().click();
      await page.waitForTimeout(200);
    }
    assert.equal(await page.evaluate(() => window.__stageMounts), 1);
    // Night as the person set it reaches the module.
    assert.equal(await page.evaluate(() => window.__stageNight), true);
    await page.goto(base + "/settings/appearance");
    const toggle = page.getByRole("switch", { name: "Night on the Dashboard" });
    await Promise.all([page.waitForResponse(r => r.url().includes("settings.update")), toggle.click()]);
    await page.waitForFunction(() => window.__stageNight === false);
  }));

test("a dashboard widget gets its own card below the dashboard, inside the panel", async () => {
  for (const viewport of [undefined, { width: 390, height: 844 }]) {
    await withModules({ modules: ["widget"], seed: licensed("widget"), path: "/", viewport }, async ({ page }) => {
      const widget = page.getByTestId("module-widget");
      await widget.waitFor();
      await page.getByRole("heading", { name: "On your desk" }).waitFor();
      await widget.scrollIntoViewIfNeeded();
      const box = await widget.boundingBox();
      const main = await page.locator("main").boundingBox();
      assert.ok(box.height >= 200 && box.x >= main.x && box.x + box.width <= main.x + main.width + 1, JSON.stringify({ box, main }));
      // Nothing of the dashboard sits under it.
      const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-module]")?.getAttribute("data-module"), { x: box.x + 10, y: box.y + 10 });
      assert.equal(under, "widget");
    });
  }
});

/** A past working day (Monday to Friday): its holes are all there, in an open week. */
function pastWorkday() {
  const d = new Date();
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("a module over the day timeline takes clicks on its shape only: the hole under the rest opens the cutter", async () => {
  const phone = { viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };
  for (const device of [{}, phone]) {
    await withModules({ modules: ["perch"], seed: licensed("perch"), path: `/?period=day&from=${pastWorkday()}`, ...device }, async ({ page }) => {
      const perch = page.getByTestId("module-perch");
      await perch.waitFor();
      await perch.scrollIntoViewIfNeeded();
      const r = await perch.boundingBox();
      const tap = async (x, y) => (device.userAgent ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
      // Off the shape, over a hole of the working day: the hole gets it, even
      // through a child of the module that asked for clicks.
      const off = { x: r.x + Math.min(120, r.width - 10), y: r.y + r.height / 2 };
      const hole = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label") ?? null, off);
      assert.match(hole ?? "", /^Log missing time from/, "a hole lies under the module");
      await tap(off.x, off.y);
      await page.getByRole("group", { name: "Strip of time to log: click to cut" }).waitFor();
      assert.equal(await page.evaluate(() => window.__perchHits), 0);
      await page.keyboard.press("Escape");
      // Gone for good, closing animation included: until then the point is the dialog's.
      await page.getByRole("dialog").waitFor({ state: "detached" });
      // On the shape: the module's own, and nothing under it reacts.
      await tap(r.x + 15, r.y + r.height - 15);
      await page.getByRole("dialog").getByText("Perch options here").waitFor();
      assert.equal(await page.evaluate(() => window.__perchHits), 1);
      assert.equal(await page.getByRole("group", { name: "Strip of time to log: click to cut" }).count(), 0);
      // Escape reaches the sheet once it has slid in.
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAnimations().every(a => a.playState === "finished"));
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      // With a dialog open over it, the shape is the dialog's (no settings behind it).
      await tap(off.x, off.y);
      await page.getByRole("group", { name: "Strip of time to log: click to cut" }).waitFor();
      const shape = { x: r.x + 15, y: r.y + r.height - 15 };
      const covered = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="dialog"]'), shape);
      if (covered) {
        await tap(shape.x, shape.y);
        assert.equal(await page.evaluate(() => window.__perchHits), 1);
      }
    });
  }
});

test("a module over the day timeline lets a logged slice under it open its issue, off its shape", async () => {
  const day = pastWorkday();
  const [y, m, d] = day.split("-").map(Number);
  const nine = new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
  const seed = async db => {
    await licensed("perch")(db);
    await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-under', ?, 10800, '', 1)", nine);
  };
  await withModules({ modules: ["perch"], seed, path: `/?period=day&from=${day}` }, async ({ page }) => {
    const perch = page.getByTestId("module-perch");
    await perch.waitFor();
    await perch.scrollIntoViewIfNeeded();
    const r = await perch.boundingBox();
    const off = { x: r.x + Math.min(120, r.width - 10), y: r.y + r.height / 2 };
    const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("aria-label") ?? null, off);
    assert.match(under ?? "", /^DEMO-101 from 09:00/, "a logged slice lies under the module");
    await page.mouse.click(off.x, off.y);
    await page.waitForURL(url => new URL(url).pathname.startsWith("/issues/"));
    assert.equal(await page.evaluate(() => window.__perchHits), 0);
  });
});

test("modules no longer allowed (permission taken away) stop at once, every one of them", () =>
  withModules({ modules: ["kit", "hello"], seed: licensed("kit", "hello"), path: "/settings/store" }, async ({ page }) => {
    await page.getByTestId("module-hello").waitFor();
    await page.getByTestId("kit-sidebar-footer").waitFor();
    // From now on the server says this user may not use modules.
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("modules.list"), async route => {
      const procs = decodeURIComponent(new URL(route.request().url()).pathname.split("/api/trpc/")[1]).split(",");
      const json = await (await route.fetch()).json();
      const out = procs.map((p, i) => (p === "modules.list" ? { result: { data: { json: { ...json[i].result.data.json, canUse: false } } } } : json[i]));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
    });
    // Something that reads the list again (a Store switch).
    await page.getByRole("switch", { name: "kit on" }).click();
    await page.getByTestId("module-hello").waitFor({ state: "detached" });
    await page.getByTestId("kit-sidebar-footer").waitFor({ state: "detached" });
  }));
