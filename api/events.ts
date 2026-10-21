import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { restUser } from "./context";
import { subscribe, type UserEvent } from "./lib/userEvents";
import { isShuttingDown } from "./lib/shutdown";
import { serverBuild } from "./lib/appBuild";

/** A comment line now and then keeps proxies (and the browser) from closing an idle stream. */
export const KEEPALIVE_MS = 25_000;

/**
 * GET /api/events: the signed-in user's changes as server-sent events (a
 * timer started on another device, …), so open pages refresh at once. Only
 * names what changed; the data comes from the usual queries. First event:
 * `hello` with the server's build (a page from an older one reloads).
 */
export function registerEventRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get("/api/events", async (c) => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    if (isShuttingDown()) return c.json({ error: "Shutting down" }, 503);
    const userId = who.user.id;
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let done: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => (done = resolve));
      const queue: UserEvent[] = [];
      let wake: () => void = () => undefined;
      const unsubscribe = subscribe(
        userId,
        (e) => {
          queue.push(e);
          wake();
        },
        () => done(),
      );
      stream.onAbort(() => done());
      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ build: serverBuild() ?? null }) });
        while (!stream.aborted && !stream.closed) {
          // What arrived while writing goes out before waiting again.
          for (const e of queue.splice(0)) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          const next = await Promise.race([
            ended.then(() => "end" as const),
            new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), KEEPALIVE_MS).unref()),
            new Promise<"event">((resolve) => {
              wake = () => resolve("event");
              if (queue.length > 0) resolve("event");
            }),
          ]);
          if (next === "end") break;
          if (next === "tick") await stream.write(": keepalive\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  });
}
