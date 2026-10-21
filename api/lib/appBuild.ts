import fs from "node:fs";
import path from "node:path";
import { APP_BUILD_META } from "@contracts/appBuild";
import { env } from "./env";

let cached: string | null | undefined;

/**
 * This server's build: APP_BUILD when set (tests), else the one written in
 * the built page; none in development (the dev server rebuilds as it goes).
 */
export function serverBuild(): string | null {
  if (process.env.APP_BUILD) return process.env.APP_BUILD;
  if (cached !== undefined) return cached;
  cached = null;
  if (env.isProduction) {
    try {
      const html = fs.readFileSync(path.resolve(import.meta.dirname, "../dist/public/index.html"), "utf8");
      cached = new RegExp(`<meta name="${APP_BUILD_META}" content="([^"]+)"`).exec(html)?.[1] ?? null;
    } catch {
      // no built page (tests, a bare API): no check
    }
  }
  return cached;
}
