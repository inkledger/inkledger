// Design-system guard: app components must use tokens (type scale, theme
// colours) instead of ad-hoc values. Runs in `pnpm lint` and CI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const SKIP = [join(ROOT, "components/ui")];

const RULES = [
  { re: /\btext-\[\d+(\.\d+)?(px|rem|em)\]/g, why: "use the type scale (text-display/title/heading/body/body-sm/caption/overline/2xs)" },
  { re: /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)\b(?!-)/g, why: "Tailwind default size: use the type scale (body/body-sm/caption/...)" },
  { re: /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g, why: "hex colour: use theme tokens" },
  { re: /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g, why: "Tailwind palette colour: use theme tokens" },
  { re: /\b(?:bg|text|border)-(?:black|white)\b(?!\/)/g, why: "pure black/white: use background/foreground tokens" },
  { re: /\bfont-mono\b/g, why: "no monospace in app UI" },
  { re: /<datalist\b/g, why: "native datalist popup ignores the theme: use IssuePicker / Command" },
  { re: /(?<!hover:)\bshadow-(?:md|lg|xl|2xl)\b/g, why: "strong elevation is for popovers/dialogs (components/ui) only" },
  { re: /\brounded-(?:3xl|\[[^\]]+\])/g, why: "radius outside the scale: use sm/md/lg/xl/2xl" },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.some((s) => p.startsWith(s))) continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}

// Theme tokens (CSS variables) must also be registered as Tailwind colours,
// or classes like `text-primary-strong` silently generate nothing.
const css = readFileSync(join(ROOT, "index.css"), "utf8");
const twConfig = readFileSync(new URL("../tailwind.config.js", import.meta.url), "utf8");
const cssTokens = new Set([...css.matchAll(/--([a-z][a-z0-9-]*):/g)].map((m) => m[1]));
const registered = new Set([...twConfig.matchAll(/token\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));
const COLOUR_CLASS = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|caret|accent)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9-])/g;

let problems = 0;
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("design-ok")) return; // explicit, reviewed exception
    for (const m of line.matchAll(COLOUR_CLASS)) {
      const name = m[1];
      if (cssTokens.has(name) && !registered.has(name)) {
        problems++;
        console.log(`${relative(process.cwd(), file)}:${i + 1}  ${m[0]}  → --${name} is not a Tailwind colour (add token("${name}") to tailwind.config.js)`);
      }
    }
    for (const { re, why } of RULES) {
      for (const m of line.matchAll(re)) {
        problems++;
        console.log(`${relative(process.cwd(), file)}:${i + 1}  ${m[0]}  → ${why}`);
      }
    }
  });
}
// Surfaces (src/components/app/surface.ts) are marked only through the typed
// helper, ui primitives included: a hand-written attribute would escape the
// catalog's kinds and elevations. The stage and the panel are the shell's.
const SURFACE_ATTR = /\bdata-(?:lit(?:-[a-z]+)?|surface(?:-(?:role|edge|current))?|elev)(?=[\s=>{])/g;
function* walkAll(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkAll(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}
for (const file of walkAll(ROOT)) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(SURFACE_ATTR)) {
        problems++;
        console.log(`${relative(process.cwd(), file)}:${i + 1}  ${m[0]}  → mark surfaces with surface()/surfaceFace() (components/app/surface.ts)`);
      }
    });
}

// Every box that stands out (rounded, bordered, opaque or with a shadow) is a
// surface, so a module drawing on surfaces (Shadow) reaches the whole app: it
// spreads surface()/surfaceFace() (glass or ground when it must not cast), or
// says why not on the line above: `// surface: none — <why>`.
const OPAQUE = /\b(?:bg-(?:card|background|muted|popover|canvas|primary-soft|accent)(?![\w/-])|shadow-(?:xs|sm|md|lg|xl|2xl))/;
const BORDERED = /(?<![\w-])border(?:-[0-9]|-dashed|-y|-x|-t|-b|-l|-r)?(?![\w-])/;
const ROUNDED = /\brounded(?:-[a-z0-9[\]]+)?\b/;
/** The JSX opening tags of a file, with the line each starts on. */
function* tags(text) {
  for (const m of text.matchAll(/<([A-Z][\w.]*|[a-z][\w-]*)[\s>]/g)) {
    let depth = 0;
    let quote = null;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote && text[i - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    yield { tag: text.slice(m.index, i + 1), line: text.slice(0, m.index).split("\n").length };
  }
}
for (const file of walkAll(ROOT)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const { tag, line } of tags(text)) {
    if (!/className=/.test(tag) || /\bsurface(?:Face)?\(/.test(tag)) continue;
    if (!(ROUNDED.test(tag) && BORDERED.test(tag) && OPAQUE.test(tag))) continue;
    const above = lines.slice(Math.max(0, line - 3), line - 1).join("\n");
    if (/surface: none/.test(above)) continue;
    problems++;
    console.log(`${relative(process.cwd(), file)}:${line}  a box that stands out without surface()  → surface()/surfaceFace(), or // surface: none — <why>`);
  }
}

if (problems > 0) {
  console.log(`\n✖ ${problems} design-system violation(s)`);
  process.exit(1);
}
console.log("✓ design system: no violations");
