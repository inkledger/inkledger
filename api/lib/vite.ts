import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";
import { renderSSR } from "../ssr";
import { contentSecurityPolicy } from "./csp";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(process.cwd(), "dist/public");
  const indexHtml = fs.readFileSync(path.resolve(distPath, "index.html"), "utf-8");
  const csp = contentSecurityPolicy(indexHtml);
  app.use("*", async (c, next) => {
    await next();
    // Attachments set their own, stricter (sandbox) policy.
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", csp);
    }
  });

  app.use("*", async (c, next) => {
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      const rendered = await renderSSR(c, indexHtml, contentSecurityPolicy);
      if (rendered) return rendered;
    }
    await next();
  });

  // Hashed build assets never change: cache them for a year.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  // Each text file has .br and .gz beside it (scripts/precompress.mjs): sent by Accept-Encoding.
  app.use("*", serveStatic({ root: "./dist/public", precompressed: true }));

  // Every route outside the SSR manifest keeps the SPA shell.
  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  });
}
