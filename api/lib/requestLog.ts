// The production request log: method, path, status and time, never what a URL
// carries beside the route (tRPC inputs in the query, a webhook's token in its path).
import type { MiddlewareHandler } from "hono";

/** A URL as the log may show it: its path, without the query, a webhook's token hidden. */
export function loggedPath(url: string): string {
  return new URL(url).pathname.replace(/^(\/api\/hooks\/[^/]+)\/[^/]+/, "$1/…");
}

/** hono/logger's lines, with loggedPath. */
export const requestLog =
  (print: (line: string) => void = console.log): MiddlewareHandler =>
  async (c, next) => {
    const path = loggedPath(c.req.url);
    print(`<-- ${c.req.method} ${path}`);
    const start = Date.now();
    await next();
    print(`--> ${c.req.method} ${path} ${c.res.status} ${Date.now() - start}ms`);
  };
