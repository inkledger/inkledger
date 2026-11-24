// Prometheus metrics (GET /api/metrics, off unless METRICS_TOKEN is set). Pull only:
// nothing leaves the server. Labels stay bounded: a route template, never a raw
// path (webhook and share-link tokens live in paths); a provider type, never a URL.
import { Counter, Gauge, Histogram, Registry as PromRegistry, collectDefaultMetrics } from "prom-client";

type Registry = {
  registry: PromRegistry;
  http: Counter<"method" | "route" | "status">;
  latency: Histogram<"method" | "route">;
  syncPasses: Counter<"provider" | "stream">;
  syncFailures: Counter<"provider" | "stream" | "kind">;
  loginFailures: Counter<"reason">;
  rateLimited: Counter<"limiter">;
  alerts: Counter<"kind">;
  webhookFailures: Counter;
};

/** Gauges read when Prometheus scrapes (the database, the backup state, open streams). */
export type Gauges = {
  pool: () => { total: number; idle: number; waiting: number } | null;
  connections: () => Promise<{ type: string; status: string; count: number }[]>;
  outbox: () => Promise<number>;
  backupLastOk: () => Promise<number | null>;
  streams: () => number;
};

// One registry per process: the dev server evaluates modules again on each change.
const g = globalThis as { __iklMetrics?: Registry; __iklGauges?: Gauges };

function build(): Registry {
  const registry = new PromRegistry();
  registry.setDefaultLabels({ app: "inkledger" });
  collectDefaultMetrics({ register: registry, prefix: "inkledger_" });
  return {
    registry,
    http: new Counter({ name: "inkledger_http_requests_total", help: "HTTP requests by route template and status", labelNames: ["method", "route", "status"], registers: [registry] }),
    latency: new Histogram({
      name: "inkledger_http_request_duration_seconds",
      help: "HTTP request latency by route template",
      labelNames: ["method", "route"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    syncPasses: new Counter({ name: "inkledger_sync_passes_total", help: "Sync passes that went through, by provider type and stream", labelNames: ["provider", "stream"], registers: [registry] }),
    syncFailures: new Counter({ name: "inkledger_sync_failures_total", help: "Sync passes that failed, by provider type, stream and kind", labelNames: ["provider", "stream", "kind"], registers: [registry] }),
    loginFailures: new Counter({ name: "inkledger_login_failures_total", help: "Refused sign-ins (wrong password, too many attempts)", labelNames: ["reason"], registers: [registry] }),
    rateLimited: new Counter({ name: "inkledger_rate_limited_total", help: "Requests refused by a rate limit (429), by limiter", labelNames: ["limiter"], registers: [registry] }),
    alerts: new Counter({ name: "inkledger_alerts_total", help: "Alerts raised (after deduplication), by kind", labelNames: ["kind"], registers: [registry] }),
    webhookFailures: new Counter({ name: "inkledger_alert_webhook_failures_total", help: "Alert webhook deliveries that failed", registers: [registry] }),
  };
}

export const metrics = (): Registry => (g.__iklMetrics ??= withGauges(build()));

/** The scrape-time readers; set once by the server (tests set their own). */
export function setGauges(gauges: Gauges): void {
  g.__iklGauges = gauges;
}

function withGauges(r: Registry): Registry {
  const reg = [r.registry];
  const gauges = () => g.__iklGauges;
  new Gauge({
    name: "inkledger_db_pool_connections",
    help: "Database pool connections by state",
    labelNames: ["state"],
    registers: reg,
    collect() {
      const p = gauges()?.pool();
      if (!p) return;
      this.set({ state: "total" }, p.total);
      this.set({ state: "idle" }, p.idle);
      this.set({ state: "waiting" }, p.waiting);
    },
  });
  new Gauge({
    name: "inkledger_connections",
    help: "Tracker connections (not archived) by provider type and status",
    labelNames: ["provider", "status"],
    registers: reg,
    async collect() {
      const read = gauges()?.connections;
      if (!read) return;
      this.reset();
      for (const row of await read().catch(() => [])) this.set({ provider: row.type, status: row.status }, row.count);
    },
  });
  new Gauge({
    name: "inkledger_outbox_depth",
    help: "Time changes queued for trackers out of reach",
    registers: reg,
    async collect() {
      const read = gauges()?.outbox;
      if (read) this.set(await read().catch(() => 0));
    },
  });
  new Gauge({
    name: "inkledger_backup_last_success_timestamp_seconds",
    help: "When the last backup succeeded (Unix time; 0 when none yet)",
    registers: reg,
    async collect() {
      const read = gauges()?.backupLastOk;
      if (read) this.set(((await read().catch(() => null)) ?? 0) / 1000);
    },
  });
  new Gauge({
    name: "inkledger_sse_streams",
    help: "Open live-event streams (server-sent events)",
    registers: reg,
    collect() {
      const read = gauges()?.streams;
      if (read) this.set(read());
    },
  });
  return r;
}

/** Prometheus' text exposition of every metric. */
export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  const r = metrics();
  return { body: await r.registry.metrics(), contentType: r.registry.contentType };
}

export function observeHttp(method: string, route: string, status: number, seconds: number): void {
  const m = metrics();
  m.http.inc({ method, route, status: String(status) });
  m.latency.observe({ method, route }, seconds);
}

export const noteSyncPass = (provider: string, stream: string): void => metrics().syncPasses.inc({ provider, stream });
export const noteSyncFailure = (provider: string, stream: string, kind: string): void => metrics().syncFailures.inc({ provider, stream, kind });
export const noteLoginFailure = (reason: "refused" | "throttled"): void => metrics().loginFailures.inc({ reason });
export const noteRateLimited = (limiter: string): void => metrics().rateLimited.inc({ limiter });
export const noteAlert = (kind: string): void => metrics().alerts.inc({ kind });
export const noteWebhookFailure = (): void => metrics().webhookFailures.inc();
