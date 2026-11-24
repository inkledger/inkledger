// /api/ready and /api/metrics: what they answer, to whom, in which format; and the
// global rate limits (one account's flood refused and counted, nobody else's).
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";

process.env.DATABASE_URL = ":memory:";

const TOKEN = "s3cret-metrics-token";

// The first import pulls the server's modules in (slow on a loaded runner).
describe("readiness", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("ok with the database up and migrated; features off are skipped, not failed", async () => {
    const { readiness } = await import("./ready");
    const r = await readiness({ backupOn: false, heartbeat: null, free: () => null });
    expect(r.status).toBe("ok");
    expect(r.checks.database.status).toBe("ok");
    expect(r.checks.migrations.status).toBe("ok");
    expect(r.checks.backup.status).toBe("skipped");
    expect(r.checks.scheduler.status).toBe("skipped");
  });

  it("fails on a full disk, a stale scheduler, or a backup older than its schedule allows", async () => {
    const { readiness } = await import("./ready");
    const { setServerSetting } = await import("../lib/serverSettings");
    const now = Date.now();
    await setServerSetting("backup", { schedule: "daily" });
    await setServerSetting("backup.state", { lastOkAt: now - 3 * 86_400_000, lastError: null, lastErrorAt: null });
    const r = await readiness({ now, backupOn: true, uptimeSec: 10 * 86_400, heartbeat: { at: now - 3 * 3600_000, minutes: 5, running: false }, free: () => 100 });
    expect(r.status).toBe("failed");
    expect(r.checks.disk).toMatchObject({ status: "failed", freeMb: 100 });
    expect(r.checks.scheduler.status).toBe("failed");
    expect(r.checks.backup).toMatchObject({ status: "failed", ageSeconds: 3 * 86_400 });
    // Fresh enough: ok again.
    await setServerSetting("backup.state", { lastOkAt: now - 3600_000, lastError: null, lastErrorAt: null });
    const fine = await readiness({ now, backupOn: true, heartbeat: { at: now - 60_000, minutes: 5, running: true }, free: () => 50_000 });
    expect(fine.status).toBe("ok");
    expect(fine.checks.backup.status).toBe("ok");
  });

  it("a new server with no backup yet is ready until one period has passed", async () => {
    const { readiness } = await import("./ready");
    const { setServerSetting } = await import("../lib/serverSettings");
    await setServerSetting("backup.state", { lastOkAt: null, lastError: null, lastErrorAt: null });
    expect((await readiness({ backupOn: true, uptimeSec: 60, heartbeat: null, free: () => 50_000 })).checks.backup.status).toBe("ok");
    expect((await readiness({ backupOn: true, uptimeSec: 3 * 86_400, heartbeat: null, free: () => 50_000 })).checks.backup.status).toBe("failed");
  });
});

describe("routes", { timeout: 60_000 }, () => {
  let app: Hono<{ Bindings: HttpBindings }>;
  let off: Hono<{ Bindings: HttpBindings }>;

  beforeAll(async () => {
    await (await import("../queries/connection")).initDb();
    const { registerOpsRoutes } = await import("./routes");
    app = new Hono<{ Bindings: HttpBindings }>();
    registerOpsRoutes(app, { token: TOKEN });
    app.get("/api/things/:id", (c) => c.json({ id: c.req.param("id") }));
    off = new Hono<{ Bindings: HttpBindings }>();
    registerOpsRoutes(off, { token: "" });
  });

  it("/api/ready answers JSON with the status code of its checks", async () => {
    const res = await app.request("/api/ready");
    const body = (await res.json()) as { status: string; checks: Record<string, { status: string }> };
    expect([200, 503]).toContain(res.status);
    expect(res.status === 200).toBe(body.status === "ok");
    expect(Object.keys(body.checks).sort()).toEqual(["backup", "database", "disk", "migrations", "scheduler"]);
  });

  it("/api/metrics is off (404) without METRICS_TOKEN, 401 without or with a wrong token", async () => {
    expect((await off.request("/api/metrics", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    const none = await app.request("/api/metrics");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await app.request("/api/metrics", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request("/api/metrics", { headers: { authorization: TOKEN } })).status).toBe(401);
  });

  it("with the token: Prometheus text, request counts by route template (never the path)", async () => {
    await app.request("/api/things/secret-token-123");
    const res = await app.request("/api/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    for (const name of [
      "inkledger_http_requests_total",
      "inkledger_http_request_duration_seconds_bucket",
      "inkledger_connections",
      "inkledger_outbox_depth",
      "inkledger_backup_last_success_timestamp_seconds",
      "inkledger_sse_streams",
      "inkledger_sync_passes_total",
      "inkledger_login_failures_total",
      "inkledger_rate_limited_total",
    ]) {
      expect(text).toContain(`# TYPE ${name.replace(/_bucket$/, "")}`);
    }
    expect(text).toMatch(/inkledger_http_requests_total\{[^}]*route="\/api\/things\/:id"[^}]*status="200"/);
    expect(text).not.toContain("secret-token-123");
  });

  it("tRPC calls are labelled by procedure only when the server has it", async () => {
    const { routeLabel } = await import("./routes");
    const known = new Set(["timers.list"]);
    const label = async (path: string) => {
      let out = "";
      const probe = new Hono();
      probe.use("/api/trpc/*", (c) => {
        out = routeLabel(c, known);
        return Promise.resolve(c.text(""));
      });
      await probe.request(path);
      return out;
    };
    expect(await label("/api/trpc/timers.list")).toBe("/api/trpc/timers.list");
    expect(await label("/api/trpc/timers.list,timers.list")).toBe("/api/trpc/batch");
    expect(await label("/api/trpc/made.up%2Fthing")).toBe("/api/trpc/unknown");
  });
});

describe("rate limits", () => {
  const limits = { enabled: true, windowMs: 60_000, perUser: 3, perIp: 5, sso: 2, scim: 2, export: 1 };

  const ctx = (userId: number | null, remoteAddress?: string) => ({ user: userId === null ? null : { id: userId }, req: new Request("http://localhost/api/trpc/x"), remoteAddress, resHeaders: new Headers() });

  async function refusedCount(limiter: string): Promise<number> {
    const { metrics } = await import("./metrics");
    const m = await metrics().rateLimited.get();
    return m.values.find((v) => v.labels.limiter === limiter)?.value ?? 0;
  }

  it("past the per-account limit: TOO_MANY_REQUESTS with Retry-After, counted; another account goes on", async () => {
    const { guardCall, makeLimiters } = await import("./rateLimits");
    const set = makeLimiters(limits);
    const before = await refusedCount("trpc_user");
    for (let i = 0; i < 3; i++) guardCall(ctx(1), { set });
    const c = ctx(1);
    expect(() => guardCall(c, { set })).toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }) as Error);
    expect(Number(c.resHeaders.get("retry-after"))).toBeGreaterThan(0);
    expect(await refusedCount("trpc_user")).toBe(before + 1);
    expect(() => guardCall(ctx(2), { set })).not.toThrow();
  });

  it("per address, across accounts; a call with no address is never pooled with others", async () => {
    const { guardCall, makeLimiters } = await import("./rateLimits");
    const set = makeLimiters(limits);
    for (let i = 0; i < 5; i++) guardCall(ctx(100 + i, "198.51.100.7"), { set });
    expect(() => guardCall(ctx(200, "198.51.100.7"), { set })).toThrow();
    expect(() => guardCall(ctx(201, "198.51.100.8"), { set })).not.toThrow();
    // No socket (tests, app.request): many anonymous calls pass.
    for (let i = 0; i < 20; i++) guardCall(ctx(null), { set });
  });

  it("off with RATE_LIMIT=off", async () => {
    const { guardCall, makeLimiters } = await import("./rateLimits");
    const set = makeLimiters({ ...limits, perUser: 1 });
    for (let i = 0; i < 10; i++) guardCall(ctx(9), { set, enabled: false });
  });

  it("a REST route's limiter answers 429 with Retry-After, counted", async () => {
    const { limitRoute } = await import("./rateLimits");
    const { createRateLimiter } = await import("../lib/security");
    const limiter = createRateLimiter(2, 60_000, { name: "sso" });
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.use("/api/sso/*", limitRoute(() => limiter, () => "same"));
    app.get("/api/sso/:id/start", (c) => c.text("ok"));
    const before = await refusedCount("sso");
    expect((await app.request("/api/sso/1/start")).status).toBe(200);
    expect((await app.request("/api/sso/1/start")).status).toBe(200);
    const third = await app.request("/api/sso/1/start");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    expect(await refusedCount("sso")).toBe(before + 1);
  });

  it("sign-ins refused are counted by reason", async () => {
    const { noteSignIn } = await import("./rateLimits");
    const { metrics } = await import("./metrics");
    const read = async (reason: string) => (await metrics().loginFailures.get()).values.find((v) => v.labels.reason === reason)?.value ?? 0;
    const [r0, t0] = [await read("refused"), await read("throttled")];
    noteSignIn("auth.login", "UNAUTHORIZED");
    noteSignIn("auth.login", "TOO_MANY_REQUESTS");
    noteSignIn("timers.list", "UNAUTHORIZED");
    expect([await read("refused"), await read("throttled")]).toEqual([r0 + 1, t0 + 1]);
  });
});

describe("tracing (OTLP)", () => {
  it("refuses an endpoint on this server's neighbours or metadata, accepts a collector on the network", async () => {
    const { startTracing } = await import("./otel");
    expect(await startTracing("http://169.254.169.254:4318")).toBe(false);
    expect(await startTracing("http://localhost:4318")).toBe(false);
    expect(await startTracing("http://otel-collector.internal:4318", async () => ["10.0.0.9"])).toBe(true);
  });

  it("spans carry the route template and status, and continue a caller's trace", async () => {
    const { makeSpan, otlpBody, tracesUrl, parseOtlpHeaders } = await import("./otel");
    const s = makeSpan({ method: "GET", route: "/api/things/:id", status: 503, startMs: 1000, endMs: 1250, traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    expect(s).toMatchObject({ traceId: "0af7651916cd43dd8448eb211c80319c", parentSpanId: "b7ad6b7169203331", name: "GET /api/things/:id", startTimeUnixNano: "1000000000", endTimeUnixNano: "1250000000", status: { code: 2 } });
    const body = JSON.parse(otlpBody([s], "svc")) as { resourceSpans: { resource: unknown; scopeSpans: { spans: unknown[] }[] }[] };
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(tracesUrl("http://c:4318/")).toBe("http://c:4318/v1/traces");
    expect(parseOtlpHeaders("api-key=abc,x-tenant=t%201")).toEqual({ "api-key": "abc", "x-tenant": "t 1" });
  });
});
