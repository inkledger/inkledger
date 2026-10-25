#!/usr/bin/env node
// Builds the native apps to hand out and collects them in release/<version>/
// with their checksums (docs/native.md).
//
//   pnpm dist             macOS (.app + .dmg, arm64) and Android (.apk)
//   pnpm dist --mac       macOS only
//   pnpm dist --android   Android only (built and published by native-publish)
//   --allow-dirty         build from uncommitted changes (marked so in the manifest)
//
// Unsigned: macOS asks to confirm the first launch (right click → Open), the
// APK is signed with the debug key. The version is package.json's (tauri.conf.json reads it).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const both = !args.has("--mac") && !args.has("--android");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; // one version for the server and the apps (tauri.conf.json reads it too)
const OUT = join(ROOT, "release", version);
const TARGET = "aarch64-apple-darwin";
const BUNDLE = join(ROOT, "src-tauri/target", TARGET, "release/bundle");

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: "inherit", ...opts });
  return r.status === 0;
}
const must = (ok, what) => {
  if (!ok) throw new Error(`dist: ${what} failed`);
};
const newest = (dir, ext) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
/** Bytes on disk of a file or a bundle directory. */
const sizeOf = (p) =>
  statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + sizeOf(join(p, f)), 0) : statSync(p).size;
const timed = (fn) => {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
};

const git = (...argv) => spawnSync("git", argv, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
// What the artifacts are built from: one commit, said per file (a later build of one platform keeps the others' own).
const source = { commit: git("rev-parse", "--short", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
if (source.dirty && !args.has("--allow-dirty")) throw new Error("dist: uncommitted changes; commit them or pass --allow-dirty (marked in the manifest)");

mkdirSync(OUT, { recursive: true });
const artifacts = [];
const builds = {};

if (both || args.has("--mac")) {
  // A bundle left from an earlier build must never be packed as this one's.
  const app = join(BUNDLE, "macos/inkledger.app");
  rmSync(app, { recursive: true, force: true });
  rmSync(join(BUNDLE, "dmg"), { recursive: true, force: true });
  let ok = true;
  builds.mac = timed(() => {
    ok = run("pnpm", ["tauri", "build", "--target", TARGET, "--bundles", "app,dmg"]);
  });
  // Failed before the .app was made: the build failed (only the .dmg step may fail on its own).
  must(existsSync(app), "macOS build (no .app)");
  // The .dmg step drives Finder (create-dmg): headless or denied, it fails while the
  // .app is fine. A plain compressed image of the .app is the fallback.
  let dmg = ok ? newest(join(BUNDLE, "dmg"), ".dmg") : undefined;
  const dmgOut = join(OUT, `inkledger_${version}_aarch64.dmg`);
  rmSync(dmgOut, { force: true });
  if (dmg) copyFileSync(dmg, dmgOut);
  else {
    console.log("! The .dmg step failed: building a plain one with hdiutil");
    must(run("hdiutil", ["create", "-volname", "inkledger", "-srcfolder", app, "-ov", "-format", "UDZO", dmgOut]), "hdiutil");
    dmg = dmgOut;
  }
  const zip = join(OUT, `inkledger_${version}_aarch64.app.zip`);
  rmSync(zip, { force: true });
  must(run("ditto", ["-c", "-k", "--keepParent", app, zip]), "zip of the .app");
  artifacts.push({ file: dmgOut, kind: "dmg" }, { file: zip, kind: "app.zip", unpacked: sizeOf(app) });
}

if (both || args.has("--android")) {
  const startedAt = Date.now();
  builds.android = timed(() => must(run("node", ["scripts/native-publish.mjs"]), "Android build"));
  const releaseDir = join(ROOT, "src-tauri/gen/android/app/build/outputs/apk");
  const apks = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".apk") && p.includes("/release/")) apks.push(p);
    }
  };
  walk(releaseDir);
  apks.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  must(apks[0], "Android build (no release APK)");
  must(statSync(apks[0]).mtimeMs >= startedAt, "Android build (the newest APK is from an earlier build)");
  const apk = join(OUT, `inkledger_${version}_arm64.apk`);
  copyFileSync(apks[0], apk);
  artifacts.push({ file: apk, kind: "apk" });
}

const entries = artifacts.map(({ file, kind, unpacked }) => {
  const body = readFileSync(file);
  return {
    file: file.slice(OUT.length + 1),
    kind,
    ...source,
    builtAt: new Date().toISOString(),
    size: body.length,
    ...(unpacked ? { unpacked } : {}),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
});
// Earlier entries of this version (another platform built before) are kept.
const manifestPath = join(OUT, "manifest.json");
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: [] };
const files = [...prior.files.filter((f) => !entries.some((e) => e.file === f.file)), ...entries];
// One commit for the whole release only when every file says so; otherwise each file's own stands alone.
const commits = new Set(files.map((f) => `${f.commit ?? "?"}${f.dirty ? "+dirty" : ""}`));
const commit = commits.size === 1 ? [...commits][0] : null;
writeFileSync(manifestPath, JSON.stringify({ version, commit, buildMs: { ...prior.buildMs, ...builds }, files }, null, 2));
if (commit === null) console.log(`! release/${version} holds builds of different commits: ${[...commits].join(", ")} (see each file in manifest.json)`);
writeFileSync(join(OUT, "SHA256SUMS"), files.map((f) => `${f.sha256}  ${f.file}`).join("\n") + "\n");

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`✓ release/${version}/`);
for (const f of entries) console.log(`  ${f.file} · ${mb(f.size)}${f.unpacked ? ` (installed ${mb(f.unpacked)})` : ""}`);
for (const [k, ms] of Object.entries(builds)) console.log(`  build ${k}: ${(ms / 1000).toFixed(0)} s`);
