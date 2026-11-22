import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { MODULES_PATH, MODULES_RUN_PATH } from "@contracts/modules";
import { restUser } from "../context";
import { can, mayRunModule, userById } from "../queries/accounts";
import { extraKey } from "./keys";
import { installBundle, moduleFile } from "./registry";
import { runTokenUser } from "./runToken";

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
    // Only the modules granted to this account (an admin runs them all).
    if (!mayRunModule(who.user, id)) return c.json({ error: "Not allowed" }, 403);
    let file: string;
    try {
      file = decodeURIComponent(c.req.path.slice(`${MODULES_PATH}/${id}/${hash}/`.length));
    } catch {
      return c.json({ error: "Not Found" }, 404);
    }
    const body = await moduleFile(id, hash, file, "inpage");
    if (!body) return c.json({ error: "Not Found" }, 404);
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  });

  // Framed modules' code: the opaque frame sends no cookie (nor may it read
  // anything with one), the token says who asked. Every refusal looks the same.
  app.get(`${MODULES_RUN_PATH}/:token/:id/:hash/*`, async (c) => {
    const notFound = () => c.text("Not Found", 404);
    const { token, id, hash } = c.req.param();
    const userId = runTokenUser(token, id, hash);
    if (userId === null) return notFound();
    // Held to what the cookie route holds the account to, now: a revoked grant doesn't last the hour.
    const user = await userById(userId);
    if (!user || user.disabledAt || user.mustChangePassword || !can(user, "useModules") || !mayRunModule(user, id)) return notFound();
    let file: string;
    try {
      file = decodeURIComponent(c.req.path.slice(`${MODULES_RUN_PATH}/${token}/${id}/${hash}/`.length));
    } catch {
      return notFound();
    }
    const body = await moduleFile(id, hash, file, "frame");
    if (!body) return notFound();
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      // Read by an opaque origin, never with credentials.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "private, max-age=3600",
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
