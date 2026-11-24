// Prometheus metrics (GET /api/metrics, off unless METRICS_TOKEN is set). Pull only:
// nothing leaves the server. Labels stay bounded: a route template, never a raw
// path (webhook and share-link tokens live in paths); a provider type, never a URL.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Histogram, Registry } from "./prometheus";

type Metrics = {
  registry: Registry;
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
  /** When the last off-site copy landed (ms), null when none or off */
  offsiteLastOk: () => Promise<number | null>;
  /** The last restore drill: passed or not, null when none yet */
  drillOk: () => Promise<boolean | null>;
  streams: () => number;
};

// One registry per process: the dev server evaluates modules again on each change.
const g = globalThis as { __iklMetrics?: Metrics; __iklGauges?: Gauges };

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function build(): Metrics {
  const registry = new Registry();
  const r = <M extends Parameters<Registry["register"]>[0]>(metric: M) => registry.register(metric);
  return {
    registry,
    http: r(new Counter("inkledger_http_requests_total", "HTTP requests by route template and status", ["method", "route", "status"])),
    latency: r(new Histogram("inkledger_http_request_duration_seconds", "HTTP request latency by route template", ["method", "route"], LATENCY_BUCKETS)),
    syncPasses: r(new Counter("inkledger_sync_passes_total", "Sync passes that went through, by provider type and stream", ["provider", "stream"])),
    syncFailures: r(new Counter("inkledger_sync_failures_total", "Sync passes that failed, by provider type, stream and kind", ["provider", "stream", "kind"])),
    loginFailures: r(new Counter("inkledger_login_failures_total", "Refused sign-ins (wrong password, too many attempts)", ["reason"])),
    rateLimited: r(new Counter("inkledger_rate_limited_total", "Requests refused by a rate limit (429), by limiter", ["limiter"])),
    alerts: r(new Counter("inkledger_alerts_total", "Alerts raised (after deduplication), by kind", ["kind"])),
    webhookFailures: r(new Counter("inkledger_alert_webhook_failures_total", "Alert webhook deliveries that failed")),
  };
}

export const metrics = (): Metrics => (g.__iklMetrics ??= withGauges(build()));

/** The scrape-time readers; set once by the server (tests set their own). */
export function setGauges(gauges: Gauges): void {
  g.__iklGauges = gauges;
}

/** A gauge filled when scraped. */
function scraped<L extends string>(registry: Registry, name: string, help: string, labelNames: readonly L[], read: (g: Gauge<L>) => void | Promise<void>): void {
  const gauge = registry.register(new Gauge<L>(name, help, labelNames));
  gauge.collect = () => read(gauge);
}

function withGauges(m: Metrics): Metrics {
  const reg = m.registry;
  const gauges = () => g.__iklGauges;
  scraped(reg, "inkledger_db_pool_connections", "Database pool connections by state", ["state"], (gauge) => {
    const p = gauges()?.pool();
    if (!p) return;
    gauge.set({ state: "total" }, p.total);
    gauge.set({ state: "idle" }, p.idle);
    gauge.set({ state: "waiting" }, p.waiting);
  });
  scraped(reg, "inkledger_connections", "Tracker connections (not archived) by provider type and status", ["provider", "status"], async (gauge) => {
    const read = gauges()?.connections;
    if (!read) return;
    const rows = await read();
    gauge.reset();
    for (const row of rows) gauge.set({ provider: row.type, status: row.status }, row.count);
  });
  scraped(reg, "inkledger_outbox_depth", "Time changes queued for trackers out of reach", [], async (gauge) => {
    const read = gauges()?.outbox;
    if (read) gauge.set({}, await read());
  });
  scraped(reg, "inkledger_backup_last_success_timestamp_seconds", "When the last backup succeeded (Unix time; 0 when none yet)", [], async (gauge) => {
    const read = gauges()?.backupLastOk;
    if (read) gauge.set({}, ((await read()) ?? 0) / 1000);
  });
  scraped(reg, "inkledger_backup_offsite_last_success_timestamp_seconds", "When the last off-site copy of a backup landed (Unix time; 0 when none or off)", [], async (gauge) => {
    const read = gauges()?.offsiteLastOk;
    if (read) gauge.set({}, ((await read()) ?? 0) / 1000);
  });
  scraped(reg, "inkledger_backup_drill_success", "The last restore drill: 1 passed, 0 failed, -1 none yet", [], async (gauge) => {
    const read = gauges()?.drillOk;
    if (read) {
      const ok = await read();
      gauge.set({}, ok === null ? -1 : ok ? 1 : 0);
    }
  });
  scraped(reg, "inkledger_sse_streams", "Open live-event streams (server-sent events)", [], (gauge) => {
    const read = gauges()?.streams;
    if (read) gauge.set({}, read());
  });
  // The process itself: memory, uptime, the event loop's delay (p99 since the last scrape).
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  scraped(reg, "inkledger_process_resident_memory_bytes", "Resident memory of the server process", [], (gauge) => gauge.set({}, process.memoryUsage.rss()));
  scraped(reg, "inkledger_nodejs_heap_used_bytes", "V8 heap in use", [], (gauge) => gauge.set({}, process.memoryUsage().heapUsed));
  scraped(reg, "inkledger_process_uptime_seconds", "Seconds since the server process started", [], (gauge) => gauge.set({}, Math.round(process.uptime())));
  scraped(reg, "inkledger_nodejs_eventloop_lag_p99_seconds", "Event loop delay, 99th percentile since the last scrape", [], (gauge) => {
    gauge.set({}, loop.percentile(99) / 1e9);
    loop.reset();
  });
  return m;
}

/** Prometheus' text exposition of every metric. */
export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  return { body: await metrics().registry.render(), contentType: Registry.contentType };
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
