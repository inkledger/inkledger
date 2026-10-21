// Time before it reaches an adapter: durations held to a service's limits
// (one algorithm, the same everywhere), and time input held to what the
// service keeps.
import type { EntryCapabilities, EntryLimits } from "@contracts/providers";
import { ProviderError } from "./errors";
import type { TimeInput } from "../types";

const roundTo = (seconds: number, step: number, rounding: "up" | "nearest" | "down") =>
  (rounding === "up" ? Math.ceil : rounding === "down" ? Math.floor : Math.round)(seconds / step) * step;

/**
 * A duration as the service will keep it: rounded to its increment first,
 * then held to its minimum and maximum. Throws "invalid" when it can't fit
 * (never silently clamped: the user decides).
 */
export function fitDuration(seconds: number, limits: EntryLimits): number {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new ProviderError("invalid", `Not a duration: ${seconds}`);
  const rounded = limits.increment ? roundTo(seconds, limits.increment.seconds, limits.increment.rounding) : seconds;
  if (rounded <= 0) throw new ProviderError("invalid", `${seconds}s rounds to nothing`);
  if (limits.minSeconds !== undefined && rounded < limits.minSeconds) throw new ProviderError("invalid", `Shorter than ${limits.minSeconds}s`);
  if (limits.maxSeconds !== undefined && rounded > limits.maxSeconds) throw new ProviderError("invalid", `Longer than ${limits.maxSeconds}s`);
  return rounded;
}

/** Throws "invalid" unless a service with these entry capabilities takes this time input. */
export function assertTimeInput(e: EntryCapabilities, input: TimeInput): void {
  if (e.model !== "entries") throw new ProviderError("invalid", "This service keeps day totals: set them, don't log entries");
  if (e.write.mode === "none") throw new ProviderError("invalid", "This service's time entries are read-only");
  if (input.kind !== e.shape) throw new ProviderError("invalid", `This service keeps ${e.shape} entries, not ${input.kind}`);
  if (e.limits.noFuture && input.kind === "session" && input.start > Date.now()) throw new ProviderError("invalid", "No entries in the future");
}

/** Throws "invalid" unless a change carries the revision a service with revisions needs. */
export function assertRevision(concurrency: "revision" | "none", expectedVersion: string | undefined): void {
  if (concurrency === "revision" && !expectedVersion) throw new ProviderError("invalid", "This service changes entries only at a known revision");
}

/** Throws "invalid" unless a counter amount (or a day total, which may be 0) is whole seconds in range. */
export function assertSeconds(seconds: number, allowZero = false): void {
  if (!Number.isInteger(seconds) || seconds < (allowZero ? 0 : 1)) throw new ProviderError("invalid", `Not ${allowZero ? "zero or more" : "positive"} whole seconds: ${seconds}`);
}
