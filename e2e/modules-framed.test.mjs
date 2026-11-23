// Framed modules (host API v2) end to end: a module signed with a key made
// here (MODULES_TRUST_EXTRA_KEY, tests only) runs in a sandboxed frame on the
// Dashboard, with a runtime frame beside it, and reaches nothing of the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineNoise, start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const fixture = id => readFileSync(new URL(`./fixtures/modules/${id}/index.js`, import.meta.url));
const CODE = fixture("framed");

// The framed module, and the in-page demo module beside it (host API v1, publisher lane).
const MANIFESTS = {
  framed: { version: "2.0.0", hostApi: { min: 1, max: 2 }, runtime: "frame", capabilities: ["runtime"], slots: ["dashboard-widget", "dashboard-overlay"] },
  hello: { version: "1.0.0", hostApi: { min: 1, max: 1 }, slots: ["sidebar-footer"] },
  // Installed only by the test that asks for it.
  film: { version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities: ["download.large"], slots: ["dashboard-widget"] },
};
const DEFAULT_IDS = ["framed", "hello"];

// A file of the framed module's own that, loaded in a frame it nests, says whether that frame has peer connections.
const EXTRA = { framed: { "probe.js": 'parent.postMessage({ probe: typeof RTCPeerConnection }, "*");\n' } };

function install(modulesDir, id) {
  const code = fixture(id);
  const extra = EXTRA[id] ?? {};
  const files = { "index.js": sha256hex(code), ...Object.fromEntries(Object.entries(extra).map(([f, text]) => [f, sha256hex(Buffer.from(text))])) };
  const manifest = { id, product: `inkledger.${id}`, entry: "index.js", name: { en: id, it: id }, files, ...MANIFESTS[id] };
  mkdirSync(join(modulesDir, id), { recursive: true });
  writeFileSync(join(modulesDir, id, "index.js"), code);
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(modulesDir, id, f), text);
  writeFileSync(join(modulesDir, id, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, id, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = id =>
  signEnvelope(
    Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })),
    "inkledger-license-v1\n",
    KEY.privateKey,
  );
const seed = db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(Object.keys(MANIFESTS).map(license)), Date.now());

// The page's own long tasks and frame gaps, and when the first module frame appeared (the app page only).
const watch = () => {
  if (window.top !== window) return;
  const w = window;
  w.__longTasks = [];
  w.__gaps = [];
  w.__frameAt = null;
  w.__clicks = [];
  document.addEventListener("click", e => w.__clicks.push(e.target.tagName), true);
  new PerformanceObserver(l => w.__longTasks.push(...l.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true });
  new MutationObserver(() => {
    if (w.__frameAt === null && document.querySelector("iframe[data-module-frame]")) w.__frameAt = performance.now();
  }).observe(document, { childList: true, subtree: true });
  let last = 0;
  const tick = t => {
    if (last) w.__gaps.push([t, t - last]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function withFramed(body, { before, ids = DEFAULT_IDS } = {}) {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-framed-")), "modules");
  for (const id of ids) install(modulesDir, id);
  const app = await start({ seed, env: { MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" } });
  const consoleErrors = [];
  app.page.on("console", m => m.type() === "error" && !engineNoise(m.text()) && consoleErrors.push(m.text()));
  const responses = [];
  app.context.on("response", r => /\/modules\/(run|frame)\//.test(r.url()) && responses.push(r));
  try {
    await app.context.addInitScript(watch);
    await before?.(app);
    await app.page.goto(app.base + "/");
    // On screen: a framed card off screen is paused (hidden) until it's back.
    await app.page.locator(`[data-module-slot="dashboard-widget"] [data-module="${ids[0]}"]`).scrollIntoViewIfNeeded();
    await body({ ...app, consoleErrors, responses });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
}

const WIDGET = '[data-module-slot="dashboard-widget"] iframe[data-module-frame="view"]';
const OVERLAY = '[data-module-slot="dashboard-overlay"] iframe[data-module-frame="view"]';
const viewFrame = async (page, sel = WIDGET) => (await page.locator(sel).elementHandle()).contentFrame();

test("a framed module draws in its card, talks to the host and its runtime, and reaches nothing of the app", () =>
  withFramed(async ({ page, base, consoleErrors, responses }) => {
    const inside = page.frameLocator(WIDGET);
    await inside.getByTestId("framed-hello").filter({ hasText: "framed hello" }).waitFor();
    await inside.getByTestId("framed-worker").filter({ hasText: "worker 42" }).waitFor();
    await inside.getByTestId("framed-runtime").filter({ hasText: "runtime hears dashboard-widget" }).waitFor();
    await inside.getByTestId("framed-totals").filter({ hasText: /^totals \d+$/ }).waitFor();
    await inside.getByTestId("framed-timer").filter({ hasText: "timer idle" }).waitFor();
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    assert.equal(await page.locator('[data-module-runtimes] iframe[data-module-frame="runtime"][data-state="live"]').count(), 1);
    // The frame fills its card, inside its border.
    const card = await page.locator('[data-module-slot="dashboard-widget"] [data-module="framed"]').evaluate(el => [el.clientWidth, el.clientHeight]);
    const frameBox = await page.locator(WIDGET).boundingBox();
    assert.deepEqual([frameBox.width, frameBox.height], card);
    assert.deepEqual(consoleErrors, [], "no console errors while mounting");

    // Over the page: the frame takes no pointer events; a click on its square is the module's, beside it the page's.
    const overlay = page.locator(OVERLAY);
    await page.locator(`${OVERLAY}[data-state="live"]`).waitFor();
    assert.equal(await overlay.evaluate(el => getComputedStyle(el).pointerEvents), "none");
    const o = await overlay.boundingBox();
    await page.evaluate(() => (window.__clicks.length = 0));
    await page.mouse.click(o.x + 50, o.y + 50);
    await page.frameLocator(OVERLAY).getByTestId("framed-dot").filter({ hasText: "activated 1" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__clicks), [], "the page never saw the module's click");
    await page.mouse.click(o.x + 10, o.y + 10);
    const beside = await page.evaluate(() => window.__clicks);
    assert.equal(beside.length, 1);
    assert.notEqual(beside[0], "IFRAME");
    assert.equal(await page.frameLocator(OVERLAY).getByTestId("framed-dot").textContent(), "activated 1");

    // Smooth while it mounted: no long task of the page, no frame gap worth a dropped beat.
    await page.waitForTimeout(500);
    const perf = await page.evaluate(() => {
      const from = window.__frameAt;
      return {
        from,
        longTasks: window.__longTasks.filter(t => t.start + t.duration >= from),
        worstGap: Math.max(0, ...window.__gaps.filter(([t]) => t >= from).map(([, g]) => g)),
      };
    });
    console.info(`[framed] frame at ${Math.round(perf.from)} ms, worst frame gap after it ${perf.worstGap.toFixed(1)} ms`);
    assert.notEqual(perf.from, null);
    assert.deepEqual(perf.longTasks.filter(t => t.duration > 50), [], "no long task while the frame mounts");

    // Headers as served: code readable by an opaque origin, a policy of its own for the frame document.
    const code = responses.find(r => r.url().includes("/modules/run/") && r.url().endsWith("/index.js"));
    const doc = responses.find(r => r.url().includes("/modules/frame/"));
    assert.ok(code && doc, "both the frame document and the code were fetched");
    const codeHeaders = await code.allHeaders();
    const docHeaders = await doc.allHeaders();
    console.info(`[framed] code: corp=${codeHeaders["cross-origin-resource-policy"]} acao=${codeHeaders["access-control-allow-origin"]}; document: xfo=${docHeaders["x-frame-options"]}`);
    assert.equal(codeHeaders["access-control-allow-origin"], "*");
    assert.match(docHeaders["content-security-policy"], new RegExp(`script-src 'sha256-[^']+' 'sha256-[^']+' ${base.replace(/[.]/g, "[.]")}/modules/run/;`));
    assert.match(new URL(code.url()).pathname, /^\/modules\/run\/[^/]+\/framed\/[0-9a-f]{32}\/index[.]js$/);

    // Inside the frame: no app, no cookie, no network, no shell.
    const frame = await viewFrame(page);
    const probes = await frame.evaluate(async () => {
      const blocked = f => {
        try {
          f();
          return false;
        } catch {
          return true;
        }
      };
      let api;
      try {
        const r = await fetch("/api/trpc/auth.me", { credentials: "include" });
        api = `answered ${r.status}`;
      } catch {
        api = "failed";
      }
      return {
        origin: self.origin,
        api,
        parentDocument: blocked(() => parent.document.title),
        cookie: blocked(() => document.cookie),
        tauri: typeof window.__TAURI__ === "undefined" && typeof window.__TAURI_INTERNALS__ === "undefined",
        popup: window.open("/") === null,
        peer: typeof RTCPeerConnection === "undefined",
      };
    });
    assert.deepEqual(probes, { origin: "null", api: "failed", parentDocument: true, cookie: true, tauri: true, popup: true, peer: true });

    // Navigating away stops the module: its frames go, and stay gone.
    await frame.evaluate(() => (location.href = "/modules/frame/elsewhere")).catch(() => {});
    await page.locator("iframe[data-module-frame]").first().waitFor({ state: "detached" });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("iframe[data-module-frame]").count(), 0);
  }));

test("a frame the module nests runs nothing with a peer connection, and its code loads from nowhere else", () =>
  withFramed(async ({ page, base, context }) => {
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    const leaks = [];
    context.on("request", r => r.url().includes("ikl-leak") && leaks.push(r.url()));
    const frame = await viewFrame(page);
    const got = await frame.evaluate(async other => {
      const entry = Object.keys(JSON.parse(document.querySelector('script[type="importmap"]').textContent).integrity)[0];
      // What the frame's own script elements give away (a nonce's IDL value is readable by the page).
      const nonce = [...document.scripts].map(s => s.nonce).find(Boolean) ?? "";
      const nested = html =>
        new Promise(resolve => {
          const f = document.createElement("iframe");
          const heard = e => {
            if (e.source !== f.contentWindow) return;
            removeEventListener("message", heard);
            resolve(e.data.probe);
          };
          addEventListener("message", heard);
          setTimeout(() => resolve("did not run"), 3000);
          f.srcdoc = html;
          document.body.append(f);
        });
      const end = "</" + "script>";
      return {
        inline: await nested(`<script nonce="${nonce}">parent.postMessage({ probe: typeof RTCPeerConnection }, "*")${end}`),
        byPath: await nested(`<script type="module" src="${new URL(entry.replace(/index[.]js$/, "probe.js"), location.href).href}">${end}`),
        // A nonce'd script (the module's own imports carry the bootstrap's nonce) loads from any address.
        imported: await new Promise(resolve => {
          const heard = e => {
            if (e.source !== window || !e.data?.imported) return;
            removeEventListener("message", heard);
            resolve(e.data.imported);
          };
          addEventListener("message", heard);
          setTimeout(() => resolve("did not run"), 3000);
          const s = document.createElement("script");
          s.type = "module";
          s.nonce = nonce;
          s.textContent = `import(${JSON.stringify(other + "/ikl-leak.js")}).then(() => "loaded", () => "refused").then(imported => postMessage({ imported }, "*"));`;
          document.head.append(s);
        }),
      };
    }, base.replace("127.0.0.1", "localhost"));
    assert.deepEqual(got, { inline: "did not run", byPath: "undefined", imported: "did not run" });
    assert.deepEqual(leaks, [], "no request elsewhere");
  }));

test("a frame that takes the focus by itself gives it straight back: the keys stay the app's, no badge shows", () =>
  withFramed(async ({ page }) => {
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    // A field of the page's, where the person is typing.
    await page.evaluate(() => {
      const field = Object.assign(document.createElement("input"), { id: "typing-here" });
      Object.assign(field.style, { position: "fixed", top: "8px", left: "8px", zIndex: "9999" });
      document.body.append(field);
    });
    const input = page.locator("#typing-here");
    await input.click();
    await page.evaluate(() => {
      window.__badges = 0;
      new MutationObserver(() => {
        if (document.querySelector("[data-module-focus-badge]")) window.__badges++;
      }).observe(document.body, { childList: true, subtree: true });
    });
    // No gesture of the person's: the module's script reaches for the keyboard.
    await (await viewFrame(page)).evaluate(() => {
      const b = document.createElement("button");
      b.textContent = "grab";
      document.body.append(b);
      b.focus();
    });
    await page.waitForTimeout(500);
    assert.equal(await input.evaluate(el => document.hasFocus() && el === document.activeElement), true, "the app's input keeps the focus");
    await page.keyboard.type("abc");
    assert.equal(await input.inputValue(), "abc");
    assert.equal(await page.evaluate(() => window.__badges), 0, "no badge, not even for a moment");
  }));

test("a frame grabbing the focus from another frame, or again and again, never keeps the keys", () =>
  withFramed(async ({ page }) => {
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    await page.locator(`${OVERLAY}[data-state="live"]`).waitFor();
    // The person types in the card's own field (a click there puts the focus in that frame).
    const card = await viewFrame(page);
    await card.evaluate(() => {
      const field = Object.assign(document.createElement("input"), { id: "card-field" });
      Object.assign(field.style, { position: "absolute", top: "0", left: "0" });
      document.body.append(field);
    });
    await page.frameLocator(WIDGET).locator("#card-field").click();
    // The overlay's frame reaches for the focus from it, by itself.
    const overlay = await viewFrame(page, OVERLAY);
    await overlay.evaluate(() => {
      window.__keys = 0;
      addEventListener("keydown", () => window.__keys++, true);
      const b = document.createElement("button");
      document.body.append(b);
      b.focus();
    });
    await page.waitForTimeout(500);
    // Away from the grabbing frame (back to the card's where the browser lets the host, else the page).
    assert.equal(await page.evaluate(sel => document.activeElement === document.querySelector(sel), OVERLAY), false, "not in the overlay's frame");
    await page.keyboard.type("abc");
    assert.equal(await overlay.evaluate(() => window.__keys), 0, "no key reached the overlay");
    // Again and again, while the person types in the app.
    await page.evaluate(() => {
      const field = Object.assign(document.createElement("input"), { id: "typing-here" });
      Object.assign(field.style, { position: "fixed", top: "8px", left: "8px", zIndex: "9999" });
      document.body.append(field);
    });
    await page.locator("#typing-here").click();
    await overlay.evaluate(() => {
      const b = document.body.querySelector("button");
      setInterval(() => b.focus(), 20);
    });
    await page.keyboard.type("twenty characters ok", { delay: 30 });
    // Each grab given back (WebKit), or the module stopped on the second (Chrome would keep sending the keys to its frame): the rest lands in the app.
    await page.waitForTimeout(300);
    assert.match(await page.locator("#typing-here").inputValue(), /ok$/);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "typing-here");
  }));

test("the focus in a module's frame shows the host's badge with its name, outside its box", () =>
  withFramed(async ({ page }) => {
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    const badge = page.locator('[data-module-focus-badge="framed"]');
    assert.equal(await badge.count(), 0);
    await page.frameLocator(WIDGET).getByTestId("framed-hello").click();
    await badge.waitFor();
    assert.equal((await badge.textContent()).trim(), "framed — module");
    assert.equal(await badge.evaluate(el => getComputedStyle(el).pointerEvents), "none");
    await page.getByRole("status").filter({ hasText: "framed — module" }).waitFor({ state: "attached" });
    // Drawn by the host outside the frame's box, where the module can't paint.
    const b = await badge.boundingBox();
    const f = await page.locator(WIDGET).boundingBox();
    const overlaps = b.x < f.x + f.width && b.x + b.width > f.x && b.y < f.y + f.height && b.y + b.height > f.y;
    assert.equal(overlaps, false, `badge ${JSON.stringify(b)} outside frame ${JSON.stringify(f)}`);
    // Back on the app: gone, and the announcement with it.
    await page.getByRole("heading").first().click();
    await badge.waitFor({ state: "detached" });
    assert.equal(await page.getByRole("status").filter({ hasText: "framed — module" }).count(), 0);
  }));

test("other bytes at the code URL never run: the import map pins the entry to its hash", () =>
  withFramed(
    async ({ page, consoleErrors }) => {
      await page.locator(`${WIDGET}[data-state="failed"]`).waitFor();
      const frame = await viewFrame(page);
      assert.equal(await frame.evaluate(() => document.querySelector("#ikl-box")), null);
      assert.ok(!(await frame.evaluate(() => document.body.textContent)).includes("tampered"));
      assert.ok(consoleErrors.some(e => e.startsWith("[module framed] load:")), consoleErrors.join("\n"));
    },
    {
      before: ({ context }) =>
        context.route("**/modules/run/**", route =>
          route.fulfill({
            status: 200,
            headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" },
            body: "export default { id: 'framed', hostApi: 2, mount: { 'dashboard-widget'(el) { el.textContent = 'tampered'; return () => {}; } } };",
          }),
        ),
    },
  ));

test("a page module beside a framed one keeps its mount across a route change", () =>
  withFramed(async ({ page }) => {
    const hello = page.getByTestId("module-hello");
    await hello.waitFor();
    await page.locator(`${WIDGET}[data-state="live"]`).waitFor();
    await hello.evaluate(el => (el.__kept = true));
    // A route change inside the app (no reload).
    await page.evaluate(() => {
      history.pushState(null, "", "/issues");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("heading", { name: "Issues" }).first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByTestId("module-hello").evaluate(el => el.__kept === true), true, "the same mount, not a new one");
  }));

test("a film past the picture cap is saved whole through the host, on the person's click in its view", () =>
  withFramed(
    async ({ page }) => {
      const save = page.frameLocator('[data-module-slot="dashboard-widget"] [data-module="film"] iframe[data-module-frame="view"]').locator("button[data-ready]");
      await save.waitFor({ timeout: 30_000 });
      const type = await save.getAttribute("data-ready");
      await page.waitForTimeout(500);
      const [download] = await Promise.all([page.waitForEvent("download"), save.click()]);
      // Named by the type its bytes prove (MediaRecorder's own: WebM in Chromium, MP4 in WebKit).
      assert.equal(download.suggestedFilename(), `film.${type.includes("mp4") ? "mp4" : "webm"}`);
      const size = statSync(await download.path()).size;
      assert.ok(size > 5 * 1024 * 1024, `the whole film came down (${size} bytes)`);
    },
    { ids: ["film"] },
  ));
