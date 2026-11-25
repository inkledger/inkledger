// Regenerates the static fallback tokens in src/index.css from the default
// base colour, so the first paint (before any saved theme) matches derive.ts.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "theme-")), "derive.mjs");
await build({ entryPoints: ["src/lib/theme/derive.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error" });
const { derivePalette, DEFAULT_BASE } = await import(pathToFileURL(out).href);
const p = derivePalette(DEFAULT_BASE);
const hc = derivePalette(DEFAULT_BASE, { variant: "standard", contrast: "high" });
// In file order: :root, .dark, :root[data-contrast="high"], .dark[data-contrast="high"].
const blocks = [p.light, p.dark, hc.light, hc.dark];

const css = readFileSync("src/index.css", "utf8");
let i = 0;
const next = css.replace(
  /(\/\* @theme-derived:start[^\n]*\n)[\s\S]*?(\n\s*\/\* @theme-derived:end \*\/)/g,
  (_m, start, end) => {
    const vars = blocks[i++];
    return start + Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`).join("\n") + end;
  },
);
if (i !== blocks.length) throw new Error("expected four @theme-derived blocks (:root, .dark and their high-contrast twins)");
writeFileSync("src/index.css", next);
console.log("✓ index.css theme tokens regenerated");
