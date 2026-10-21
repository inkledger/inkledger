// Every box that stands out is a surface (src/components/app/surface.ts), so a
// module drawing on surfaces (Shadow) reaches the whole app, not only the
// Dashboard. On each page: a visible element with a border on every side,
// rounded corners and an opaque background is marked itself, or is the face of
// a marked wrap (its parent). Text fields are sunk by design and never marked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const PAGES = ["/", "/issues", "/board", "/timesheet", "/reports", "/settings", "/settings/store", "/issues/DEMO-101", "/info"];

/** The page's unmarked boxes that stand out, as short descriptions. */
const unmarked = page =>
  page.evaluate(() => {
    const SUNK = "input, textarea, select, [role=combobox], [contenteditable=true]";
    const opaque = c => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return false;
      const parts = m[1].split(/[ ,/]+/).filter(Boolean);
      return parts.length < 4 || Number(parts[3]) >= 0.99;
    };
    const out = [];
    for (const el of document.querySelectorAll("[data-surface-stage] *")) {
      if (!(el instanceof HTMLElement) || el.matches(SUNK) || el.closest(SUNK)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || Number(s.opacity) === 0) continue;
      const bordered = ["Top", "Right", "Bottom", "Left"].every(side => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none");
      if (!bordered || parseFloat(s.borderTopLeftRadius) < 2 || !opaque(s.backgroundColor)) continue;
      const marked = el.hasAttribute("data-surface") || (el.dataset.surfaceRole === "face" && el.parentElement?.hasAttribute("data-surface"));
      if (marked) continue;
      out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 6).join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    }
    return out;
  });

test("every box that stands out, on every page, is a surface a module can draw on", async () => {
  const app = await start();
  try {
    const misses = [];
    for (const path of PAGES) {
      await app.page.goto(app.base + path);
      await app.page.locator("[data-surface-stage]").waitFor();
      await app.page.waitForTimeout(1200);
      for (const m of await unmarked(app.page)) misses.push(`${path}  ${m}`);
    }
    assert.deepEqual(misses, [], `unmarked boxes:\n${misses.join("\n")}`);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
