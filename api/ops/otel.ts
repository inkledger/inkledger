// Optional tracing: one span per HTTP request, sent over OTLP/HTTP (JSON) to
// OTEL_EXPORTER_OTLP_ENDPOINT. Off unless set (docs/it/outbound.md). Sent with the
// server's own fetch, so Settings → Network counts it, to an address checked
// like a tracker's (never this server's neighbours, link-local or metadata).
// Spans carry the method, the route template and the status: never a path,
// a query, a header or a body.
import { randomBytes } from "node:crypto";
import { assertSafeUrl } from "../lib/security";
import { safeFetch } from "../providers/core/http";
import { opsConfig } from "./config";

type Attr = { key: string; value: { stringValue: string } | { intValue: number } };
export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 2;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: 0 | 2 };
};

const FLUSH_MS = 5_000;
const BATCH = 256;
/** Spans held at most while the collector is away: older ones go first. */
const MAX_QUEUED = 4_096;

type State = { target: string | null; queue: Span[]; timer: ReturnType<typeof setTimeout> | null; headers: Record<string, string> };
const g = globalThis as { __iklOtel?: State };

/** "k=v,k2=v2" (OTEL_EXPORTER_OTLP_HEADERS) as headers. */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    if (/^[\w-]+$/.test(key)) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The traces URL for an OTLP base endpoint (the spec's "<endpoint>/v1/traces"). */
export const tracesUrl = (endpoint: string): string => `${endpoint.replace(/\/+$/, "")}/v1/traces`;

/** Checks the endpoint once at start; tracing stays off when it isn't allowed. */
export async function startTracing(endpoint = opsConfig.otelEndpoint, resolve?: (host: string) => Promise<string[]>): Promise<boolean> {
  if (!endpoint) return false;
  try {
    await assertSafeUrl(endpoint, { network: "private", ...(resolve ? { resolve } : {}) });
  } catch (e) {
    console.warn(`[otel] OTEL_EXPORTER_OTLP_ENDPOINT refused, tracing stays off: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  g.__iklOtel = { target: tracesUrl(endpoint), queue: [], timer: null, headers: parseOtlpHeaders(opsConfig.otelHeaders) };
  console.log(`[otel] traces go to ${new URL(endpoint).host}`);
  return true;
}

export const tracingOn = () => Boolean(g.__iklOtel?.target);

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

/** A W3C traceparent ("00-<trace>-<span>-<flags>"): the caller's trace goes on. */
export function parentOf(header: string | undefined): { traceId: string; spanId: string } | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec((header ?? "").trim());
  return m && !/^0+$/.test(m[1]) && !/^0+$/.test(m[2]) ? { traceId: m[1], spanId: m[2] } : null;
}

export function makeSpan(o: { method: string; route: string; status: number; startMs: number; endMs: number; traceparent?: string }): Span {
  const parent = parentOf(o.traceparent);
  return {
    traceId: parent?.traceId ?? hex(16),
    spanId: hex(8),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name: `${o.method} ${o.route}`,
    kind: 2,
    startTimeUnixNano: nanos(o.startMs),
    endTimeUnixNano: nanos(o.endMs),
    attributes: [
      { key: "http.request.method", value: { stringValue: o.method } },
      { key: "http.route", value: { stringValue: o.route } },
      { key: "http.response.status_code", value: { intValue: o.status } },
    ],
    status: { code: o.status >= 500 ? 2 : 0 },
  };
}

/** The OTLP/JSON body for some spans. */
export function otlpBody(spans: Span[], service = opsConfig.otelServiceName): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [{ scope: { name: "inkledger" }, spans }],
      },
    ],
  });
}

/** One request done: queued, sent within FLUSH_MS (or at once past BATCH). */
export function traceRequest(o: Parameters<typeof makeSpan>[0]): void {
  const s = g.__iklOtel;
  if (!s?.target) return;
  s.queue.push(makeSpan(o));
  if (s.queue.length > MAX_QUEUED) s.queue.splice(0, s.queue.length - MAX_QUEUED);
  if (s.queue.length >= BATCH) void flushTraces();
  else if (!s.timer) {
    s.timer = setTimeout(() => void flushTraces(), FLUSH_MS);
    s.timer.unref();
  }
}

/** Sends what is queued; a collector away keeps it for the next try (bounded). */
export async function flushTraces(): Promise<void> {
  const s = g.__iklOtel;
  if (!s?.target) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  const spans = s.queue.splice(0, BATCH);
  if (spans.length === 0) return;
  try {
    // Sends nothing to a tracker: allowed on a read-only server too.
    const res = await safeFetch({
      site: new URL(s.target).origin,
      url: s.target,
      network: "private",
      intent: "read",
      init: { method: "POST", body: otlpBody(spans), headers: { "Content-Type": "application/json", ...s.headers }, signal: AbortSignal.timeout(10_000) },
      fail: (_status, message) => new Error(message),
    });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`collector answered ${res.status}`);
  } catch (e) {
    s.queue.unshift(...spans);
    if (s.queue.length > MAX_QUEUED) s.queue.splice(0, s.queue.length - MAX_QUEUED);
    console.warn(`[otel] traces not sent: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (s.queue.length > 0 && !s.timer) {
    s.timer = setTimeout(() => void flushTraces(), FLUSH_MS);
    s.timer.unref();
  }
}
