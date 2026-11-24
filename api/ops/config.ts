// Operations settings from the environment (monitoring, alerts, rate limits), read once.
import { positiveNumber } from "../lib/env";

const on = (raw: string | undefined) => raw !== undefined && raw.trim() !== "" && raw.trim() !== "0" && raw.trim().toLowerCase() !== "off";

/** Per minute unless said: generous, a person working never meets them. */
export const opsConfig = {
  /** Bearer token for GET /api/metrics; unset: the route answers 404. */
  metricsToken: (process.env.METRICS_TOKEN ?? "").trim(),
  /** OTLP/HTTP collector (traces); unset: nothing is exported. */
  otelEndpoint: (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim(),
  otelServiceName: (process.env.OTEL_SERVICE_NAME ?? "").trim() || "inkledger",
  otelHeaders: (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").trim(),
  /** Free space under BACKUP_DIR below which /api/ready fails. */
  readyMinFreeMb: positiveNumber(process.env.READY_MIN_FREE_MB, 1024),
  /** Failures in a row of one sync stream that raise an alert (once, when reached). */
  alertFailures: positiveNumber(process.env.ALERT_FAILURES, 5),
  /** The same alert is not repeated within this many minutes. */
  alertCooldownMin: positiveNumber(process.env.ALERT_COOLDOWN_MIN, 360),
  rateLimit: {
    /** RATE_LIMIT=off turns the global limiter off (the sign-in and other route limits stay). */
    enabled: process.env.RATE_LIMIT === undefined || on(process.env.RATE_LIMIT),
    windowMs: positiveNumber(process.env.RATE_LIMIT_WINDOW_SEC, 60) * 1000,
    /** tRPC calls per signed-in account per window. */
    perUser: positiveNumber(process.env.RATE_LIMIT_USER, 1200),
    /** tRPC calls per client address per window (everyone behind one proxy shares it without TRUST_PROXY). */
    perIp: positiveNumber(process.env.RATE_LIMIT_IP, 6000),
    /** Single sign-on starts and callbacks, per address. */
    sso: positiveNumber(process.env.RATE_LIMIT_SSO, 30),
    /** SCIM provisioning calls, per token. */
    scim: positiveNumber(process.env.RATE_LIMIT_SCIM, 600),
    /** Exports (audit, personal data), per account. */
    export: positiveNumber(process.env.RATE_LIMIT_EXPORT, 10),
  },
} as const;
