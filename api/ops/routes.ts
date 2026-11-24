// The operations routes and their middleware: GET /api/ready, GET /api/metrics
// (Bearer METRICS_TOKEN, else 404), request metrics and optional tracing for
// every request, and the limits for single sign-on and SCIM routes.
import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { routePath } from "hono/route";
import { count, isNull, sql } from "drizzle-orm";
import { connections, outbox } from "@db/schema";
import { getDb, poolStats } from "../queries/connection";
import { getBackupState } from "../backup";
import { streamCount } from "../lib/userEvents";
import { sameSecretHashed } from "../providers/core/webhooks";
import { env } from "../lib/env";
import { appRouter } from "../router";
import { observeHttp, renderMetrics, setGauges } from "./metrics";
import { readiness } from "./ready";
import { opsConfig } from "./config";
import { addressOf, bearerKey, limiters, limitRoute } from "./rateLimits";
import { startTracing, traceRequest } from "./otel";
import { certificateCheck } from "./alerts";

type App = Hono<{ Bindings: HttpBindings }>;

const PROCEDURES = new Set(Object.keys(appRouter._def.procedures));

/**
 * A request's route as a metric label: the template that answered it (never the
 * path, which may carry a token); for tRPC, the procedure when it is one this
 * server has, "batch" for several, "unknown" otherwise.
 */
export function routeLabel(c: Context, procedures: ReadonlySet<string> = PROCEDURES): string {
  const route = routePath(c) || "unmatched";
  if (route !== "/api/trpc/*") return route;
  let names: string[];
  try {
    names = decodeURIComponent(c.req.path.slice("/api/trpc/".length)).split(",");
  } catch {
    return "/api/trpc/unknown";
  }
  if (names.length > 1) return "/api/trpc/batch";
  return procedures.has(names[0]) ? `/api/trpc/${names[0]}` : "/api/trpc/unknown";
}

/** The token Prometheus sends: true only for "Bearer <METRICS_TOKEN>" (compared in constant time). */
export function metricsAllowed(header: string | undefined, token: string): boolean {
  if (!token) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m !== null && sameSecretHashed(m[1].trim(), token);
}

export function registerOpsRoutes(app: App, o: { token?: string } = {}): void {
  const token = o.token ?? opsConfig.metricsToken;
  // Every request, timed: its route template and status (and a span, when tracing is on).
  app.use(async (c, next) => {
    const start = performance.now();
    const startMs = Date.now();
    await next();
    const route = routeLabel(c);
    observeHttp(c.req.method, route, c.res.status, (performance.now() - start) / 1000);
    traceRequest({ method: c.req.method, route, status: c.res.status, startMs, endMs: Date.now(), traceparent: c.req.header("traceparent") });
  });

  app.get("/api/ready", async (c) => {
    const r = await readiness();
    c.header("Cache-Control", "no-store");
    return c.json(r, r.status === "ok" ? 200 : 503);
  });

  app.get("/api/metrics", async (c) => {
    // Off unless the operator gave it a token: nothing says it exists.
    if (!token) return c.json({ error: "Not Found" }, 404);
    if (!metricsAllowed(c.req.header("authorization"), token)) {
      c.header("WWW-Authenticate", 'Bearer realm="metrics"');
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { body, contentType } = await renderMetrics();
    c.header("Cache-Control", "no-store");
    return c.body(body, 200, { "Content-Type": contentType });
  });

  // Single sign-on and SCIM: limited before they exist, so they never come unlimited.
  app.use("/api/sso/*", limitRoute(() => limiters().sso, addressOf));
  app.use("/scim/*", limitRoute(() => limiters().scim, (c) => bearerKey(c) ?? addressOf(c)));

  setGauges({
    pool: poolStats,
    connections: async () =>
      (
        await getDb()
          .select({ type: connections.type, status: connections.status, count: count() })
          .from(connections)
          .where(isNull(connections.archivedAt))
          .groupBy(connections.type, connections.status)
      ).map((r) => ({ type: r.type, status: r.status, count: Number(r.count) })),
    outbox: async () => Number((await getDb().select({ n: sql<number>`count(*)` }).from(outbox))[0]?.n ?? 0),
    backupLastOk: async () => (await getBackupState()).lastOkAt,
    streams: streamCount,
  });

  if (opsConfig.otelEndpoint) void startTracing();
  // The certificate's end, said at start (then after sync passes, at most daily).
  if (env.isProduction && env.tlsDir) void certificateCheck().catch(() => undefined);
}
