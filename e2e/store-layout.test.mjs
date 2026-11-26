// Settings › Store's cards hold their content at every width, in both layouts, in every look, in
// Italian (the longer strings): nothing runs past a card's edge (the badge truncates, a status
// wraps), a row's cards are one height, and switching a module on or off moves nothing (no layout
// shift: the badge keeps one width, nothing mounts). STORE_SHOTS=<dir> keeps a screenshot of each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { start } from "./harness.mjs";
import { storeFixture } from "./fixtures/store.mjs";
import { scanLayout } from "./visual-sweep.mjs";

const SHOTS = process.env.STORE_SHOTS;
const LOOKS = [
  ["light", "no-preference"],
  ["dark", "no-preference"],
  ["dark", "more"],
  ["light", "more"],
];
const WIDTHS = [1440, 1280, 1024, 390];

async function open(page, base, layout) {
  await page.addInitScript(l => {
    localStorage.setItem("ikl-locale", "it");
    localStorage.setItem("ikl-store-layout", l);
  }, layout);
  await page.goto(base + "/settings/store");
  await page.locator('[data-store-item="tune"] [data-store-badge]').waitFor();
  await page.waitForTimeout(500);
}

/** Runs in the page: each card's parts that leave it, and rows of unequal height. */
function cardProblems() {
  const out = [];
  const cards = [...document.querySelectorAll("[data-store-item]")];
  for (const card of cards) {
    const c = card.getBoundingClientRect();
    for (const el of card.querySelectorAll("button, [role=switch], [data-slot=chip], [data-store-badge], span, p")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.left < c.left - 1 || r.right > c.right + 1 || r.bottom > c.bottom + 1) out.push(`${card.dataset.storeItem}: ${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" leaves its card`);
    }
    for (const el of card.querySelectorAll("[data-store-badge] span")) {
      if (el.scrollWidth > el.clientWidth + 1 && !el.classList.contains("truncate")) out.push(`${card.dataset.storeItem}: badge text cut without an ellipsis`);
    }
  }
  const rows = new Map();
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    const top = Math.round(r.top);
    rows.set(top, [...(rows.get(top) ?? []), r.height]);
  }
  for (const [top, hs] of rows) if (Math.max(...hs) - Math.min(...hs) > 1) out.push(`row at ${top}: cards of unequal height ${hs.map(Math.round).join("/")}`);
  return [...new Set(out)];
}

test("store cards hold their content at every width, layout and look (Italian)", { timeout: 900_000 }, async () => {
  const store = await storeFixture();
  const app = await start({ seed: store.seed, viewport: { width: 1440, height: 900 }, env: { RATE_LIMIT: "off", ...store.env } });
  try {
    const { page, base } = app;
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const found = [];
    for (const [scheme, contrast] of LOOKS) {
      await page.emulateMedia({ colorScheme: scheme, contrast, reducedMotion: "reduce" });
      for (const layout of ["large", "compact"]) {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
          await open(page, base, layout);
          const where = `${scheme}-${contrast === "more" ? "high" : "normal"} ${layout} ${width}`;
          for (const p of await page.evaluate(cardProblems)) found.push(`${where}: ${p}`);
          for (const p of await page.evaluate(scanLayout)) found.push(`${where}: ${p.kind} ${p.sel} "${p.text}" ${p.detail}`);
          if (SHOTS) await page.screenshot({ path: join(SHOTS, `store-${scheme}-${contrast === "more" ? "high" : "normal"}-${layout}-${width}.png`) });
        }
      }
    }
    assert.deepEqual([...new Set(found)], [], [...new Set(found)].join("\n"));
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    store.close();
  }
});

test("switching a module on or off moves nothing on the page (no layout shift)", { timeout: 300_000 }, async () => {
  const store = await storeFixture();
  const app = await start({ seed: store.seed, viewport: { width: 1440, height: 900 }, env: { RATE_LIMIT: "off", ...store.env } });
  try {
    const { page, base } = app;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const boxes = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-store-item], [data-store-item] [data-store-action], [data-store-item] [data-store-badge]")].map(el => {
          // In the scrolled content's coordinates: a scroll (the page following a toast) is no shift.
          let s = el.parentElement;
          while (s && !["auto", "scroll"].includes(getComputedStyle(s).overflowY)) s = s.parentElement;
          const r = el.getBoundingClientRect();
          const y = s ? r.y - s.getBoundingClientRect().y + s.scrollTop : r.y + window.scrollY;
          return [el.closest("[data-store-item]")?.getAttribute("data-store-item"), el.tagName, r.x, y, r.width, r.height].join(" ");
        }),
      );
    const near = (a, b) =>
      a.length === b.length &&
      a.every((line, i) => {
        const x = line.split(" "), y = b[i].split(" ");
        return x.slice(0, 2).join() === y.slice(0, 2).join() && x.slice(2).every((v, k) => Math.abs(Number(v) - Number(y[k + 2])) <= 0.5);
      });
    for (const layout of ["large", "compact"]) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
        await open(page, base, layout);
        for (const id of ["tune", "hello"]) {
          const toggle = page.locator(`[data-store-item="${id}"] [role=switch]`);
          await toggle.scrollIntoViewIfNeeded();
          for (const step of ["off", "on"]) {
            const before = await boxes();
            await page.evaluate(() => {
              window.__shifts = [];
              // The Store's own shifts (a module switched on may draw elsewhere, the sidebar's footer: not the Store moving).
              const inStore = e => (e.sources ?? []).some(s => s.node && document.querySelector("#store-modules")?.contains(s.node));
              new PerformanceObserver(l => window.__shifts.push(...l.getEntries().filter(inStore).map(e => e.value))).observe({ type: "layout-shift", buffered: false });
            });
            await toggle.click();
            await page.waitForFunction(([want]) => document.querySelector(`[data-store-item] [role=switch][data-state="${want}"]`) !== null, [step === "off" ? "unchecked" : "checked"]);
            await page.waitForTimeout(700);
            const after = await boxes();
            assert.ok(near(before, after), `${layout} ${width} ${id} ${step}: boxes moved\n${before.filter((l, i) => l !== after[i]).join("\n")}\n→\n${after.filter((l, i) => l !== before[i]).join("\n")}`);
            const shift = await page.evaluate(() => window.__shifts.reduce((a, b) => a + b, 0));
            assert.equal(shift, 0, `${layout} ${width} ${id} ${step}: layout shift ${shift}`);
          }
        }
      }
    }
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    store.close();
  }
});
