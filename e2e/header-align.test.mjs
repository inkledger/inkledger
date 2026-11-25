import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { start } from "./harness.mjs";

// The header's controls line up (docs/design-system.md §6.1, "A header's controls"): the segmented
// period, ‹ Today ›, the main action and the icon buttons share one height per density and one
// vertical centre, and an icon sits in the middle of its button, in every look (standard, soft, high
// contrast; light and dark). A user saw the segmented control shorter than its neighbours and the
// settings icon off centre: borders and rem heights on a 14 px root (31.5 px) made each control
// round to a different pixel.
const PAGES = ["/", "/timesheet", "/board", "/issues/DEMO-101"];
const LOOKS = [
  ["standard", "normal"],
  ["soft", "normal"],
  ["standard", "high"],
];
const SCHEMES = ["light", "dark"];
const DENSITIES = ["compact", "comfortable"];
const TOLERANCE = 0.5;

async function measure(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('main [data-slot="page-actions"]');
    if (!bar) return null;
    const shown = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    // A control as it stands in the row: a button or link, a radio group, a group of buttons (a card).
    const units = [];
    const walk = el => {
      for (const child of el.children) {
        if (!shown(child) && getComputedStyle(child).display !== "contents") continue;
        if (child.matches('button, a[href], [role="radiogroup"], [data-surface="card"]')) units.push(child);
        else walk(child);
      }
    };
    walk(bar);
    const name = el => (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24);
    const box = el => {
      const r = el.getBoundingClientRect();
      return { name: name(el), top: r.top, bottom: r.bottom, left: r.left, right: r.right, cy: (r.top + r.bottom) / 2, cx: (r.left + r.right) / 2 };
    };
    // What paints: edges snap to device pixels (DPR 1 here), so a 14 px icon in a 31.5 px box is 9 px
    // above and 8 below although its centre is exact. Compared snapped, the gaps must be equal.
    const gaps = (inner, outer) => ({
      above: Math.round(inner.top) - Math.round(outer.top),
      below: Math.round(outer.bottom) - Math.round(inner.bottom),
      before: Math.round(inner.left) - Math.round(outer.left),
      after: Math.round(outer.right) - Math.round(inner.right),
    });
    // Icons in their buttons (icon-only ones), and the chosen option in its segmented group.
    const icons = [];
    for (const button of bar.querySelectorAll("button")) {
      const svg = button.querySelector(":scope > svg");
      if (!svg || !shown(button) || button.textContent.trim() !== "") continue;
      const b = box(button);
      const s = box(svg);
      // A tilted icon (the pin) has a box bigger than its glyph: only its centre is compared.
      const tilted = getComputedStyle(svg).transform !== "none";
      icons.push({ name: b.name, dx: s.cx - b.cx, dy: s.cy - b.cy, tilted, ...gaps(s, b) });
    }
    const pills = [];
    for (const group of bar.querySelectorAll('[role="radiogroup"]')) {
      const pill = group.querySelector('[aria-checked="true"]');
      if (!pill || !shown(group)) continue;
      const g = box(group);
      const p = box(pill);
      pills.push({ name: name(group), exact: { above: p.top - g.top, below: g.bottom - p.bottom }, ...gaps(p, g) });
    }
    // A group of buttons (‹ Today ›): its buttons fill it, border to border.
    const fills = [];
    for (const card of bar.querySelectorAll('[data-surface="card"]')) {
      if (!shown(card)) continue;
      const c = card.getBoundingClientRect();
      const inner = { top: c.top + card.clientTop, bottom: c.top + card.clientTop + card.clientHeight };
      for (const button of card.querySelectorAll(":scope > button")) {
        const b = button.getBoundingClientRect();
        fills.push({ name: name(button), above: b.top - inner.top, below: inner.bottom - b.bottom });
      }
    }
    return { units: units.filter(shown).map(box), icons, pills, fills, root: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
}

function problemsOf(m, where) {
  if (!m) return [`${where}: no header actions`];
  const problems = [];
  // Rows: controls whose centres are near are on one line (a narrow header may wrap).
  const rows = [];
  for (const u of m.units) {
    const row = rows.find(r => Math.abs(r[0].cy - u.cy) < 12);
    if (row) row.push(u);
    else rows.push([u]);
  }
  for (const row of rows) {
    const [first, ...rest] = row;
    for (const u of rest) {
      if (Math.abs(u.top - first.top) > TOLERANCE || Math.abs(u.bottom - first.bottom) > TOLERANCE)
        problems.push(`${where}: "${u.name}" ${u.top.toFixed(2)}–${u.bottom.toFixed(2)} vs "${first.name}" ${first.top.toFixed(2)}–${first.bottom.toFixed(2)}`);
    }
  }
  if (m.units.length < 2) problems.push(`${where}: only ${m.units.length} control(s) found`);
  for (const i of m.icons) {
    if (Math.abs(i.dx) > TOLERANCE || Math.abs(i.dy) > TOLERANCE) problems.push(`${where}: icon of "${i.name}" off centre by ${i.dx.toFixed(2)}, ${i.dy.toFixed(2)}`);
    if (!i.tilted && (i.above !== i.below || i.before !== i.after)) problems.push(`${where}: icon of "${i.name}" paints ${i.above}/${i.below} px above/below, ${i.before}/${i.after} px before/after`);
  }
  for (const p of m.pills) {
    if (Math.abs(p.exact.above - p.exact.below) > TOLERANCE) problems.push(`${where}: chosen option of "${p.name}" ${p.exact.above.toFixed(2)} above, ${p.exact.below.toFixed(2)} below`);
    if (p.above !== p.below) problems.push(`${where}: chosen option of "${p.name}" paints ${p.above}/${p.below} px above/below`);
  }
  for (const f of m.fills)
    if (Math.abs(f.above) > TOLERANCE || Math.abs(f.below) > TOLERANCE) problems.push(`${where}: "${f.name}" does not fill its group (${f.above.toFixed(2)} above, ${f.below.toFixed(2)} below)`);
  return problems;
}

test("header controls share one height and centre in every look and density", { timeout: 600_000 }, async () => {
  const app = await start({ viewport: { width: 1600, height: 900 } });
  try {
    const { page, base, db } = app;
    const shots = process.env.ALIGN_SHOTS;
    const tag = process.env.ALIGN_TAG ?? "shot";
    if (shots) mkdirSync(shots, { recursive: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const problems = [];
    for (const density of DENSITIES) {
      for (const [variant, contrast] of LOOKS) {
        await db.q(
          "INSERT INTO settings (user_id, theme_variant, theme_contrast) VALUES (1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET theme_variant = EXCLUDED.theme_variant, theme_contrast = EXCLUDED.theme_contrast",
          variant, contrast,
        );
        for (const scheme of SCHEMES) {
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
          await page.addInitScript(([d, v, c]) => {
            localStorage.setItem("ikl-density", d);
            localStorage.setItem("ikl-locale", "it");
            localStorage.setItem("ikl-appearance", JSON.stringify({ variant: v, contrast: c }));
          }, [density, variant, contrast]);
          for (const route of PAGES) {
            await page.goto(base + route);
            await page.locator('main [data-slot="page-actions"]').first().waitFor();
            await page.waitForFunction(([v, c]) => document.documentElement.dataset.variant === v && document.documentElement.dataset.contrast === c, [variant, contrast]);
            await page.waitForTimeout(600);
            await page.mouse.move(0, 0);
            const where = `${route} ${variant}/${contrast}/${scheme}/${density}`;
            const m = await measure(page);
            if (m) assert.equal(m.root, density === "comfortable" ? 16 : 14, `${where}: density applied`);
            problems.push(...problemsOf(m, where));
            if (shots && route === "/") {
              const look = contrast === "high" ? "high" : variant;
              await page.locator('main [data-slot="page-actions"]').first().screenshot({ path: join(shots, `align-${tag}-${look}-${scheme}-${density}.png`) });
            }
          }
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  } finally {
    await app.stop();
  }
});
