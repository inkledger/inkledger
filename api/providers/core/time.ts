// Time on its way to a service: amounts in its units, changes held to what
// it accepts (whole seconds, a known revision).
import { ProviderError } from "./errors";

/** Seconds as whole minutes, for services that keep minutes: the nearest, at least one (a short entry is not lost). */
export const wholeMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

/** Throws "invalid" unless a change carries the revision a service with revisions needs. */
export function assertRevision(concurrency: "revision" | "none", expectedVersion: string | undefined): void {
  if (concurrency === "revision" && !expectedVersion) throw new ProviderError("invalid", "This service changes entries only at a known revision");
}

/** Throws "invalid" unless a counter amount (or a day total, which may be 0) is whole seconds in range. */
export function assertSeconds(seconds: number, allowZero = false): void {
  if (!Number.isInteger(seconds) || seconds < (allowZero ? 0 : 1)) throw new ProviderError("invalid", `Not ${allowZero ? "zero or more" : "positive"} whole seconds: ${seconds}`);
}

/** Whole seconds as an ISO 8601 duration with no zero parts ("PT0S" for nothing). */
export function isoDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}
