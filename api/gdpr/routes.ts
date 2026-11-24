// GET /api/users/:id/export: a person's data as a ZIP (users.exportData), streamed as it is
// read. Anyone may take their own (Settings > Account); someone else's takes exportUserData.
// Every export is an audit event, recorded as it starts (a download cancelled halfway was
// still an export).
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { users } from "@db/schema";
import { dayKey } from "@contracts/time";
import { restUser } from "../context";
import { holds } from "../queries/accounts";
import { getDb } from "../queries/connection";
import { record } from "../lib/audit";
import { zipStream } from "../lib/zip";
import { exportEntries } from "./exportData";

export function registerUserDataRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get("/api/users/:id/export", async (c) => {
    const who = await restUser(c.req.raw);
    if ("status" in who) return c.json({ error: who.error }, who.status);
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "Bad Request" }, 400);
    const self = id === who.user.id;
    const ctx = { req: c.req.raw, remoteAddress: c.env?.incoming?.socket?.remoteAddress, user: who.user };
    if (!self && !holds(who.user, "exportUserData")) {
      await record(ctx, "users.exportData", { outcome: "denied", target: { type: "user", id, ownerUserId: id } });
      return c.json({ error: "Not allowed" }, 403);
    }
    const [target] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!target) return c.json({ error: "Not Found" }, 404);
    await record(ctx, "users.exportData", { target: { type: "user", id, ownerUserId: id }, after: { self } });
    const name = `inkledger-user-${id}-${dayKey(new Date())}.zip`;
    return new Response(zipStream(exportEntries(id)), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  });
}
