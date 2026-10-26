// One Lighthouse run, in its own process (scripts/lighthouse.mjs starts one per run: Lighthouse
// keeps memory across runs in one process, and a whole matrix ran out of heap).
//   node scripts/lighthouse-run.mjs <url> <flags JSON> <out path without extension>
// Writes <out>.json and <out>.html; prints nothing on success.
import { writeFileSync } from "node:fs";
import lighthouse from "lighthouse";

const [url, flagsJson, out] = process.argv.slice(2);
const r = await lighthouse(url, JSON.parse(flagsJson));
if (!r) throw new Error(`no result for ${url}`);
writeFileSync(`${out}.json`, r.report[0]);
writeFileSync(`${out}.html`, r.report[1]);
