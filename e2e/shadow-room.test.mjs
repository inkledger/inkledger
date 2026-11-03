// A shadow is paint, never layout (docs/shadow/README.md): with the Shadow mod's --sh-1 on the
// document (here injected: the sun on either side, then the longest the mod can cast), nothing moves
// or resizes, and in every container that clips, a shadow keeps its room up to the reserved
// --surface-room (12 px, the mod's default reach with a margin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const CASTS = ["control", "chip", "picture", "bar", "card", "panel", "nav"];
/** The room reserved in scrollers (src/index.css --surface-room). */
const ROOM = 12;
/** The longest level-1 shadow the mod casts (length and softness at 2, full cloud, low sun): about 31 px. */
const EXTREME = "1px 1.25px 1px 0 hsl(0 0% 0% / 0.2), 7.25px 6px 24.75px -1px hsl(0 0% 0% / 0.2)";

/** How far a box-shadow reaches past its box per side (as src/lib/shadowReach.ts reachOf). */
function reachOf(shadow) {
  const r = { l: 0, r: 0, t: 0, b: 0 };
  for (const layer of shadow.split(/,(?![^(]*\))/)) {
    const nums = layer.trim().replace(/(hsla?|rgba?|var)\(.*$/, "").trim().split(/\s+/).map(parseFloat);
    if (nums.length < 2 || nums.some(Number.isNaN)) continue;
    const [dx, dy, blur = 0, spread = 0] = nums;
    const out = Math.max(0, blur) + spread;
    r.l = Math.max(r.l, out - dx);
    r.r = Math.max(r.r, out + dx);
    r.t = Math.max(r.t, out - dy);
    r.b = Math.max(r.b, out + dy);
  }
  return r;
}
/** What a container must hold: the shadow's reach, up to the reserved room. */
const held = shadow => Object.fromEntries(Object.entries(reachOf(shadow)).map(([k, v]) => [k, Math.min(ROOM, Math.ceil(v))]));
// A long shadow, as at sunset with the mod's length up: the sun on the left, then on the right and low.
const SUNS = [
  "0.9px 1.2px 1px 0 hsl(0 0% 0% / 0.2), 6px 6px 10px -1px hsl(0 0% 0% / 0.2)",
  "-0.9px -1.2px 1px 0 hsl(0 0% 0% / 0.2), -6px -6px 10px -1px hsl(0 0% 0% / 0.2)",
];

/** Casting surfaces whose shadow, as far as it reaches, falls outside their clipping container. */
function cutShadows({ casts, reach, room }) {
  const out = [];
  for (const el of document.querySelectorAll("[data-surface][data-elev='1']")) {
    if (!casts.includes(el.getAttribute("data-surface")) || el.getAttribute("data-surface-role") === "wrap") continue;
    // A navigation item stands out only while it is the current page.
    if (el.hasAttribute("data-surface-current") && !el.hasAttribute("aria-current")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let a = el.parentElement;
    while (a && a !== document.body && getComputedStyle(a).overflowX === "visible" && getComputedStyle(a).overflowY === "visible") a = a.parentElement;
    if (!a || a === document.body) continue;
    const c = a.getBoundingClientRect();
    // Content left out on purpose (scrolled away, a list cut by its height) is not a shadow's cut.
    if (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5 || r.left < c.left - 0.5 || r.right > c.right + 0.5) continue;
    const cs = getComputedStyle(a);
    // Under a fade (mask) its end is meant to vanish; a clip with a margin draws past its edge.
    const masked = cs.maskImage && cs.maskImage !== "none";
    if (cs.overflowX === "clip" && parseFloat(cs.overflowClipMargin || "0") >= room) continue;
    const sides = [];
    if (cs.overflowX !== "visible" && r.left - reach.l < c.left - 0.5) sides.push("left");
    if (cs.overflowX !== "visible" && r.right + reach.r > c.right + 0.5) sides.push("right");
    if (cs.overflowY !== "visible" && r.top - reach.t < c.top - 0.5) sides.push("top");
    if (cs.overflowY !== "visible" && !masked && r.bottom + reach.b > c.bottom + 0.5) sides.push("bottom");
    if (sides.length) out.push(`${el.getAttribute("data-surface")} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${sides.join("+")} by .${String(a.className).slice(0, 60)}`);
  }
  return out;
}

test("shadows keep their room in every clipping container, the sun on either side", () =>
  (async () => {
    const app = await start({
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO pinboard_notes (user_id, board_id, issue_key, note, color, x, y, rotation, z, created_at, updated_at) VALUES (1, 1, NULL, 'r', 'yellow', 60, 60, 1, 1, ?, ?)", now, now);
      },
    });
    try {
      const { page, base } = app;
      await page.addInitScript(() => localStorage.setItem("ikl-pinboard-panel", "open"));
      for (const path of ["/board", "/", "/issues", "/issues#widget", "/pinboard", "/timesheet", "/reports", "/settings"]) {
        await page.goto(base + path.replace("#widget", ""));
        await page.getByRole("main").waitFor();
        await page.waitForTimeout(800);
        if (path.endsWith("#widget")) {
          await page.keyboard.press("p");
          await page.getByRole("region", { name: "Floating pinboard" }).locator("[data-postit]").first().waitFor();
        }
        for (const sun of [...SUNS, EXTREME]) {
          await page.evaluate(s => document.documentElement.style.setProperty("--sh-1", s), sun);
          await page.waitForTimeout(150);
          assert.deepEqual(await page.evaluate(cutShadows, { casts: CASTS, reach: held(sun), room: ROOM }), [], `${path}, sun ${sun}`);
        }
        await page.evaluate(() => document.documentElement.style.removeProperty("--sh-1"));
      }
      assert.deepEqual(app.errors, [], "no page errors");
    } finally {
      await app.stop();
    }
  })());

/** Where the things a shadow could have moved stand: sidebar rows, menus, columns' first cards, a note's foot, tiles. */
function places() {
  const pick = selector => [...document.querySelectorAll(selector)].slice(0, 24).map(el => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2];
  });
  return {
    sidebar: pick("aside nav a, aside [data-workspace-area='shell.actions'] button"),
    settings: pick("main nav[data-scroll-key='settings-menu'] a"),
    columns: pick("main section[aria-label] [draggable=true]:first-child"),
    notes: pick("[data-postit] button"),
    tiles: pick("main .collection-items > li"),
  };
}

test("a shadow moves nothing: the same places with no shadow, a long one and the longest", () =>
  (async () => {
    const app = await start({
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO pinboard_notes (user_id, board_id, issue_key, note, color, x, y, rotation, z, created_at, updated_at) VALUES (1, 1, NULL, 'r', 'yellow', 60, 60, 1, 1, ?, ?)", now, now);
      },
    });
    try {
      const { page, base } = app;
      await page.addInitScript(() => localStorage.setItem("ikl-pinboard-panel", "open"));
      for (const path of ["/", "/board", "/settings"]) {
        await page.goto(base + path);
        await page.getByRole("main").waitFor();
        // Settled: lanes, counts and fonts in place.
        let before = await page.evaluate(places);
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(200);
          const now = await page.evaluate(places);
          if (JSON.stringify(now) === JSON.stringify(before)) break;
          before = now;
        }
        for (const sun of [SUNS[0], "-10px 6px 14px -1px hsl(0 0% 0% / 0.2)", EXTREME]) {
          await page.evaluate(s => document.documentElement.style.setProperty("--sh-1", s), sun);
          await page.waitForTimeout(250);
          assert.deepEqual(await page.evaluate(places), before, `${path}: nothing moves with ${sun}`);
        }
        await page.evaluate(() => document.documentElement.style.removeProperty("--sh-1"));
      }
      // A long shadow to the left: a column's cards still answer at their right edge (the rooms never overlap).
      await page.goto(base + "/board");
      await page.locator("[draggable=true]").first().waitFor();
      await page.evaluate(s => document.documentElement.style.setProperty("--sh-1", s), EXTREME);
      await page.waitForTimeout(200);
      const hits = await page.evaluate(() =>
        [...document.querySelectorAll("[draggable=true]")].slice(0, 12).map(c => {
          const r = c.getBoundingClientRect();
          const at = document.elementFromPoint(r.right - 2, r.top + r.height / 2);
          return !r.width || r.right > window.innerWidth - 4 || at === null || c.contains(at);
        })
      );
      assert.ok(hits.every(Boolean), JSON.stringify(hits));
      assert.deepEqual(app.errors, [], "no page errors");
    } finally {
      await app.stop();
    }
  })());
