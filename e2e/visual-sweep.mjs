// The visual sweep (docs/design-system.md §7, §12): every page and the main dialogs, in every look,
// density and width, checked for overlapping text, text that overflows without an ellipsis, a page
// that scrolls sideways, and rows of controls of unequal height. Shared by e2e/visual-sweep.test.mjs
// and the studio script that also saves the screenshots.

export const LOOKS = [
  ["standard", "normal", "light"], ["standard", "normal", "dark"], ["soft", "normal", "light"],
  ["soft", "normal", "dark"], ["standard", "high", "light"], ["standard", "high", "dark"],
];
export const lookName = ([variant, contrast, scheme]) => `${scheme}-${contrast === "high" ? "high" : variant}`;
export const DENSITIES = ["compact", "comfortable"];
export const WIDTHS = [1440, 1280, 1024, 390];

const SETTINGS = ["account", "connections", "buckets", "clients", "users", "teams", "sso", "schedule", "timers", "notifications", "appearance", "workspace", "pinboard", "todos", "estimates", "repositories", "outlook", "links", "backup", "audit", "network", "store"];
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** [name, path, action?]: an action opens a dialog or a variant of the page after it loads. */
export const PAGES = [
  ["dashboard", "/"],
  ["dialog-log-time", "/", async page => { await page.locator('[data-anchor="log-time"]').first().click(); await page.locator('[role="dialog"]').first().waitFor(); }],
  ["dialog-palette", "/", async page => { await page.keyboard.press(`${MOD}+k`); await page.locator('[role="dialog"]').first().waitFor(); await page.keyboard.type("LONG"); }],
  ["dialog-new-issue", "/issues", async page => { await page.getByRole("button", { name: /^(Nuova issue|New issue)$/ }).first().click(); await page.locator('[role="dialog"]').first().waitFor(); }],
  ["issues", "/issues"],
  ["issue", "/issues/LONG-1000"],
  ["desk", "/issues/desk"],
  ["timesheet", "/timesheet"],
  ["timesheet-month", "/timesheet?view=month"],
  ["board", "/board"],
  ["board-category", "/board", async page => { await page.getByRole("radiogroup", { name: /^(Disposizione della board|Board layout)/ }).getByRole("radio").nth(1).click(); }],
  ["pinboard", "/pinboard"],
  ["todos", "/todos"],
  ["ideas", "/ideas"],
  ["notes", "/notes"],
  ["notes-diary", "/notes/diary"],
  ["reports", "/reports"],
  ["team", "/team"],
  ["info", "/info"],
  ...SETTINGS.map(s => [`settings-${s}`, `/settings/${s}`]),
];

/** Runs in the page: what is wrong with its layout. */
export function scanLayout() {
  const problems = [];
  const root = document.querySelector('[role="dialog"], [role="alertdialog"]') ?? document.querySelector("main") ?? document.body;
  const inDialog = root.matches('[role="dialog"], [role="alertdialog"]');
  const visible = el => {
    if (el.closest(".sr-only, [hidden], [inert]")) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    // A visually hidden name (sr-only by a variant: a 1 px clipped box).
    return r.width > 1 && r.height > 1;
  };
  // What of a box can be seen: cut by every ancestor that clips (a scroller, a truncating row).
  const clipOf = el => {
    let c = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.overflowX === "visible" && st.overflowY === "visible") continue;
      const r = e.getBoundingClientRect();
      c = { left: Math.max(c.left, r.left), top: Math.max(c.top, r.top), right: Math.min(c.right, r.right), bottom: Math.min(c.bottom, r.bottom) };
    }
    return c;
  };
  const cut = (r, c) => {
    const x = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
    return x.right - x.left > 1 && x.bottom - x.top > 1 ? x : null;
  };
  const sel = el => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      const slot = e.getAttribute("data-slot"), role = e.getAttribute("role"), lab = e.getAttribute("aria-label");
      if (slot) p += `[data-slot=${slot}]`; else if (role) p += `[role=${role}]`;
      if (lab) p += `[aria-label="${lab.slice(0, 24)}"]`;
      else if (e.classList.length && parts.length === 0) p += "." + [...e.classList].slice(0, 3).join(".");
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const label = el => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
  const filled = bg => bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg);
  // Text boxes: the rectangles of each element's own text (a Range over its text nodes).
  const texts = [];
  for (const el of root.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "OPTION"].includes(el.tagName) || el.closest("svg")) continue;
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
    if (!own.length || !visible(el)) continue;
    const clip = clipOf(el);
    for (const node of own) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const raw of range.getClientRects()) {
        const r = cut(raw, clip);
        if (r) texts.push({ el, r });
      }
    }
    // (b) text that overflows its box with no ellipsis (not a scroller, not clamped).
    const st = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && st.textOverflow !== "ellipsis" && !["auto", "scroll"].includes(st.overflowX) && st.webkitLineClamp === "none" && st.display !== "inline")
      problems.push({ kind: "overflow", sel: sel(el), text: label(el), detail: `${el.scrollWidth}>${el.clientWidth}` });
  }
  // Leaf boxes with a fill of their own (heat cells, bars, chips): text must not run over them.
  const fills = [];
  for (const el of root.querySelectorAll("button, td, span, div")) {
    if ([...el.children].some(c => c.tagName.toLowerCase() !== "svg" && c.tagName !== "SPAN")) continue;
    if (!filled(getComputedStyle(el).backgroundColor) || !visible(el)) continue;
    const r = cut(el.getBoundingClientRect(), clipOf(el));
    if (r) fills.push({ el, r });
  }
  const meet = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 1 && h > 1 ? { x: (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2, y: (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2 } : null;
  };
  // A box of its own drawn over the other at that point (a sticky column's ground, a header): covered, not overlapping.
  // A frozen cell is such a box itself (the middle's cells pass under it).
  const covered = (top, under, p) => {
    for (let e = getComputedStyle(top).position === "sticky" ? top : top.parentElement; e && !e.contains(under); e = e.parentElement) {
      if (!filled(getComputedStyle(e).backgroundColor)) continue;
      const r = e.getBoundingClientRect();
      if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) return true;
    }
    return false;
  };
  const reported = new Set();
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i];
    for (let j = i + 1; j < texts.length; j++) {
      const b = texts[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const p = meet(a.r, b.r);
      if (!p || covered(a.el, b.el, p) || covered(b.el, a.el, p)) continue;
      const key = sel(a.el) + "|" + sel(b.el);
      if (reported.has(key)) continue;
      reported.add(key);
      problems.push({ kind: "text-overlap", sel: sel(a.el), text: label(a.el), detail: `over "${label(b.el)}" (${sel(b.el)})` });
    }
    for (const f of fills) {
      if (f.el === a.el || f.el.contains(a.el) || a.el.contains(f.el)) continue;
      const p = meet(a.r, f.r);
      if (!p || covered(a.el, f.el, p) || covered(f.el, a.el, p)) continue;
      const key = sel(a.el) + "|fill|" + sel(f.el);
      if (reported.has(key)) continue;
      reported.add(key);
      problems.push({ kind: "text-over-box", sel: sel(a.el), text: label(a.el), detail: `over ${sel(f.el)}` });
    }
  }
  // (c) the page scrolling sideways.
  if (!inDialog) {
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) problems.push({ kind: "page-overflow", sel: "html", text: "", detail: `${doc.scrollWidth}>${doc.clientWidth}` });
    const main = document.querySelector("main");
    if (main && main.scrollWidth > main.clientWidth + 1) {
      // Who sticks out: the outermost boxes past main's edge that no scroller of their own holds.
      const edge = main.getBoundingClientRect().right;
      const out = [...main.querySelectorAll("*")].filter(el => {
        const r = el.getBoundingClientRect();
        if (r.right <= edge + 1 || r.width < 1 || r.height < 1) return false;
        for (let e = el.parentElement; e && e !== main; e = e.parentElement) {
          const st = getComputedStyle(e);
          if (st.overflowX === "auto" || st.overflowX === "scroll") return false;
          if (e.getBoundingClientRect().right > edge + 1) return false;
        }
        return true;
      });
      // main clips: only a box that really stands past its edge is cut off (a hidden tooltip's room is not).
      if (out.length) problems.push({ kind: "page-overflow", sel: out.slice(0, 3).map(sel).join(" | "), text: "", detail: `${main.scrollWidth}>${main.clientWidth}` });
    }
  }
  // (d) rows of controls: one height.
  const UNIT = 'button, a[data-slot="button"], [role="radiogroup"], [data-surface="card"], input:not([type=checkbox]):not([type=radio]), [role="combobox"]';
  for (const row of root.querySelectorAll('[role="toolbar"], [data-slot="page-actions"], [data-slot$="-footer"]')) {
    if (!visible(row)) continue;
    const units = [];
    const walk = el => { for (const c of el.children) { if (c.matches(UNIT)) { if (visible(c)) units.push(c); } else if (getComputedStyle(c).display === "contents" || ["SPAN", "DIV"].includes(c.tagName)) walk(c); } };
    walk(row);
    const lines = [];
    for (const u of units) { const r = u.getBoundingClientRect(); const cy = (r.top + r.bottom) / 2; const l = lines.find(x => Math.abs(x.cy - cy) < 10); if (l) l.u.push([u, r]); else lines.push({ cy, u: [[u, r]] }); }
    for (const l of lines) {
      const hs = l.u.map(([, r]) => r.height);
      if (l.u.length > 1 && Math.max(...hs) - Math.min(...hs) > 0.5)
        problems.push({ kind: "control-heights", sel: sel(row), text: "", detail: l.u.map(([u, r]) => `${(u.getAttribute("aria-label") || label(u) || u.tagName).slice(0, 18)}=${r.height.toFixed(1)}`).join(", ") });
    }
  }
  return problems;
}

async function settle(page) {
  await page.waitForLoadState("load");
  await page.locator("[data-surface-stage]").first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.mouse.move(0, 0);
}

/**
 * Sweeps one look: every density, width and page. shot(name, look, density, width) names a
 * screenshot file, or returns null for none. Returns the problems, each with where it was found.
 */
export async function sweepLook({ page, base, db }, look, { densities = DENSITIES, widths = WIDTHS, pages = PAGES, shot = null, shotType = "jpeg" } = {}) {
  const [variant, contrast, scheme] = look;
  const found = [];
  // Before the theme columns existed (an older build for the pixel diff) this just does nothing.
  await db.q("INSERT INTO settings (user_id, theme_variant, theme_contrast) VALUES (1, ?, ?) ON CONFLICT (user_id) DO UPDATE SET theme_variant = EXCLUDED.theme_variant, theme_contrast = EXCLUDED.theme_contrast", variant, contrast).catch(() => {});
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  for (const density of densities) {
    await page.addInitScript(([d, v, c]) => {
      localStorage.setItem("ikl-density", d);
      localStorage.setItem("ikl-locale", "it");
      localStorage.setItem("ikl-appearance", JSON.stringify({ variant: v, contrast: c }));
    }, [density, variant, contrast]);
    for (const width of widths) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      for (const [name, path, action] of pages) {
        const where = { page: name, look: lookName(look), density, width };
        try {
          await page.goto(base + path);
          await settle(page);
          if (action) {
            await action(page);
            await page.waitForTimeout(600);
          }
          for (const p of await page.evaluate(scanLayout)) found.push({ ...where, ...p });
          const file = shot?.(name, lookName(look), density, width);
          if (file) await page.screenshot({ path: file, type: shotType, ...(shotType === "jpeg" ? { quality: 70 } : {}) });
        } catch (e) {
          found.push({ ...where, kind: "error", sel: "", text: "", detail: String(e).split("\n")[0] });
        }
        if (action) await page.keyboard.press("Escape").catch(() => {});
      }
    }
  }
  return found;
}
