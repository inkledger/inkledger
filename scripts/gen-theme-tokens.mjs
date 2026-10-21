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

const css = readFileSync("src/index.css", "utf8");
let i = 0;
const next = css.replace(
  /(\/\* @theme-derived:start[^\n]*\n)[\s\S]*?(\n\s*\/\* @theme-derived:end \*\/)/g,
  (_m, start, end) => {
    const vars = i++ === 0 ? p.light : p.dark;
    return start + Object.entries(vars).map(([k, v]) => `    ${k}: ${v};`).join("\n") + end;
  },
);
if (i !== 2) throw new Error("expected two @theme-derived blocks (:root and .dark)");
writeFileSync("src/index.css", next);
console.log("✓ index.css theme tokens regenerated");
