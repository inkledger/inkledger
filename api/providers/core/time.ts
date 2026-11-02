// Time on its way to a service: amounts in its units, changes held to what
// it accepts (whole seconds, UTC to the second, plain days).
import { DAY_MS } from "@contracts/time";
import { ProviderError } from "./errors";

/** Seconds as whole minutes, for services that keep minutes: the nearest, at least one (a short entry is not lost). */
export const wholeMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

/** An instant in UTC to the second ("2026-10-14T08:30:00Z"): the milliseconds cut off, as services that refuse them want it. */
export const isoSecondsUtc = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The day an instant falls on in UTC ("2026-10-14"). */
export const utcDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The day `n` days after a plain day (before it, when negative). */
export const addLocalDays = (day: string, n: number): string => utcDayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

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
