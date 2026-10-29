// A headless Chromium for scripts and e2e: $CHROMIUM, Playwright's own, else
// the newest headless shell in its cache (macOS or Linux).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  // Playwright's caches: macOS, Linux (CI installs only the headless shell there), or the one set.
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")].filter(Boolean);
  const binaries = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-linux/headless_shell",
  ];
  for (const cache of caches) {
    const dirs = existsSync(cache)
      ? readdirSync(cache).filter(d => d.startsWith("chromium_headless_shell-")).sort().reverse()
      : [];
    for (const d of dirs)
      for (const b of binaries) {
        const p = join(cache, d, b);
        if (existsSync(p)) return p;
      }
  }
  throw new Error("No Chromium: run `pnpm exec playwright-core install chromium-headless-shell` or set CHROMIUM");
}
