// Every icon from the one glyph (scripts/icon-glyph.mjs): the SVG sources,
// the PWA and tray PNGs (headless Chromium), then `tauri icon` for the native
// sets (Android themed icon included). Run `pnpm icons` after changing the
// glyph; the outputs are committed.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "./chromium.mjs";
import * as g from "./icon-glyph.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ICONS = join(ROOT, "src-tauri/icons");
const SRC = join(ICONS, "src");

const write = (path, text) => {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), text);
};

// 1. Vector sources.
write("public/favicon.svg", g.favicon());
write("docs/brand/logo-light.svg", g.logo(false));
write("docs/brand/logo-dark.svg", g.logo(true));
write("src-tauri/icons/source.svg", g.macSource());
write("src-tauri/icons/tray.svg", g.tray());
write("src-tauri/icons/src/android-fg.svg", g.androidForeground());
write("src-tauri/icons/src/android-mono.svg", g.monochrome(0.4));
write("src-tauri/icons/Icon.icon/Assets/head.svg", g.composerLayer("head"));
write("src-tauri/icons/Icon.icon/Assets/arms.svg", g.composerLayer("arms"));
// The clock's layers, before the octopus.
for (const old of ["ring.svg", "hand.svg"]) rmSync(join(ICONS, "Icon.icon/Assets", old), { force: true });

// Icon Composer (macOS 26): tile fill, head and arms as separate layers, so
// the dark, clear and tinted styles can restyle them (dark: paper on ink). actool reads it.
const c = ([r, g2, b], a = 1) => `srgb:${[r, g2, b, a].map(v => v.toFixed(5)).join(",")}`;
const ink = { solid: c(g.TILE_RGB) };
const paper = { solid: c(g.MARK_RGB) };
const layerFill = { fill: ink, "fill-specializations": [{ value: ink }, { appearance: "dark", value: paper }] };
write(
  "src-tauri/icons/Icon.icon/icon.json",
  JSON.stringify(
    {
      fill: paper,
      "fill-specializations": [{ value: paper }, { appearance: "dark", value: ink }],
      groups: [
        {
          layers: [
            { name: "arms", "image-name": "arms.svg", ...layerFill },
            { name: "head", "image-name": "head.svg", ...layerFill, opacity: g.HEAD_OPACITY },
          ],
          shadow: { kind: "neutral", opacity: 0.5 },
          translucency: { enabled: true, value: 0.4 },
        },
      ],
      "supported-platforms": { squares: ["macOS"] },
    },
    null,
    2
  ) + "\n"
);

// Compiled here, not by the bundler: the .app ships icons/Assets.car as is
// (CFBundleIconName in src-tauri/Info.plist), so builds need no Xcode 26.
{
  const tmp = mkdtempSync(join(tmpdir(), "ikl-icon-"));
  try {
    cpSync(join(ICONS, "Icon.icon"), join(tmp, "Icon.icon"), { recursive: true });
    mkdirSync(join(tmp, "out"));
    execFileSync("xcrun", [
      "actool", join(tmp, "Icon.icon"), "--compile", join(tmp, "out"),
      "--output-format", "human-readable-text", "--warnings", "--errors",
      "--output-partial-info-plist", join(tmp, "out/partial.plist"),
      "--app-icon", "Icon", "--include-all-app-icons",
      "--platform", "macosx", "--target-device", "mac", "--minimum-deployment-target", "11.0",
    ], { stdio: "inherit" });
    cpSync(join(tmp, "out/Assets.car"), join(ICONS, "Assets.car"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 2. Rasters: [svg, size, corner radius %, out].
const rasters = [
  [g.tile(0.634), 192, 22, "public/icon-192.png"],
  [g.tile(0.634), 512, 22, "public/icon-512.png"],
  [g.tile(0.504), 512, 0, "public/icon-maskable-512.png"],
  [g.monochrome(0.504), 512, 0, "public/icon-monochrome-512.png"],
  [g.tile(0.634), 180, 0, "public/apple-touch-icon.png"],
  [g.macSource(), 1024, 0, "src-tauri/icons/source.png"],
  [g.tray(), 44, 0, "src-tauri/icons/tray.png"],
  [g.androidForeground(), 1024, 0, "src-tauri/icons/src/android-fg.png"],
  [g.monochrome(0.4), 1024, 0, "src-tauri/icons/src/android-mono.png"],
];
const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  const page = await browser.newPage();
  for (const [svg, size, radius, out] of rasters) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;border-radius:${radius}%;overflow:hidden">${svg.replace(/^<!--.*-->\n/, "").replace("<svg ", '<svg style="display:block;width:100%;height:100%" ')}</div></body></html>`
    );
    mkdirSync(dirname(join(ROOT, out)), { recursive: true });
    await page.screenshot({ path: join(ROOT, out), omitBackground: true });
  }
} finally {
  await browser.close();
}

// 3. Native sets. The adaptive foreground already sits in the safe zone.
writeFileSync(
  join(SRC, "manifest.json"),
  JSON.stringify(
    {
      default: "../source.png",
      bg_color: g.MARK_HEX,
      android_fg: "android-fg.png",
      android_fg_scale: 100,
      android_monochrome: "android-mono.png",
    },
    null,
    2
  ) + "\n"
);
execFileSync("pnpm", ["tauri", "icon", join(SRC, "manifest.json")], { cwd: ROOT, stdio: "inherit" });
// Leftovers of the Android Studio template, replaced by the adaptive icon.
for (const f of ["drawable/ic_launcher_background.xml", "drawable-v24/ic_launcher_foreground.xml"]) {
  rmSync(join(ROOT, "src-tauri/gen/android/app/src/main/res", f), { force: true });
}
console.log("icons written");
