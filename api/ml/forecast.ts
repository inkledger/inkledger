// The forecast sidecar's client (docs/work/ideas/estimates.md R-3.17, R-3.21): its address only
// from FORECAST_URL, plain fetch (R-0.3: it lives on this machine or its network), 30 s at most.
import { env } from "../lib/env";

export type Readiness = { available: true; model: string } | { available: false; reason: string };

export type ForecastRequest = {
  series: number[];
  freq: "D" | "W";
  horizon: number;
  quantiles: number[];
  past_covariates?: Record<string, number[]>;
  future_covariates?: Record<string, number[]>;
};
export type ForecastAnswer = { quantiles: Record<string, number[]> };

export class ForecastError extends Error {
  readonly kind: "off" | "notReady" | "bad" | "slow";
  constructor(kind: "off" | "notReady" | "bad" | "slow", message: string) {
    super(message);
    this.kind = kind;
  }
}

const TIMEOUT_MS = 30_000;

/** Whether the forecast can be asked now: the sidecar's /ready (R-3.21). */
export async function readiness(): Promise<Readiness> {
  if (env.forecastSimulator) return { available: true, model: "simulator" };
  if (!env.forecastUrl) return { available: false, reason: "off" };
  try {
    const res = await fetch(`${env.forecastUrl}/ready`, { redirect: "error", signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => ({}))) as { model?: unknown; reason?: unknown };
    if (res.ok) return { available: true, model: typeof body.model === "string" ? body.model : env.forecastModel };
    return { available: false, reason: typeof body.reason === "string" ? body.reason : `status ${res.status}` };
  } catch {
    return { available: false, reason: "unreachable" };
  }
}

/**
 * The same weekday's mean over the last four weeks (one step back for weekly
 * series), p10/p90 at ±30%: deterministic, no model (FORECAST_SIMULATOR=1).
 */
export function simulate(req: ForecastRequest): ForecastAnswer {
  const season = req.freq === "D" ? 7 : 1;
  const n = req.series.length;
  const base = Array.from({ length: req.horizon }, (_, h) => {
    // The nearest four past days with the same position in the season.
    const first = Math.ceil((h + 1) / season);
    const same = [0, 1, 2, 3].map((k) => n + h - (first + k) * season).filter((i) => i >= 0 && i < n).map((i) => req.series[i]);
    return same.length ? same.reduce((a, b) => a + b, 0) / same.length : 0;
  });
  return { quantiles: Object.fromEntries(req.quantiles.map((q) => [String(q), base.map((v) => v * (0.7 + 0.6 * q))])) };
}

/** One forecast: E-3.2 when off, E-3.6 when not ready, E-3.3 on a bad answer, E-3.4 after 30 s. */
export async function forecast(req: ForecastRequest): Promise<ForecastAnswer> {
  if (env.forecastSimulator) return simulate(req);
  if (!env.forecastUrl) throw new ForecastError("off", "FORECAST_URL is not set");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${env.forecastUrl}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      redirect: "error",
      signal: timeout,
    });
  } catch (e) {
    if (timeout.aborted) throw new ForecastError("slow", "the forecast took too long");
    throw new ForecastError("notReady", String(e));
  }
  if (res.status === 503) throw new ForecastError("notReady", "the model isn't ready");
  if (!res.ok) throw new ForecastError("bad", `the sidecar answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as ForecastAnswer | null;
  const ok = body && typeof body.quantiles === "object" && req.quantiles.every((q) => Array.isArray(body.quantiles[String(q)]) && body.quantiles[String(q)].length === req.horizon);
  if (!ok) throw new ForecastError("bad", "the answer isn't in shape");
  return body;
}
