// docs/design-system.md printed to docs/design-system.pdf, with two plates
// read from the code itself (never typed by hand, so they cannot drift): the
// colour tokens of src/index.css, light and dark, and the type scale of
// tailwind.config.js, set in the app's own fonts.
// Usage: node scripts/design-system-pdf.mjs [out.pdf]
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "./chromium.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const out = process.argv[2] ?? join(ROOT, "docs/design-system.pdf");
const md = readFileSync(join(ROOT, "docs/design-system.md"), "utf8");
const css = readFileSync(join(ROOT, "src/index.css"), "utf8");
// The config is CommonJS in an ESM package: evaluated as CommonJS, its plugins required from the app.
const twModule = { exports: {} };
runInNewContext(readFileSync(join(ROOT, "tailwind.config.js"), "utf8"), { module: twModule, exports: twModule.exports, require: createRequire(join(ROOT, "tailwind.config.js")) });
const tw = twModule.exports;

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline Markdown: code, bold, italic, links (the subset the document uses). */
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Block Markdown: headings, paragraphs, lists (with check boxes), tables, rules. */
function render(source) {
  const lines = source.split("\n");
  const html = [];
  const toc = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) {
      const level = h[1].length;
      const id = `s${toc.length}`;
      if (level === 2) toc.push({ id, text: h[2] });
      html.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^---+$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const [head, , ...body] = rows;
      html.push(
        `<table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^(\s*)([-*]|\d+\.) /.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items = [];
      while (i < lines.length && /^(\s*)([-*]|\d+\.) /.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.) /, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.) /.test(lines[i])) item += " " + lines[i++].trim();
        const box = item.match(/^\[( |x)\] (.*)$/);
        items.push(box ? `<li class="check">${box[1] === "x" ? "☑" : "☐"} ${inline(box[2])}</li>` : `<li>${inline(item)}</li>`);
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||---|\s*([-*]|\d+\.) )/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { body: html.join("\n"), toc };
}

/** The tokens of a block of src/index.css (`:root` or `.dark` in the base layer). */
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("\n  }", start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([\d.]+ [\d.]+% [\d.]+%);/g)].map(m => [m[1], m[2]]));
}
const light = tokens(":root");
const dark = { ...light, ...tokens(".dark") };

const GROUPS = [
  ["Surfaces and text", ["canvas", "background", "card", "popover", "foreground", "muted", "muted-foreground", "accent", "border", "input"]],
  ["Brand and action", ["primary", "primary-soft", "primary-strong", "primary-foreground", "action", "action-foreground", "ring"]],
  ["State", ["success", "success-soft", "warning", "warning-soft", "danger", "danger-soft", "info", "info-soft"]],
  ["Data", ["chart-focus", "chart-other", "chart-break", "chart-ink", "project-1", "project-2", "project-3", "project-4", "project-5", "project-6"]],
  ["Pinboard", ["paper", "tape-1", "tape-2", "tape-3", "tape-4", "tape-5", "string"]],
];
const swatch = (name, value) =>
  value ? `<div class="sw"><span style="background:hsl(${value.replace(/ /g, ", ")})"></span><b>${name}</b><small>hsl(${value})</small></div>` : "";
const palette = theme =>
  GROUPS.map(([title, names]) => `<h4>${title}</h4><div class="grid">${names.map(n => swatch(n, theme[n])).join("")}</div>`).join("");

const scale = Object.entries(tw.theme.extend.fontSize)
  .map(([name, [size, opts]]) => {
    const family = ["display", "title", "heading"].includes(name) ? "f-display" : "f-text";
    const style = `font-size:calc(${size.replace(/max\((\d+)px, ([\d.]+)rem\)/, "max($1px, $2 * 14px)").replace(/([\d.]+)rem/, "($1 * 14px)")});line-height:${opts.lineHeight};font-weight:${opts.fontWeight ?? 400};letter-spacing:${opts.letterSpacing ?? 0}`;
    return `<tr><td><code>text-${name}</code><br><small>${esc(size)}</small></td><td><div class="${family}" style="${style}">Your time, from every tracker</div></td></tr>`;
  })
  .join("");

// Embedded: a page set from a string may not read files.
const font = file => `data:font/woff2;base64,${readFileSync(join(ROOT, "node_modules/@fontsource-variable", file)).toString("base64")}`;
const { body, toc } = render(md.replace(/^# .*\n/, ""));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>inkledger design system</title><style>
@font-face { font-family: 'Inter Variable'; font-weight: 100 900; src: url(${font("inter/files/inter-latin-wght-normal.woff2")}) format('woff2'); }
@font-face { font-family: 'Inter Tight Variable'; font-weight: 100 900; src: url(${font("inter-tight/files/inter-tight-latin-wght-normal.woff2")}) format('woff2'); }
@page { size: A4; margin: 18mm 16mm 20mm; }
:root { --fg: hsl(${light.foreground.replace(/ /g, ",")}); --muted: hsl(${light["muted-foreground"].replace(/ /g, ",")}); --line: hsl(${light.border.replace(/ /g, ",")}); --soft: hsl(${light.muted.replace(/ /g, ",")}); --accent: hsl(${light["primary-strong"].replace(/ /g, ",")}); }
body { font-family: 'Inter Variable', system-ui, sans-serif; font-feature-settings: "cv11", "ss01", "ss03", "calt"; color: var(--fg); font-size: 10pt; line-height: 1.5; }
h1, h2, h3, h4 { font-family: 'Inter Tight Variable', 'Inter Variable', sans-serif; letter-spacing: -0.015em; }
h2 { font-size: 17pt; margin: 0 0 8pt; padding-top: 4pt; break-before: page; color: var(--fg); }
h3 { font-size: 12pt; margin: 14pt 0 4pt; }
h4 { font-size: 10pt; margin: 12pt 0 6pt; color: var(--muted); font-weight: 600; }
p, li { margin: 0 0 6pt; }
ul, ol { padding-left: 16pt; margin: 0 0 8pt; }
li.check { list-style: none; margin-left: -14pt; }
hr { display: none; }
a { color: var(--accent); }
code { font-family: ui-monospace, Menlo, monospace; font-size: 8.5pt; background: var(--soft); padding: 0.5pt 3pt; border-radius: 3pt; }
table { width: 100%; border-collapse: collapse; margin: 4pt 0 10pt; font-size: 9pt; break-inside: auto; }
th { text-align: left; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); padding: 4pt 6pt 4pt 0; }
td { border-bottom: 1px solid var(--line); padding: 4pt 6pt 4pt 0; vertical-align: top; }
tr { break-inside: avoid; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: flex-end; }
.cover h1 { font-size: 34pt; margin: 0; letter-spacing: -0.03em; }
.cover p { color: var(--muted); font-size: 12pt; max-width: 120mm; }
.band { height: 10mm; border-radius: 6pt; margin-bottom: 14pt; background: linear-gradient(90deg, ${["sunset-1", "sunset-2", "sunset-3", "sunset-4", "sunset-5"].map(n => `hsl(${light[n]?.replace(/ /g, ",")})`).join(",")}); }
.toc { break-before: page; }
.toc h2 { break-before: avoid; }
.toc ol { font-size: 11pt; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; }
.sw { display: grid; gap: 1pt; font-size: 7.5pt; }
.sw span { height: 14mm; border-radius: 5pt; border: 1px solid rgba(0,0,0,.08); }
.sw small { color: var(--muted); }
.f-display { font-family: 'Inter Tight Variable', 'Inter Variable', sans-serif; }
.f-text { font-family: 'Inter Variable', sans-serif; font-feature-settings: "cv11", "ss01", "ss03", "calt"; }
.plate.dark { background: hsl(${dark.canvas.replace(/ /g, ",")}); color: hsl(${dark.foreground.replace(/ /g, ",")}); padding: 10pt; border-radius: 8pt; }
.plate.dark h4, .plate.dark small { color: hsl(${dark["muted-foreground"].replace(/ /g, ",")}); }
</style></head><body>
<section class="cover"><div class="band"></div><h1>inkledger design system</h1><p>How inkledger looks, feels and is built: for the people and the AI agents who change it. Colours and type in the plates are read from the code.</p></section>
<section class="toc"><h2>Contents</h2><ol>${toc.map(t => `<li><a href="#${t.id}">${inline(t.text.replace(/^\d+\.\s*/, ""))}</a></li>`).join("")}<li><a href="#plates">Plates: colour and type</a></li></ol></section>
${body}
<h2 id="plates">Plates: colour and type</h2>
<p>The default palette (base colour #B5562F), from <code>src/index.css</code>. A user's own base colour derives every value again (§3.2).</p>
<h3>Light</h3><div class="plate">${palette(light)}</div>
<h3 style="break-before: page">Dark</h3><div class="plate dark">${palette(dark)}</div>
<h3 style="break-before: page">Type scale</h3><p>From <code>tailwind.config.js</code>, at the compact density (root 14 px).</p><table>${scale}</table>
</body></html>`;

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: out,
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate: `<div style="width:100%;font:8px Helvetica, sans-serif;color:#8a817a;padding:0 16mm;display:flex;justify-content:space-between"><span>inkledger design system</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
});
await browser.close();
console.log("pdf", out);
