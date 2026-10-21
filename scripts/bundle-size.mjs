// The client bundle's size, from `pnpm build`'s output (docs/dev/measuring.md):
// the entry chunk the page loads first, what it preloads, and every chunk by
// name. Names drop the content hash, so two builds compare line by line.
// `node scripts/bundle-size.mjs` prints JSON; `--md` a Markdown table.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const dir = path.resolve(import.meta.dirname, "../dist/public");
const html = readFileSync(path.join(dir, "index.html"), "utf8");
const entryFile = /<script[^>]*type="module"[^>]*src="\/assets\/([^"]+)"/.exec(html)?.[1];
if (!entryFile) throw new Error("bundle-size: no entry script in dist/public/index.html (run `pnpm build` first)");
const preloaded = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/assets\/([^"]+)"/g)].map((m) => m[1]);
const css = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="\/assets\/([^"]+)"/g)].map((m) => m[1]);

const stem = (f) => f.replace(/-[A-Za-z0-9_-]{8}(\.\w+)$/, "$1");
const size = (f) => {
  const buf = readFileSync(path.join(dir, "assets", f));
  return { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
};
const kb = (n) => Math.round(n / 102.4) / 10;

const files = readdirSync(path.join(dir, "assets")).filter((f) => /\.(js|css)$/.test(f));
const chunks = files
  .map((f) => ({ name: stem(f), ...size(f) }))
  .sort((a, b) => b.raw - a.raw || (a.name < b.name ? -1 : 1));
const sum = (list) => list.reduce((s, f) => ({ raw: s.raw + f.raw, gzip: s.gzip + f.gzip }), { raw: 0, gzip: 0 });
const first = [entryFile, ...preloaded, ...css];
const report = {
  entry: { name: stem(entryFile), ...size(entryFile) },
  firstLoad: { files: first.map(stem).sort(), ...sum(first.map(size)) },
  total: { js: sum(chunks.filter((c) => c.name.endsWith(".js"))), css: sum(chunks.filter((c) => c.name.endsWith(".css"))), count: chunks.length },
  chunks,
};

if (process.argv.includes("--md")) {
  const row = (n, s) => `| ${n} | ${kb(s.raw)} | ${kb(s.gzip)} |`;
  console.log(["| Chunk | KB | KB gzip |", "|---|---:|---:|", row(`entry \`${report.entry.name}\``, report.entry), row("first load (entry + preloads + css)", report.firstLoad), row(`all JS (${chunks.filter((c) => c.name.endsWith(".js")).length} chunks)`, report.total.js), row("all CSS", report.total.css)].join("\n"));
} else {
  console.log(JSON.stringify(report, null, 2));
}
