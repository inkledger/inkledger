// A headless Chromium for scripts and e2e: $CHROMIUM, Playwright's own, else
// any in its cache.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

export function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = existsSync(cache)
    ? readdirSync(cache).filter(d => d.startsWith("chromium_headless_shell-")).sort().reverse()
    : [];
  for (const d of dirs) {
    const p = join(cache, d, "chrome-headless-shell-mac-arm64/chrome-headless-shell");
    if (existsSync(p)) return p;
  }
  throw new Error("No Chromium: run `pnpm exec playwright-core install chromium-headless-shell` or set CHROMIUM");
}
