// A call budget per connection: calls spread so a pass stays inside the
// service's limit (the probe's figure, else the catalogue's typical one),
// and a rate-limit answer stops the pass (the stream then waits, state.ts).
// One process holds a stream at a time (the lease), so this lives in memory.
import type { RateLimitFigure } from "@contracts/providers";

export type Budget = { take: (signal?: AbortSignal) => Promise<void> };

/** No figure known: no spacing here; the service's own rate-limit answers still apply. */
export const unlimited: Budget = { take: async () => {} };

/** Spaces calls evenly at the figure's rate (the stricter of per second and per hour). */
export function budgetOf(figure: Pick<RateLimitFigure, "perHour" | "perSecond"> | undefined, clock = { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => sleep(ms, signal) }): Budget {
  if (!figure) return unlimited;
  const gapMs = Math.max(figure.perSecond ? 1000 / figure.perSecond : 0, figure.perHour ? 3_600_000 / figure.perHour : 0);
  if (gapMs <= 0) return unlimited;
  let next = 0;
  return {
    async take(signal) {
      const now = clock.now();
      const at = Math.max(now, next);
      next = at + gapMs;
      if (at > now) await clock.sleep(at - now, signal);
    },
  };
}

/** The reason a signal was aborted with, as an Error. */
const reasonOf = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(reasonOf(signal));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(reasonOf(signal));
      },
      { once: true },
    );
  });
}
