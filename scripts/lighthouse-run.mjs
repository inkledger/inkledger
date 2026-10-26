// One Lighthouse run, in its own process with its own Chromium (scripts/lighthouse.mjs starts one
// per run: one process, or one browser, kept over a whole matrix ran out of memory or crashed).
//   node scripts/lighthouse-run.mjs <url> <flags JSON> <out path without extension>
// Writes <out>.json and <out>.html; prints nothing on success.
import { writeFileSync } from "node:fs";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromiumPath } from "./chromium.mjs";

const [url, flagsJson, out] = process.argv.slice(2);
const chrome = await chromeLauncher.launch({ chromePath: chromiumPath(), chromeFlags: ["--headless=new", "--no-first-run"] });
try {
  const r = await lighthouse(url, { ...JSON.parse(flagsJson), port: chrome.port });
  if (!r) throw new Error(`no result for ${url}`);
  writeFileSync(`${out}.json`, r.report[0]);
  writeFileSync(`${out}.html`, r.report[1]);
} finally {
  await chrome.kill();
}
