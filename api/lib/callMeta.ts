/** A provider call's meta: its timeout, and a correlation id for the logs ("<prefix>-<now>"). */
export const callMeta = (prefix = "ui", ms = 30_000) => ({ signal: AbortSignal.timeout(ms), correlationId: `${prefix}-${Date.now()}` });
