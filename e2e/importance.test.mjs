// "page.importance" reports the page's ink, not its boxes: on the Board the
// room inside a card between its title and its bottom row is free, though a
// link stretches over the whole card. Logs the free share per page.
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
const ID = "ink";

function install(modulesDir) {
  const code = readFileSync(new URL(`./fixtures/modules/${ID}/index.js`, import.meta.url));
  const manifest = { id: ID, product: `inkledger.${ID}`, entry: "index.js", name: { en: "Ink", it: "Ink" }, files: { "index.js": sha256hex(code) }, version: "2.0.0", hostApi: { min: 2, max: 2 }, runtime: "frame", capabilities: ["page.overlay", "page.importance"], slots: ["dashboard-overlay"] };
  mkdirSync(join(modulesDir, ID), { recursive: true });
  writeFileSync(join(modulesDir, ID, "index.js"), code);
  writeFileSync(join(modulesDir, ID, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(modulesDir, ID, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
}

const license = signEnvelope(Buffer.from(JSON.stringify({ id: "L-ink", email_hash: "h", product: `inkledger.${ID}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

/** A map started after the page settled (two rounds past the one shown now). */
async function freshMap(page) {
  const map = page.frameLocator("[data-page-overlay] iframe[data-module-frame=view]").getByTestId("ink-map");
  const read = async () => {
    const t = await map.textContent({ timeout: 2_000 }).catch(() => "");
    return t ? JSON.parse(t) : { round: 0 };
  };
  await map.waitFor({ state: "attached", timeout: 20_000 });
  const from = (await read()).round;
  for (let i = 0; i < 120; i++) {
    const m = await read();
    if (m.round >= from + 2) return { ...m, at: (x, y) => Number(m.v[Math.floor(y / m.step) * m.cols + Math.floor(x / m.step)]) };
    await page.waitForTimeout(250);
  }
  throw new Error("no fresh importance map");
}

const freeShare = m => Math.round((1000 * [...m.v].filter(d => d === "0").length) / m.v.length) / 10;

test("the Board's cards: the room between a card's title and its bottom row is free; free share per page logged", async () => {
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-ink-")), "modules");
  install(modulesDir);
  const app = await start({
    viewport: { width: 1280, height: 800 },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license]), Date.now());
    },
    env: { STORE_URL: "off", MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: PEM, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
  });
  try {
    const { page } = app;
    await page.goto(app.base + "/board");
    const card = page.locator("[draggable=true]").filter({ has: page.getByText("Test task number 2", { exact: true }) });
    await card.waitFor();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__inkLong = [];
      new PerformanceObserver(l => window.__inkLong.push(...l.getEntries().map(e => e.duration))).observe({ type: "longtask" });
    });
    const board = await freshMap(page);
    const c = await card.boundingBox();
    const title = await card.locator("p").first().boundingBox();
    const bottom = await card.locator(":scope > div").last().boundingBox();
    assert.ok(c && title && bottom && bottom.y - (title.y + title.height) > 12, JSON.stringify({ c, title, bottom }));
    // The right half of the card, from below the title down to its bottom row: no ink there.
    const inside = [];
    // Cell centres a whole cell inside the room, so no cell reaches the title, the bottom row or the buttons.
    const s = board.step;
    const centre = v => Math.floor(v / s) * s + s / 2;
    for (let y = centre(title.y + title.height + s); y < bottom.y - s; y += s) for (let x = centre(c.x + c.width * 0.6); x < c.x + c.width - 40 - s; x += s) inside.push([x, y, board.at(x, y)]);
    assert.ok(inside.length > 0);
    assert.deepEqual(inside.filter(([, , v]) => v !== 0), [], "free inside the card");
    // Its title's glyphs stay important.
    assert.equal(board.at(title.x + 8, title.y + title.height / 2), 1, "the title is ink");
    const shares = { board: freeShare(board) };
    for (const [name, path, ready] of [["dashboard", "/", "main h1"], ["issues", "/issues", "main h1"]]) {
      await page.goto(app.base + path);
      await page.locator(ready).first().waitFor();
      await page.waitForTimeout(500);
      shares[name] = freeShare(await freshMap(page));
    }
    const long = await page.evaluate(() => window.__inkLong ?? []);
    console.log("free share %", JSON.stringify(shares), "long tasks ms", JSON.stringify(long));
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    rmSync(join(modulesDir, ".."), { recursive: true, force: true });
  }
});
