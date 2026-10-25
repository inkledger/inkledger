#!/usr/bin/env node
// Builds the Android app and publishes it on this machine's inkledger server, so
// new phones download it from /install over Tailscale (docs/native.md).
//
//   pnpm native:publish            build + publish to the Docker container
//   pnpm native:publish --dev      also to ./data/downloads (pnpm dev server)
//   pnpm native:publish --no-build publish the last built APK
//
// Release build (optimized, small) signed with the debug key: installs and
// updates fine from a link; a store release key comes with phase 4.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CONTAINER = process.env.INKLEDGER_CONTAINER ?? "inkledger";
const args = new Set(process.argv.slice(2));

/** JDK 17–21 (the Android Gradle plugin rejects newer ones). */
function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  for (const v of ["21", "17"]) {
    try {
      return execFileSync("/usr/libexec/java_home", ["-v", v], { encoding: "utf8" }).trim();
    } catch {
      // not installed
    }
  }
  throw new Error("A JDK 17 or 21 is required (e.g. brew install openjdk@21), or set JAVA_HOME");
}

function androidEnv() {
  const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
  const ndkDir = join(sdk, "ndk");
  const ndk =
    process.env.NDK_HOME ??
    (existsSync(ndkDir) ? join(ndkDir, readdirSync(ndkDir).sort().reverse()[0]) : undefined);
  if (!existsSync(sdk) || !ndk) throw new Error(`Android SDK/NDK not found in ${sdk}`);
  return { ...process.env, JAVA_HOME: javaHome(), ANDROID_HOME: sdk, NDK_HOME: ndk };
}

/** The newest APK Gradle produced. */
function latestApk() {
  const out = join(ROOT, "src-tauri/gen/android/app/build/outputs/apk");
  const found = [];
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".apk")) found.push(p);
    }
  };
  if (existsSync(out)) walk(out);
  // Release only: a stray 180 MB debug build must never be published.
  found.splice(0, found.length, ...found.filter(p => p.includes("/release/")));
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!found[0]) throw new Error("No APK found: run without --no-build");
  return found[0];
}

const run = (cmd, argv, env) => {
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!args.has("--no-build")) {
  console.log("› Build Android (release, arm64)…");
  run("pnpm", ["tauri", "android", "build", "--apk", "--target", "aarch64"], androidEnv());
}

const apk = latestApk();
const body = readFileSync(apk);
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version; // one version for the server and the apps (tauri.conf.json reads it too)
const manifest = {
  android: {
    version,
    file: "inkledger.apk",
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    builtAt: Math.round(statSync(apk).mtimeMs),
  },
};

// Staged together, so the manifest never names a file that isn't there.
const stage = mkdtempSync(join(tmpdir(), "ikl-publish-"));
copyFileSync(apk, join(stage, "inkledger.apk"));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

const running = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" });
if (running.stdout?.trim() === "true") {
  run("docker", ["exec", CONTAINER, "mkdir", "-p", "/app/data/downloads"]);
  run("docker", ["cp", join(stage, "inkledger.apk"), `${CONTAINER}:/app/data/downloads/inkledger.apk`]);
  run("docker", ["cp", join(stage, "manifest.json"), `${CONTAINER}:/app/data/downloads/manifest.json`]);
  console.log(`✓ Published to container ${CONTAINER}`);
} else {
  console.log(`· Container ${CONTAINER} not running: skipped`);
}
if (args.has("--dev")) {
  const dev = join(ROOT, "data/downloads");
  mkdirSync(dev, { recursive: true });
  copyFileSync(join(stage, "inkledger.apk"), join(dev, "inkledger.apk"));
  copyFileSync(join(stage, "manifest.json"), join(dev, "manifest.json"));
  console.log("✓ Published for the dev server (data/downloads)");
}
console.log(`  Android ${version} · ${(body.length / 1024 / 1024).toFixed(1)} MB · sha256 ${manifest.android.sha256.slice(0, 12)}…`);
