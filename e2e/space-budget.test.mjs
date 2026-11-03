import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

// The spatial system's budgets (docs/design-system.md §7.1), page by page, on a phone and a laptop.
// Enforced: no focusable control clipped out of sight by an ancestor that does not scroll, and no
// sideways scroller outside a declared board or table. Reported (for the before/after): the chrome's
// share of the screen, how many screens a page is, and scrollers' hidden items.
const ROUTES = ["/", "/timesheet", "/reports", "/issues", "/issues/DEMO-101", "/board", "/team", "/notes", "/ideas", "/settings"];
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const visible = element => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && !element.closest(".sr-only, [inert], [aria-hidden=true]");
    };
    // The page's own scroller: main on a laptop, the window on a phone.
    const scroller = main.scrollHeight > main.clientHeight + 1 ? main : document.scrollingElement;
    const viewport = scroller === main ? main.clientHeight : innerHeight;
    // The chrome: what stays put while the page scrolls (sticky bars inside main, the phone's own header).
    const mainTop = main.getBoundingClientRect().top;
    let chromeBottom = scroller === main ? mainTop : 0;
    for (const element of main.querySelectorAll("*")) {
      if (getComputedStyle(element).position !== "sticky" || !visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top <= mainTop + 200) chromeBottom = Math.max(chromeBottom, rect.bottom);
    }
    const header = document.querySelector("body > div header, header.sticky");
    if (scroller !== main && header && visible(header)) chromeBottom = Math.max(chromeBottom, header.getBoundingClientRect().bottom);
    const chrome = Math.max(0, chromeBottom - (scroller === main ? mainTop : 0));
    const declared = element => element.closest("[data-overflow-ok], table, [data-slot=table-container]");
    // Sideways scrollers that are neither a declared board nor a table.
    const sideways = [...main.querySelectorAll("*")].filter(element => {
      if (!visible(element) || declared(element)) return false;
      const overflow = getComputedStyle(element).overflowX;
      return (overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth + 1;
    }).map(element => `${element.tagName.toLowerCase()}.${String(element.className).split(" ").slice(0, 4).join(".")}`);
    // Focusable controls cut out of sight by an ancestor that clips without scrolling (a mask, a fixed height).
    const focusables = [...main.querySelectorAll("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(visible);
    const clipped = [];
    const offscreen = [];
    for (const element of focusables) {
      const rect = element.getBoundingClientRect();
      for (let parent = element.parentElement; parent && parent !== main; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
        if (!clips) continue;
        const box = parent.getBoundingClientRect();
        const outside = rect.right < box.left + 1 || rect.left > box.right - 1 || rect.bottom < box.top + 1 || rect.top > box.bottom - 1;
        if (!outside) continue;
        const scrolls = ["auto", "scroll"].includes(style.overflowX) || ["auto", "scroll"].includes(style.overflowY);
        const label = `${element.tagName.toLowerCase()}:${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 30)}`;
        (scrolls ? offscreen : clipped).push(label);
        break;
      }
    }
    return {
      chromePct: Math.round((chrome / innerHeight) * 100),
      screens: Math.round((scroller.scrollHeight / viewport) * 100) / 100,
      sideways,
      clipped,
      offscreen: offscreen.length,
    };
  });
}

for (const viewport of VIEWPORTS) {
  test(`space budget at ${viewport.width}×${viewport.height}`, { timeout: 300_000 }, async () => {
    const app = await start({ viewport });
    const rows = [];
    try {
      await app.page.emulateMedia({ reducedMotion: "reduce" });
      for (const route of ROUTES) {
        await app.page.goto(app.base + route);
        await app.page.locator("[data-surface-stage]").waitFor();
        await app.page.waitForTimeout(1200);
        const result = await measure(app.page);
        if (result) rows.push({ route, ...result });
      }
    } finally {
      await app.stop();
    }
    // The baseline, printed for the redesign's before/after (docs/work/ui-density.md).
    console.log(`space budget ${viewport.width}×${viewport.height}\n` + rows.map(r => `  ${r.route.padEnd(18)} chrome ${String(r.chromePct).padStart(3)}%  screens ${String(r.screens).padStart(5)}  offscreen ${r.offscreen}  sideways ${r.sideways.length}  clipped ${r.clipped.length}`).join("\n"));
    const problems = rows.flatMap(r => [...r.clipped.map(c => `${r.route}: clipped ${c}`), ...r.sideways.map(s => `${r.route}: sideways ${s}`)]);
    // Enforced: no focusable control clipped by a mask, no sideways scroller that is not a declared
    // board or table (data-overflow-ok). The figures above are reported for the before/after.
    assert.deepEqual(problems, [], problems.join("\n"));
  });
}
