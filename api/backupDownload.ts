// GET /api/backups/:name: a backup's dump, for whoever may take one off the server
// (downloadBackups). Running backups doesn't give it: a dump holds everyone's data. Anyone
// with access to the server's disk or its backup folder reads the dumps anyway; this only
// keeps the app from handing them out (docs/self-hosting.md). The download is an audit event.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { restUser } from "./context";
import { backupDir, listBackups } from "./backup";
import { record } from "./lib/audit";

export const BACKUPS_PATH = "/api/backups";

export function registerBackupRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get(`${BACKUPS_PATH}/:name`, async (c) => {
    const who = await restUser(c.req.raw, "downloadBackups");
    if ("status" in who) return c.json({ error: who.error }, who.status);
    const name = c.req.param("name");
    // Only a backup the folder lists, by its exact name: never a path.
    const found = listBackups().find((b) => b.name === name);
    if (!found) return c.json({ error: "Not found" }, 404);
    await record({ req: c.req.raw, remoteAddress: c.env?.incoming?.socket?.remoteAddress, user: who.user }, "backup.download", { target: { type: "backup", id: found.name }, after: { name: found.name, size: found.size } });
    const stream = Readable.toWeb(fs.createReadStream(path.join(backupDir(), found.name))) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(found.size),
        "content-disposition": `attachment; filename="${found.name}"`,
        "cache-control": "no-store",
      },
    });
  });
}
