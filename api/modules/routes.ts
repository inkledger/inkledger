import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { MODULES_PATH } from "@contracts/modules";
import { restUser } from "../context";
import { extraKey } from "./keys";
import { installBundle, moduleFile } from "./registry";

/** Module code and uploads: signed-in users only. */
export function registerModuleRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  if (extraKey()) {
    console.warn("[modules] MODULES_TRUST_EXTRA_KEY is set: modules signed with that key load here (development/tests only)");
  }

  // Content-addressed: the URL changes with the package, so it caches forever.
  app.get(`${MODULES_PATH}/:id/:hash/*`, async (c) => {
    const who = await restUser(c.req.raw, "useModules");
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const { id, hash } = c.req.param();
    const file = decodeURIComponent(c.req.path.slice(`${MODULES_PATH}/${id}/${hash}/`.length));
    const body = await moduleFile(id, hash, file);
    if (!body) return c.json({ error: "Not Found" }, 404);
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  });

  // A .iklmod from Settings → Extras: verified before anything is written.
  app.post(`${MODULES_PATH}/upload`, async (c) => {
    // Modules are the server's: installing one is the store's business.
    const who = await restUser(c.req.raw, "manageStore");
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    const result = installBundle(await c.req.text(), { allowDowngrade: c.req.query("force") === "1" });
    return result.ok ? c.json(result) : c.json(result, 400);
  });
}
