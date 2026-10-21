// Vendors seal's verification primitives into api/vendor/seal (they are never
// edited here: api/modules/seal.test.ts checks SHA256SUMS). Run after
// changing seal: SEAL=../seal node scripts/sync-seal.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SEAL = resolve(ROOT, process.env.SEAL ?? "../seal");
const OUT = join(ROOT, "api/vendor/seal");
const FILES = ["base64url.ts", "canonical.ts", "keys.ts", "envelope.ts", "package.ts"];

const git = (...args) => execFileSync("git", ["-C", SEAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let version;
try {
  version = git("describe", "--tags", "--always", "--dirty");
} catch {
  version = "uncommitted";
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const sums = FILES.map(f => {
  const text = readFileSync(join(SEAL, "src", f));
  writeFileSync(join(OUT, f), text);
  return `${createHash("sha256").update(text).digest("hex")}  ${f}`;
});
writeFileSync(join(OUT, "SHA256SUMS"), sums.join("\n") + "\n");
writeFileSync(join(OUT, "VERSION"), `seal ${version}\n`);
console.log(`seal ${version} → api/vendor/seal`);
