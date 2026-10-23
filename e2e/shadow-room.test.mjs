// Room for cast shadows: with the Shadow mod's --sh-1 on the document (here
// injected, the sun on either side), no casting surface has its shadow cut
// by a clipping container, page by page; without it, nothing is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const CASTS = ["control", "chip", "picture", "bar", "card", "panel", "nav"];
// A long shadow, as at sunset with the mod's length up: the sun on the left, then on the right and low.
const SUNS = [
  "0.9px 1.2px 1px 0 hsl(0 0% 0% / 0.2), 6px 6px 10px -1px hsl(0 0% 0% / 0.2)",
  "-0.9px -1.2px 1px 0 hsl(0 0% 0% / 0.2), -6px -6px 10px -1px hsl(0 0% 0% / 0.2)",
];

/** Casting surfaces whose shadow, as far as it reaches, falls outside their clipping container. */
function cutShadows(casts) {
  const st = document.documentElement.style;
  const reach = Object.fromEntries(["l", "r", "t", "b"].map(k => [k, parseFloat(st.getPropertyValue(`--surface-reach-${k}`)) || 0]));
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
    // Under a fade (mask) its end is meant to vanish.
    const masked = cs.maskImage && cs.maskImage !== "none";
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
        // Without the mod: no reach written, nothing moves.
        assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--surface-reach-b")), "", path);
        for (const sun of SUNS) {
          await page.evaluate(s => document.documentElement.style.setProperty("--sh-1", s), sun);
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--surface-reach-b") !== "");
          await page.waitForTimeout(150);
          assert.deepEqual(await page.evaluate(cutShadows, CASTS), [], `${path}, sun ${sun}`);
        }
        // The mod gone: its room goes too.
        await page.evaluate(() => document.documentElement.style.removeProperty("--sh-1"));
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--surface-reach-b") === "");
      }
      assert.deepEqual(app.errors, [], "no page errors");
    } finally {
      await app.stop();
    }
  })());

test("the room takes nothing from the layout: the board's columns and cards stay where they were", () =>
  (async () => {
    const app = await start({});
    try {
      const { page, base } = app;
      await page.goto(base + "/board");
      const card = page.locator("[draggable=true]").first();
      await card.waitFor();
      // Measured once the board has settled (its lanes, counts and fonts in place).
      let before = await card.boundingBox();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(150);
        const now = await card.boundingBox();
        if (Math.abs(now.y - before.y) < 0.01 && Math.abs(now.x - before.x) < 0.01) break;
        before = now;
      }
      await page.evaluate(() => document.documentElement.style.setProperty("--sh-1", "-6px 6px 12px -1px hsl(0 0% 0% / 0.2)"));
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--surface-reach-l") !== "");
      await page.waitForTimeout(150);
      const after = await card.boundingBox();
      assert.ok(Math.abs(after.x - before.x) < 0.5 && Math.abs(after.y - before.y) < 0.5 && Math.abs(after.width - before.width) < 0.5, JSON.stringify({ before, after }));
      assert.deepEqual(app.errors, [], "no page errors");
    } finally {
      await app.stop();
    }
  })());
