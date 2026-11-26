// The e2e files split into shards of about the same running time, by the seconds each file took
// on a recent CI run (scripts/e2e-durations.json; a file not listed there counts as the median).
//   node scripts/e2e-shard.mjs <shard> <total>   that shard's files, one per line (shard from 1)
//   node scripts/e2e-shard.mjs --check <total>   every file in exactly one shard, and each shard's estimate
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Longest first into the shard with the least time so far (ties: the first shard, then by name): the same split every time. */
export function shardsOf(files, durations, total) {
  const known = files.filter(name => name in durations).map(name => durations[name]).sort((a, b) => a - b);
  const median = known.length > 0 ? known[Math.floor(known.length / 2)] : 1;
  const weight = name => durations[name] ?? median;
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  for (const name of order) {
    const shard = shards.reduce((least, item) => (item.seconds < least.seconds ? item : least));
    shard.files.push(name);
    shard.seconds += weight(name);
  }
  return shards.map(shard => ({ files: [...shard.files].sort(), seconds: shard.seconds }));
}

function check(files, shards) {
  const listed = shards.flatMap(shard => shard.files);
  const twice = listed.filter((name, index) => listed.indexOf(name) !== index);
  const missing = files.filter(name => !listed.includes(name));
  const unknown = listed.filter(name => !files.includes(name));
  if (twice.length + missing.length + unknown.length > 0) throw new Error(`e2e shards: twice ${twice.join(", ") || "-"}; missing ${missing.join(", ") || "-"}; unknown ${unknown.join(", ") || "-"}`);
}

const files = readdirSync(join(ROOT, "e2e")).filter(name => name.endsWith(".test.mjs")).sort();
const durations = JSON.parse(readFileSync(join(ROOT, "scripts/e2e-durations.json"), "utf8"));
const [first, second] = process.argv.slice(2);
const checking = first === "--check";
const total = Number(second);
const shard = Number(first);
if (!Number.isInteger(total) || total < 1 || (!checking && (!Number.isInteger(shard) || shard < 1 || shard > total))) {
  console.error("usage: node scripts/e2e-shard.mjs <shard> <total> | --check <total>");
  process.exit(2);
}
const shards = shardsOf(files, durations, total);
check(files, shards);
if (checking) {
  for (const [index, item] of shards.entries()) console.log(`shard ${index + 1}/${total}: ${item.files.length} files, about ${Math.round(item.seconds / 60)} min`);
  console.log(`${files.length} files, each in exactly one shard`);
} else {
  console.log(shards[shard - 1].files.map(name => `e2e/${name}`).join("\n"));
}
