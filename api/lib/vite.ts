import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

/**
 * Content-Security-Policy for the built app. Inline scripts of the shell (theme preload) are
 * allowed by hash, nothing else inline; styles may be inline (style attributes, the cached
 * theme CSS, the Picture-in-Picture window).
 */
export function contentSecurityPolicy(indexHtml: string): string {
  const hashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, code]) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // ipc: / ipc.localhost = the Tauri shell's bridge (native app, docs/native.md)
    "connect-src 'self' ipc: http://ipc.localhost",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");
  const indexHtml = fs.readFileSync(path.resolve(distPath, "index.html"), "utf-8");
  const csp = contentSecurityPolicy(indexHtml);
  app.use("*", async (c, next) => {
    await next();
    // Attachments set their own, stricter (sandbox) policy.
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", csp);
    }
  });

  // Hashed build assets never change: cache them for a year.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  // Each text file has .br and .gz beside it (scripts/precompress.mjs): sent by Accept-Encoding.
  app.use("*", serveStatic({ root: "./dist/public", precompressed: true }));

  // SPA fallback: always revalidate the shell so new deploys are picked up.
  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  });
}
