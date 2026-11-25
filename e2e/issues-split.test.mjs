import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, TAB, withApp } from "./harness.mjs";
import { seedDense } from "./fixtures/dense.mjs";
import { LOOKS, lookName, scanLayout } from "./visual-sweep.mjs";

// The Issues page's split (docs/design-system.md §7.1): the preview beside the list is resized on its edge
// (dragged, by the keys, back to the default by a double click) and keeps its width on this device; the
// catalogue's first columns (pick, star, key, title) and last ones (timer, actions) stay put while the
// middle scrolls sideways, and its header stays under the bars while the rows scroll.

const previewWidth = page => page.locator("[data-issues-preview]").evaluate(el => el.getBoundingClientRect().width);

test("issues: the preview is resized on its edge and keeps its width", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 1440, height: 900 } }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    const handle = page.getByRole("separator", { name: /^Resize the preview/ });
    await handle.waitFor();
    assert.equal(await handle.getAttribute("aria-controls"), "issues-preview");
    const before = await previewWidth(page);
    assert.ok(Math.abs(before - 26 * 14) <= 1, `the default is 26rem (${before})`);

    // Dragged 120 px to the left: the preview is 120 px wider.
    const box = await handle.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2 - i * 20, y);
    await page.mouse.up();
    await page.waitForTimeout(100);
    const dragged = await previewWidth(page);
    assert.ok(Math.abs(dragged - (before + 120)) <= 2, `dragged to ${dragged}, expected ${before + 120}`);
    assert.equal(Number(await handle.getAttribute("aria-valuenow")), Math.round(dragged));

    // Kept after a reload.
    await page.reload();
    await handle.waitFor();
    assert.ok(Math.abs((await previewWidth(page)) - dragged) <= 1, "the width survives a reload");

    // Keys: → narrows by 16 px, Shift+← widens by 64, Home to 320, End to the largest (the list keeps 480).
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    assert.ok(Math.abs((await previewWidth(page)) - (dragged - 16)) <= 1, "→ narrows it by 16 px");
    await page.keyboard.press("Shift+ArrowLeft");
    assert.ok(Math.abs((await previewWidth(page)) - (dragged + 48)) <= 1, "Shift+← widens it by 64 px");
    await page.keyboard.press("Home");
    assert.equal(Math.round(await previewWidth(page)), 320, "Home: its smallest");
    await page.keyboard.press("End");
    const widest = await previewWidth(page);
    assert.equal(Math.round(widest), Number(await handle.getAttribute("aria-valuemax")));
    const list = await page.locator("section[data-workspace-anchor='issues.catalog']").evaluate(el => el.getBoundingClientRect().width);
    assert.ok(list >= 480 - 1, `the list keeps 480 px (${list})`);
    assert.ok(widest <= 1440 * 0.6 + 1, "at most 60% of the window");
    // At its widest some middle column of the table can still be reached by scrolling it.
    const reach = await page.locator(".sticky-table").last().evaluate(w => {
      const s = w.querySelector("[data-slot=table-container]");
      return { sticky: w.hasAttribute("data-sticky"), scroll: s.scrollWidth - s.clientWidth };
    });
    assert.ok(!reach.sticky || reach.scroll >= 0, "nothing frozen past the middle's room");

    // A double click: back to the default, and nothing kept.
    await handle.dblclick();
    assert.ok(Math.abs((await previewWidth(page)) - before) <= 1, "a double click restores the default");
    assert.equal(await page.evaluate(() => localStorage.getItem("ikl-issues-preview-width")), null);
  }));

/** Where a cell is, in the viewport. */
const left = cell => cell.evaluate(el => el.getBoundingClientRect().left);

test("issues: frozen columns stay put while the middle scrolls, in every look", { timeout: 600_000 }, () =>
  withApp({ seed: seedDense, viewport: { width: 1440, height: 900 }, env: { RATE_LIMIT: "off" } }, async ({ page, base, db }) => {
    for (const look of LOOKS) {
      const [variant, contrast, scheme] = look;
      const name = lookName(look);
      await db.q("INSERT INTO settings (user_id, theme_variant, theme_contrast) VALUES (1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET theme_variant = EXCLUDED.theme_variant, theme_contrast = EXCLUDED.theme_contrast", variant, contrast);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.addInitScript(([v, c]) => {
        localStorage.setItem("ikl-locale", "it");
        localStorage.setItem("ikl-appearance", JSON.stringify({ variant: v, contrast: c }));
        localStorage.removeItem("ikl-issues-preview-width");
      }, [variant, contrast]);
      await page.goto(base + "/issues");
      const table = page.locator(".sticky-table").last();
      await table.locator("tbody tr").first().waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      await page.waitForTimeout(500);
      await page.mouse.move(0, 0);
      const scroller = table.locator("[data-slot=table-container]");
      assert.equal(await table.getAttribute("data-sticky"), "", `${name}: the columns stick`);
      const overflow = await scroller.evaluate(s => s.scrollWidth - s.clientWidth);
      assert.ok(overflow > 40, `${name}: the table scrolls sideways (${overflow})`);
      assert.deepEqual(await page.evaluate(scanLayout), [], `${name}: nothing overlaps, unscrolled`);

      const row = table.locator("tbody tr").first();
      const cells = { key: row.locator('td[data-stick="3"]'), title: row.locator('td[data-stick="4"]'), timer: row.locator('td[data-stick="r2"]'), status: row.locator("td:nth-child(5)") };
      const at = {};
      for (const [k, cell] of Object.entries(cells)) at[k] = await left(cell);
      assert.equal(await table.getAttribute("data-under-start"), null, `${name}: nothing under the start yet`);
      await scroller.evaluate(s => (s.scrollLeft = s.scrollWidth));
      await page.waitForTimeout(200);
      const moved = await scroller.evaluate(s => s.scrollLeft);
      for (const k of ["key", "title", "timer"]) assert.ok(Math.abs((await left(cells[k])) - at[k]) < 1, `${name}: ${k} stays put`);
      assert.ok(Math.abs((await left(cells.status)) - (at.status - moved)) < 1, `${name}: the middle moves`);
      assert.equal(await table.getAttribute("data-under-start"), "", `${name}: something under the start now`);
      // The frozen cells are opaque: what passes under them does not show (the topmost element there is theirs).
      const covering = await cells.title.evaluate(td => {
        const b = td.getBoundingClientRect();
        const hit = document.elementFromPoint(b.right - 3, b.top + b.height / 2);
        return td.contains(hit);
      });
      assert.ok(covering, `${name}: the title's cell covers what scrolls under it`);
      assert.deepEqual(await page.evaluate(scanLayout), [], `${name}: nothing overlaps, scrolled`);

      if (name === "light-standard") {
        // A sort button in the middle, focused while it is under the frozen title: brought out from under it.
        const priority = table.locator("table[data-slot=table] thead").getByRole("button", { name: /^Priorità/ });
        await priority.focus();
        await page.waitForTimeout(100);
        const pb = await priority.boundingBox();
        const titleRight = await table.locator('table[data-slot=table] thead th[data-stick="4"]').evaluate(el => el.getBoundingClientRect().right);
        assert.ok(pb.x >= titleRight - 1, `the focused button is clear of the frozen columns (${pb.x} < ${titleRight})`);
        // Tab into a frozen cell's control: the table does not jump sideways.
        await scroller.evaluate(s => (s.scrollLeft = 120));
        const star = table.locator("tbody tr").first().locator("td[data-stick='2'] button").first();
        await star.focus();
        await page.keyboard.press(TAB);
        await page.keyboard.press(`Shift+${TAB}`);
        await page.waitForTimeout(100);
        assert.equal(await scroller.evaluate(s => s.scrollLeft), 120, "a frozen control's focus leaves the scroll as it was");

        // Down the list: the header stays under the bars, lined up with the columns.
        await page.evaluate(() => document.getElementById("main").scrollBy(0, 900));
        await page.waitForTimeout(300);
        assert.equal(await table.getAttribute("data-stuck"), "", "the header row has scrolled under the bars");
        const bar = table.locator(".sticky-table-bar");
        assert.ok(await bar.evaluate(el => getComputedStyle(el).visibility === "visible"), "the header strip shows");
        const stripKey = await bar.locator("th[data-stick='3']").evaluate(el => el.getBoundingClientRect());
        const rowKey = await cells.key.evaluate(el => el.getBoundingClientRect());
        assert.ok(Math.abs(stripKey.left - rowKey.left) < 1 && Math.abs(stripKey.width - rowKey.width) < 1, "the strip's columns line up with the rows'");
        const toolbar = await page.locator("[data-chrome=toolbar]").evaluate(el => el.getBoundingClientRect().bottom);
        const strip = await bar.evaluate(el => el.getBoundingClientRect().top);
        assert.ok(Math.abs(strip - toolbar) <= 2, `the strip sits under the filters (${strip} vs ${toolbar})`);
        // j / k: the selected row is never left under the strip.
        await page.locator("main").click({ position: { x: 5, y: 400 } });
        for (let i = 0; i < 12; i++) await page.keyboard.press("j");
        for (let i = 0; i < 6; i++) await page.keyboard.press("k");
        const sel = await page.locator("tr[aria-selected=true]").boundingBox();
        const stripBottom = await bar.locator("thead").evaluate(el => el.getBoundingClientRect().bottom);
        assert.ok(sel && sel.y >= stripBottom - 1, `the selected row is below the header strip (${sel?.y} < ${stripBottom})`);
        await page.evaluate(() => document.getElementById("main").scrollTo(0, 0));
      }

      await page.evaluate(AXE);
      const violations = await page.evaluate(async () =>
        (await axe.run(document.querySelector("main"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`)
      );
      assert.deepEqual(violations, [], `${name}: axe`);
    }
  }));
