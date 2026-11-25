// Reports: the trend's bars and the rows wear one colour per issue type (the data palette,
// docs/design-system.md §3.5), named in a legend and a tooltip, in every look, and stay clean for axe
// (high contrast against the enhanced, AAA contrast rule too). THEME_SHOTS=<dir> saves a screenshot per look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AXE, start } from "./harness.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const TYPES = { "DEMO-101": "Bug", "DEMO-102": "Attività", "DEMO-103": "Storia", "DEMO-104": "Epic", "DEMO-105": "Miglioramento", "DEMO-106": "Sottotask" };
const LOOKS = [
  ["light", "standard", "normal"],
  ["light", "soft", "normal"],
  ["light", "standard", "high"],
  ["dark", "standard", "normal"],
  ["dark", "soft", "normal"],
  ["dark", "standard", "high"],
];

async function axeSerious(page, enhanced) {
  await page.evaluate(AXE);
  return page.evaluate(
    async ([tags, enhanced]) =>
      (await axe.run(document, { runOnly: { type: "tag", values: enhanced ? [...tags, "wcag2aaa"] : tags } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        .filter(v => !enhanced || !v.tags.includes("wcag2aaa") || v.id === "color-contrast-enhanced")
        .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ") + " " + (n.any[0]?.message ?? "")).join(" | ")}`),
    [TAGS, enhanced],
  );
}

test("Reports colour the trend and the rows by issue type, with a legend and a tooltip, in every look", async () => {
  // Mon 12 – Sun 18 Oct 2026: a few hours a day across six types and one issue outside the catalogue.
  const app = await start({
    viewport: { width: 1440, height: 1000 },
    seed: async db => {
      for (const [key, type] of Object.entries(TYPES)) await db.q("UPDATE issues SET issue_type = ? WHERE key = ?", type, key);
      const keys = [...Object.keys(TYPES), "OLD-9"];
      let n = 0;
      for (let day = 12; day <= 16; day++) {
        for (let i = 0; i < 4; i++) {
          const key = keys[(day + i) % keys.length];
          const started = new Date(2026, 9, day, 9 + i * 2).getTime();
          await db.q(
            "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, ?, ?, ?, ?, '', 1)",
            key, `w-types-${n++}`, started, 1800 + ((day * 7 + i * 5) % 6) * 900,
          );
        }
      }
    },
  });
  try {
    const { page, base, context, db } = app;
    await context.addInitScript(() => localStorage.setItem("ikl-locale", "it"));
    const shots = process.env.THEME_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const found = [];
    for (const [scheme, variant, contrast] of LOOKS) {
      await db.q(
        "INSERT INTO settings (user_id, theme_variant, theme_contrast) VALUES (1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET theme_variant = EXCLUDED.theme_variant, theme_contrast = EXCLUDED.theme_contrast",
        variant, contrast,
      );
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(base + "/reports?from=2026-10-12&to=2026-10-18&group=issue");
      await page.waitForFunction(([v, c]) => document.documentElement.dataset.variant === v && document.documentElement.dataset.contrast === c, [variant, contrast]);
      const legend = page.getByRole("list", { name: "Tipi di issue" });
      await legend.waitFor();
      const look = `${scheme}/${variant}/${contrast}`;

      // The legend names every type in words (and the issue outside the catalogue as "Senza tipo").
      const names = await legend.locator("li").allInnerTexts();
      for (const type of [...Object.values(TYPES), "Senza tipo"]) assert.ok(names.some(n => n.includes(type)), `${look}: ${type} in the legend (${names.join(" | ")})`);

      // Hues mean real types: "Senza tipo" wears a neutral, never a palette colour.
      const noneSwatch = legend.locator("li").filter({ hasText: "Senza tipo" }).locator("span").first();
      assert.match((await noneSwatch.getAttribute("class")) ?? "", /bg-chart-other/, `${look}: no type is neutral`);
      // One colour per type: the legend's swatches and the bars' segments.
      const swatchColours = await legend.locator("li > span:first-child").evaluateAll(els => els.map(e => getComputedStyle(e).backgroundColor));
      assert.equal(new Set(swatchColours).size, swatchColours.length, `${look}: every type its own colour (${swatchColours.join(", ")})`);
      const trend = page.locator('[data-anchor-id="reports.trend"], section').filter({ has: legend }).first();
      const segments = await trend.locator("figure [class*='bg-data-']").evaluateAll(els => [...new Set(els.map(e => getComputedStyle(e).backgroundColor))]);
      assert.ok(segments.length >= 5, `${look}: the bars are stacked by type (${segments.length} colours)`);

      // Alignment: each swatch centred on its text, the legend starting where the bars do.
      const misaligned = await legend.locator("li").evaluateAll(items =>
        items
          .map(li => {
            const [sw, name] = [li.children[0].getBoundingClientRect(), li.children[1].getBoundingClientRect()];
            return Math.abs(sw.top + sw.height / 2 - (name.top + name.height / 2));
          })
          .filter(d => d > 1.5),
      );
      assert.deepEqual(misaligned, [], `${look}: swatches centred on their names`);
      const firstBar = await trend.locator("figure [role='img']").first().boundingBox();
      const legendBox = await legend.locator("li").first().boundingBox();
      assert.ok(Math.abs(legendBox.x - firstBar.x) <= 1.5, `${look}: the legend starts under the first bar (${legendBox.x} vs ${firstBar.x})`);

      // The rows: an issue's bar wears its type's colour, and its type is written beside it.
      const row = page.locator("main table tbody tr").filter({ hasText: "DEMO-101" }).first();
      await row.getByText("Bug", { exact: true }).waitFor();

      // The page's entrance fades it in: axe measures blended colours until it ends.
      await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
      found.push(...(await axeSerious(page, contrast === "high")).map(v => `${look} ${v}`));
      if (shots) {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: join(shots, `reports-${scheme}-${contrast === "high" ? "high" : variant}.png`), fullPage: true });
      }
    }
    assert.deepEqual(found, [], found.join("\n"));

    // Hover or focus a day: its types and hours in a tooltip; the bar is named for a screen reader too.
    const bar = page.getByRole("img", { name: /lunedì 12 ottobre/i });
    await bar.focus();
    const tip = page.locator('[data-surface="menu"]').filter({ hasText: /12 ottobre/ });
    await tip.waitFor();
    assert.ok((await tip.innerText()).match(/Bug|Attività|Storia|Epic|Miglioramento|Sottotask|Senza tipo/), await tip.innerText());
    assert.match((await bar.getAttribute("aria-label")) ?? "", /\(/, "the bar's name lists its types");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
