import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { DOWNLOADS_PATH, type DownloadsManifest } from "@contracts/downloads";
import { downloadsManifestSchema } from "@contracts/downloadsSchema";
import { env } from "./lib/env";

const EMPTY: DownloadsManifest = { android: null };

/**
 * The published app builds (manifest.json in the downloads folder), or none.
 * A missing or malformed manifest means nothing to download.
 */
export function readManifest(dir = env.downloadsDir): DownloadsManifest {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const parsed = downloadsManifestSchema.safeParse(raw);
    if (!parsed.success) return EMPTY;
    const android = parsed.data.android;
    // Listed but not there (half-published): not offered.
    if (android && !fs.existsSync(path.join(dir, android.file))) return EMPTY;
    return parsed.data;
  } catch {
    return EMPTY;
  }
}

/**
 * App downloads for new devices, without login: the server only answers on
 * its allowed hosts (the tailnet name, this machine), and an APK holds no
 * secret. Only files named in the manifest are served.
 */
export function registerDownloadRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get(`${DOWNLOADS_PATH}/manifest.json`, (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(readManifest());
  });
  app.get(`${DOWNLOADS_PATH}/:file`, (c) => {
    const android = readManifest().android;
    const file = c.req.param("file");
    if (!android || file !== android.file) return c.json({ error: "Not Found" }, 404);
    const body = fs.readFileSync(path.join(env.downloadsDir, android.file));
    return c.body(body, 200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": `attachment; filename="${android.file}"`,
      "Content-Length": String(body.length),
      "Cache-Control": "no-cache",
    });
  });
}
