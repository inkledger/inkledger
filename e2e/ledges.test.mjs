// "page.info" and "page.ledges" on the real pages: a rect sits on its element
// within 1 px (DPR 1 and 2), every surface in sight is a ledge (Dashboard
// >= 15, Board >= its cards in sight), and a dense Board (120 issues) is read
// with no long task. Logs counts, scan times and the longest frame gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE, start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const ID = "ledge";

function install(modulesDir) {
  const code = readFileSync(new URL(`./fixtures/modules/${ID}/index.js`, import.meta.url));
  const manifest = { id: ID, product: `inkledger.${ID}`, entry: "index.js", name: { en: "Ledge", it: "Ledge" }, files: { "index.js": sha256hex(code) }, version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities: ["page.overlay", "page.ledges", "page.info"], slots: ["dashboard-overlay"] };
  mkdirSync(join(modulesDir, ID), { recursive: true });
  writeFileSync(join(modulesDir, ID, "index.js"), code);
  writeFileSync(join(modulesDir, ID, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, ID, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = signEnvelope(Buffer.from(JSON.stringify({ id: "L-ledge", email_hash: "h", product: `inkledger.${ID}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

/** An answer asked after the page settled (two rounds past the one shown now). */
async function fresh(page) {
  const map = page.frameLocator("[data-page-overlay] iframe[data-module-frame=view]").getByTestId("ledge-map");
  await map.waitFor({ state: "attached", timeout: 20_000 });
  const read = async () => {
    const t = await map.textContent({ timeout: 2_000 }).catch(() => "");
    return t ? JSON.parse(t) : { round: 0 };
  };
  const from = (await read()).round;
  for (let i = 0; i < 80; i++) {
    const m = await read();
    if (m.round >= from + 2) return m;
    await page.waitForTimeout(250);
  }
  throw new Error("no fresh answer");
}

/** Frame gaps and long tasks on the page's thread from now on. */
const watchThread = page =>
  page.evaluate(() => {
    window.__gaps = [];
    window.__long = [];
    let last = performance.now();
    const tick = t => {
      window.__gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) new PerformanceObserver(l => window.__long.push(...l.getEntries().map(e => Math.round(e.duration)))).observe({ type: "longtask" });
  });
const thread = page =>
  page.evaluate(() => {
    const g = [...window.__gaps].sort((a, b) => a - b);
    return { frames: g.length, p95: Math.round(g[Math.floor(g.length * 0.95)] ?? 0), max: Math.round(g[g.length - 1] ?? 0), long: window.__long };
  });

/** The info rect of `kind` nearest the element's box, and how far off it is (px, the worst side). */
async function offBy(page, snap, locator, kind) {
  const b = await locator.evaluate((e, k) => {
    if (k !== "text") return e.getBoundingClientRect().toJSON();
    const r = document.createRange();
    r.selectNodeContents(e);
    const t = r.getBoundingClientRect();
    if (getComputedStyle(e).overflowY === "visible") return t.toJSON();
    // A box that cuts its text (truncate, tight leading): what shows.
    const c = e.getBoundingClientRect();
    const x = Math.max(t.left, c.left);
    const y = Math.max(t.top, c.top);
    return { x, y, width: Math.min(t.right, c.right) - x, height: Math.min(t.bottom, c.bottom) - y };
  }, kind);
  const d = r => Math.max(Math.abs(r.x - b.x), Math.abs(r.y - b.y), Math.abs(r.x + r.w - (b.x + b.width)), Math.abs(r.y + r.h - (b.y + b.height)));
  const best = snap.rects.filter(r => r.kind === kind).sort((p, q) => d(p) - d(q))[0];
  return best ? d(best) : Infinity;
}

test("page.info and page.ledges on the real pages, a dense Board included", { timeout: 280_000 }, async () => {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-ledge-")), "modules");
  install(modulesDir);
  const app = await start({
    viewport: { width: 1280, height: 800 },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now());
      const now = Date.now();
      for (let i = 300; i < 420; i++)
        await db.q("INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite) VALUES (1, ?, ?, ?, ?, 'To Do', ?, 'DEMO', 'Project', 'Task', 'Medium', '[]', 'mrossi', ?, ?, 0)", `DEMO-${i}`, `DEMO-${i}`, `Work item ${i}`, i % 3 ? "To Do" : "In corso", i % 3 ? "todo" : "doing", `https://jira.example.it/browse/DEMO-${i}`, now);
    },
    env: { STORE_URL: "off", MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  const log = {};
  try {
    const { page } = app;
    log.engine = ENGINE;
    await page.goto(app.base + "/");
    await page.locator("main h1").first().waitFor();
    await page.waitForTimeout(800);
    await watchThread(page);
    const dash = await fresh(page);
    const logTime = page.getByRole("button", { name: "Log time" }).first();
    log.dashboard = { ledges: dash.ledges.length, rects: dash.info.rects.length, surfaces: dash.info.surfaces.length, scanMs: Math.round(dash.ms), logTimeOff: await offBy(page, dash.info, logTime, "control"), h1Off: await offBy(page, dash.info, page.locator("main h1").first(), "text") };
    log.dashboard.thread = await thread(page);
    assert.ok(log.dashboard.logTimeOff <= 1, `Log time rect off by ${log.dashboard.logTimeOff}`);
    assert.ok(log.dashboard.h1Off <= 1, `title rect off by ${log.dashboard.h1Off}`);
    assert.ok(dash.ledges.length >= 15, `dashboard ledges ${dash.ledges.length}`);

    await page.goto(app.base + "/board");
    const cards = page.locator("[draggable=true]");
    await cards.first().waitFor();
    await page.waitForTimeout(800);
    await watchThread(page);
    const board = await fresh(page);
    // A change: read again, timed.
    await page.evaluate(() => document.querySelector("main")?.setAttribute("data-e2e-poke", "1"));
    const again = await fresh(page);
    const inSight = await cards.evaluateAll(els => els.filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.top < innerHeight - 8;
    }).length);
    const titleOff = await offBy(page, again.info, cards.first().locator("p").first(), "text");
    log.board = { cards: await cards.count(), inSight, ledges: board.ledges.length, rects: board.info.rects.length, surfaces: board.info.surfaces.length, scanMs: Math.round(again.ms), titleOff, thread: await thread(page) };
    assert.ok(board.ledges.length >= inSight, `board ledges ${board.ledges.length} < cards ${inSight}`);
    assert.ok(titleOff <= 1, `card title rect off by ${titleOff}`);
    assert.deepEqual(log.board.thread.long, [], "no long tasks");

    // DPR 2, same account: the same rect within 1 px.
    const ctx2 = await page.context().browser().newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, storageState: await page.context().storageState() });
    const page2 = await ctx2.newPage();
    await page2.goto(app.base + "/");
    await page2.locator("main h1").first().waitFor();
    await page2.waitForTimeout(800);
    const dash2 = await fresh(page2);
    log.dpr2 = { logTimeOff: await offBy(page2, dash2.info, page2.getByRole("button", { name: "Log time" }).first(), "control") };
    await ctx2.close();
    assert.ok(log.dpr2.logTimeOff <= 1, `DPR 2: Log time rect off by ${log.dpr2.logTimeOff}`);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    console.log("page.info", JSON.stringify(log));
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
