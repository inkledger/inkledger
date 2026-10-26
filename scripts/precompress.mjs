#!/usr/bin/env node
// After `vite build`: a brotli (.br) and a gzip (.gz) copy of each text asset in
// dist/public, at the highest levels, so the server sends them as they are
// (serveStatic precompressed, api/lib/vite.ts) instead of compressing per request.
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = new URL("../dist/public", import.meta.url).pathname;
const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt|xml|map)$/;
// Below this, the headers weigh more than what compression saves.
const MIN_BYTES = 1024;

let files = 0;
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.test(name) && statSync(p).size >= MIN_BYTES) {
      const body = readFileSync(p);
      const br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
      writeFileSync(`${p}.br`, br);
      writeFileSync(`${p}.gz`, gzipSync(body, { level: 9 }));
      files++;
      before += body.length;
      after += br.length;
    }
  }
};
copyFileSync(join(ROOT, "index.html"), join(ROOT, "offline.html"));
walk(ROOT);
console.log(`precompressed ${files} files: ${(before / 1024).toFixed(0)} KiB → ${(after / 1024).toFixed(0)} KiB brotli`);
