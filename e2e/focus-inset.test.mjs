import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

// A field's focus is drawn inside it (data-focus="inset", index.css): the palette's search field drew the
// high-contrast 3 px outline as a dark rectangle over the palette's edge and its separator, ignoring its
// radius. In every look: no outline, an inset ring of ≥ 2 px (3 px in high contrast) in the ring colour,
// nothing past the field's parent padding box.
function focusGeometry() {
  const el = document.activeElement;
  const st = getComputedStyle(el);
  const outline = st.outlineStyle === "none" ? 0 : parseFloat(st.outlineWidth) + parseFloat(st.outlineOffset);
  const inset = /inset/.test(st.boxShadow) ? Math.max(...[...st.boxShadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px inset/g)].map(m => +m[4])) : 0;
  const r = el.getBoundingClientRect();
  const p = el.parentElement.getBoundingClientRect();
  return { tag: el.tagName, visible: el.matches(":focus-visible"), outline, inset, radius: st.borderTopLeftRadius, inside: r.left - outline >= p.left - 0.5 && r.right + outline <= p.right + 0.5 && r.top - outline >= p.top - 0.5 && r.bottom + outline <= p.bottom + 0.5 };
}

for (const contrast of ["normal", "high"]) {
  test(`fields draw their focus inside themselves (${contrast} contrast)`, async () => {
    const app = await start({ viewport: { width: 1440, height: 900 } });
    try {
      const { page, base, db } = app;
      await db.q("INSERT INTO settings (user_id, theme_contrast) VALUES (1, ?) ON CONFLICT (user_id) DO UPDATE SET theme_contrast = EXCLUDED.theme_contrast", contrast);
      await page.goto(base + "/");
      await page.waitForFunction(c => document.documentElement.dataset.contrast === c, contrast);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      await page.locator('[role="dialog"] input[role="combobox"]').waitFor();
      const want = contrast === "high" ? 3 : 2;
      const palette = await page.evaluate(focusGeometry);
      assert.equal(palette.tag, "INPUT");
      assert.ok(palette.visible, "the palette's field shows its focus");
      assert.equal(palette.outline, 0, "no outline sticking out of the palette's field");
      assert.ok(palette.inset >= want, `inset ring ${palette.inset}px`);
      assert.ok(palette.inside, "the ring stays inside the field's row");
      const clash = await page.evaluate(() => {
        const field = document.activeElement.getBoundingClientRect();
        const close = document.querySelector('[role="dialog"] [data-slot="dialog-close"]')?.getBoundingClientRect();
        return close ? field.right > close.left && field.left < close.right && field.bottom > close.top && field.top < close.bottom : false;
      });
      assert.equal(clash, false, "the field (and its ring) stops before the dialog's ✕");
      await page.keyboard.press("Escape");
      await page.locator('[data-anchor="log-time"]').first().click();
      const comment = page.locator('[role="dialog"] input[data-slot="input"]').first();
      await comment.waitFor();
      await page.keyboard.press("Tab");
      await comment.focus();
      const field = await page.evaluate(focusGeometry);
      assert.equal(field.outline, 0, "no outline around a dialog's field");
      assert.ok(field.inset >= want, `a dialog field's inset ring ${field.inset}px`);
      assert.notEqual(field.radius, "0px", "the ring follows the field's radius");
    } finally {
      await app.stop();
    }
  });
}
