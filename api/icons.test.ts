import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS script, no types
import { ARMS, HEAD, HEAD_OPACITY } from "../scripts/icon-glyph.mjs";
import { BRAND_ARMS, BRAND_HEAD, BRAND_HEAD_OPACITY } from "../src/lib/brand";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// Every icon comes from scripts/icon-glyph.mjs via `pnpm icons`.
describe("icons", () => {
  it("the PWA declares maskable and monochrome icons that exist", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
      icons: { src: string; purpose?: string }[];
    };
    for (const purpose of ["maskable", "monochrome"]) {
      const icon = manifest.icons.find(i => i.purpose === purpose);
      expect(icon, purpose).toBeDefined();
      expect(existsSync(join(ROOT, "public", icon?.src ?? ""))).toBe(true);
    }
  });

  it("Android has a themed (monochrome) adaptive icon", () => {
    const res = "src-tauri/gen/android/app/src/main/res";
    expect(read(`${res}/mipmap-anydpi-v26/ic_launcher.xml`)).toContain("<monochrome");
    expect(existsSync(join(ROOT, res, "mipmap-xxxhdpi/ic_launcher_monochrome.png"))).toBe(true);
  });

  it("macOS 26 ships the compiled Icon Composer icon", () => {
    expect(existsSync(join(ROOT, "src-tauri/icons/Assets.car"))).toBe(true);
    expect(read("src-tauri/Info.plist")).toContain("<key>CFBundleIconName</key>");
    const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      bundle: { macOS?: { files?: Record<string, string> } };
    };
    expect(conf.bundle.macOS?.files?.["Resources/Assets.car"]).toBe("icons/Assets.car");
  });

  it("favicon and menu bar icon draw the same glyph", () => {
    for (const p of ["public/favicon.svg", "src-tauri/icons/tray.svg", "src-tauri/icons/source.svg"]) {
      expect(read(p), p).toContain(`d="${ARMS as string}"`);
    }
  });

  it("the app draws the same glyph as the OS icons", () => {
    expect([BRAND_HEAD, BRAND_ARMS, BRAND_HEAD_OPACITY]).toEqual([HEAD, ARMS, HEAD_OPACITY]);
  });
});
