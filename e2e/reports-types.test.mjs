// Reports: the trend's bars by issue type wear chart-focus and its tones (the five types with the most
// hours; the rest and "no type" are Other, chart-other), named in a legend and a tooltip, in every look,
// clean for axe (high contrast against the enhanced, AAA rule too); no patterns; one type is plain
// chart-focus with no legend; the rows are always chart-focus. The colours follow a theme switch without
// a reload. THEME_SHOTS=<dir> saves screenshots (mono-*, hc-*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AXE, start } from "./harness.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// Eight types (and an issue outside the catalogue): more than the scale's five.
const TYPES = { "DEMO-101": "Bug", "DEMO-102": "Attività", "DEMO-103": "Storia", "DEMO-104": "Epic", "DEMO-105": "Miglioramento", "DEMO-106": "Sottotask", "DEMO-107": "Supporto", "DEMO-108": "Analisi" };
// How often each key is logged: the types rank clearly (Attività first), the last three fall into Other.
const WEIGHTS = { "DEMO-102": 6, "DEMO-101": 5, "DEMO-103": 4, "DEMO-104": 3, "DEMO-105": 3, "DEMO-106": 1, "DEMO-107": 1, "DEMO-108": 1, "OLD-9": 2 };
const LOOKS = [
  ["light", "standard", "normal"],
  ["light", "soft", "normal"],
  ["light", "standard", "high"],
  ["dark", "standard", "normal"],
  ["dark", "soft", "normal"],
  ["dark", "standard", "high"],
];
// Not a preset range ("Mese scorso"): the trigger's preset caption is another test's business.
const URL_PATH = "/reports?from=2026-10-01&to=2026-10-30&group=issue";

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

const seed = async db => {
  for (const [key, type] of Object.entries(TYPES)) await db.q("UPDATE issues SET issue_type = ? WHERE key = ?", type, key);
  const pool = Object.entries(WEIGHTS).flatMap(([key, w]) => Array(w).fill(key));
  // Mon 2 Nov: one type only (a one-series chart).
  await db.q(
    "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-one', ?, 3600, '', 1)",
    new Date(2026, 10, 2, 10).getTime(),
  );
  let n = 0;
  for (let day = 1; day <= 31; day++) {
    const dow = new Date(2026, 9, day).getDay();
    if (dow === 0 || dow === 6) continue;
    for (let i = 0; i < 5; i++) {
      const key = pool[(day * 5 + i * 7) % pool.length];
      await db.q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, ?, ?, ?, ?, '', 1)",
        key, `w-types-${n++}`, new Date(2026, 9, day, 9 + i * 2).getTime(), 1800 + ((day * 7 + i * 5) % 4) * 900,
      );
    }
  }
};

const setLook = (db, variant, contrast) =>
  db.q(
    "INSERT INTO settings (user_id, theme_variant, theme_contrast) VALUES (1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET theme_variant = EXCLUDED.theme_variant, theme_contrast = EXCLUDED.theme_contrast",
    variant, contrast,
  );

/** The trend's segments and legend swatches: their fill and pattern, next to what their token resolves to now. */
const marks = page =>
  page.evaluate(() => {
    const resolve = cls => {
      const probe = document.createElement("span");
      probe.className = cls;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    };
    const legend = document.querySelector('[aria-label="Tipi di issue"]');
    const swatches = [...legend.querySelectorAll("li > span:first-child")].map(e => ({ cls: [...e.classList].find(c => c.startsWith("bg-chart-")), bg: getComputedStyle(e).backgroundColor }));
    const segments = [...document.querySelectorAll("figure .chart-seg")].map(e => ({ cls: [...e.classList].find(c => c.startsWith("bg-chart-")), bg: getComputedStyle(e).backgroundColor, image: getComputedStyle(e).backgroundImage }));
    return { swatches: swatches.map(s => ({ ...s, want: resolve(s.cls) })), segments: segments.map(s => ({ ...s, want: resolve(s.cls) })) };
  });

test("Reports colour the trend by issue type (chart-focus, its tones, Other), with a legend and a tooltip, in every look", async () => {
  const app = await start({ viewport: { width: 1440, height: 1000 }, seed });
  try {
    const { page, base, context, db } = app;
    await context.addInitScript(() => localStorage.setItem("ikl-locale", "it"));
    const shots = process.env.THEME_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    const found = [];
    const open = async (scheme, variant, contrast) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(base + URL_PATH);
      await page.waitForFunction(([v, c]) => document.documentElement.dataset.variant === v && document.documentElement.dataset.contrast === c, [variant, contrast]);
      await page.getByRole("list", { name: "Tipi di issue" }).waitFor();
      await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
    };
    for (const [scheme, variant, contrast] of LOOKS) {
      await setLook(db, variant, contrast);
      await open(scheme, variant, contrast);
      const look = `${scheme}/${variant}/${contrast}`;
      const legend = page.getByRole("list", { name: "Tipi di issue" });

      // The five busiest types by name, then Other (the other three types and the issue without one).
      const names = await legend.locator("li").allInnerTexts();
      assert.equal(names.length, 6, `${look}: five types and Other (${names.join(" | ")})`);
      for (const type of ["Attività", "Bug", "Storia", "Epic", "Miglioramento"]) assert.ok(names.some(n => n.includes(type)), `${look}: ${type} in the legend`);
      assert.match(names.at(-1), /^Altro/, `${look}: Other last`);
      for (const type of ["Sottotask", "Supporto", "Analisi", "Senza tipo"]) assert.ok(!names.some(n => n.startsWith(type)), `${look}: ${type} is in Other`);

      const m = await marks(page);
      assert.deepEqual(m.swatches.map(s => s.cls), ["bg-chart-focus", "bg-chart-tone-2", "bg-chart-tone-3", "bg-chart-tone-4", "bg-chart-tone-5", "bg-chart-other"], `${look}: chart-focus and its tones in order, then Other`);
      assert.equal(new Set(m.swatches.map(s => s.bg)).size, 6, `${look}: six different fills`);
      assert.ok(m.segments.length >= 20, `${look}: the bars are stacked by type (${m.segments.length})`);
      // No patterns, in any look.
      assert.deepEqual(m.segments.filter(s => s.image !== "none"), [], `${look}: no pattern`);

      // The rows: each type by name, every bar chart-focus.
      const row = page.locator("main table tbody tr").filter({ hasText: "DEMO-107" }).first();
      await row.getByText("Supporto", { exact: true }).waitFor();
      assert.equal(await page.locator("main table tbody [class*='bg-chart-tone'], main table tbody [class*='bg-chart-other']").count(), 0, `${look}: the rows are chart-focus`);

      found.push(...(await axeSerious(page, contrast === "high")).map(v => `${look} ${v}`));
      if (shots) {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: join(shots, `mono-${scheme}-${contrast === "high" ? "high" : variant}.png`), fullPage: true });
        if (contrast === "high") await page.screenshot({ path: join(shots, `hc-${scheme}-high.png`), fullPage: true });
      }
    }
    assert.deepEqual(found, [], found.join("\n"));

    // One type in the range: one series, plain chart-focus, no legend.
    await setLook(db, "standard", "normal");
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(base + "/reports?from=2026-11-02&to=2026-11-08&group=issue");
    await page.locator("figure .chart-seg").first().waitFor();
    assert.equal(await page.getByRole("list", { name: "Tipi di issue" }).count(), 0, "one series: no legend");
    const classes = await page.locator("figure .chart-seg").evaluateAll(els => [...new Set(els.map(e => [...e.classList].find(c => c.startsWith("bg-chart-"))))]);
    assert.deepEqual(classes, ["bg-chart-focus"], `one series is chart-focus (${classes})`);

    // Hover or focus a day: its types and hours in a tooltip; the bar is named for a screen reader too.
    await open("light", "standard", "normal");
    const bar = page.getByRole("img", { name: /lunedì 12 ottobre/i });
    await bar.focus();
    const tip = page.locator('[data-surface="menu"]').filter({ hasText: /12 ottobre/ });
    await tip.waitFor();
    assert.ok((await tip.innerText()).match(/Bug|Attività|Storia|Epic|Miglioramento|Altro/), await tip.innerText());
    assert.match((await bar.getAttribute("aria-label")) ?? "", /\(/, "the bar's name lists its types");

    // The scale follows the base colour: two more bases, light (screenshots only).
    if (shots) {
      for (const [name, hex] of [["oceano", "#2F5F98"], ["salvia", "#4F6B4A"]]) {
        await db.q("UPDATE settings SET theme_color = ? WHERE user_id = 1", hex);
        await open("light", "standard", "normal");
        await page.mouse.move(0, 0);
        await page.screenshot({ path: join(shots, `mono-light-${name}.png`), fullPage: true });
      }
      await db.q("UPDATE settings SET theme_color = '#B5562F' WHERE user_id = 1");
    }
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test("the chart colours follow a theme switch at once: light, dark, soft, high contrast, no reload", async () => {
  const app = await start({ viewport: { width: 1440, height: 1000 }, seed });
  try {
    const { page, base, context, db } = app;
    await context.addInitScript(() => localStorage.setItem("ikl-locale", "it"));
    await setLook(db, "standard", "normal");
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(base + URL_PATH);
    const legend = page.getByRole("list", { name: "Tipi di issue" });
    await legend.waitFor();
    await page.evaluate(() => (window.__sameLoad = true));
    const fills = async () => (await marks(page)).swatches.map(s => s.bg);
    // Every mark wears what its token resolves to in the look now on screen.
    const live = async what => {
      await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
      const m = await marks(page);
      for (const s of [...m.swatches, ...m.segments]) assert.equal(s.bg, s.want, `${what}: ${s.cls} follows the look`);
      assert.equal(await page.evaluate(() => window.__sameLoad), true, `${what}: no reload`);
      return m.swatches.map(s => s.bg);
    };
    const seen = [await live("light")];
    // Back to the report with the browser's history (in-app: no reload, the period kept).
    const back = async () => {
      while (!(await page.evaluate(() => location.pathname.startsWith("/reports")))) await page.goBack();
      await legend.waitFor();
    };

    // Dark, from the shell's switch.
    await page.getByRole("switch", { name: "Tema scuro" }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    seen.push(await live("dark"));

    // Soft, then high contrast, from Settings → Appearance (in-app navigation).
    await page.getByRole("link", { name: /^Impostazioni$/ }).first().click();
    await page.getByRole("link", { name: /Aspetto/ }).first().click().catch(() => {});
    const style = page.getByRole("radiogroup", { name: "Stile" });
    await style.getByRole("radio", { name: /Morbido/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.variant === "soft");
    await back();
    seen.push(await live("dark soft"));
    await page.getByRole("link", { name: /^Impostazioni$/ }).first().click();
    await page.getByRole("link", { name: /Aspetto/ }).first().click().catch(() => {});
    await page.getByRole("radiogroup", { name: "Contrasto" }).getByRole("radio", { name: /Alto/ }).click();
    await page.waitForFunction(() => document.documentElement.dataset.contrast === "high");
    await back();
    seen.push(await live("dark soft high"));

    // Light to dark changes the tones (soft and high contrast may keep chart-focus's: then so do they).
    assert.notDeepEqual(seen[1], seen[0], "light to dark changed the chart's colours");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});
