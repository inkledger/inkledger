/**
 * One timer runs per user, controlled by one device at a time (its owner).
 * The owner renews a lease with a heartbeat; another device sees who holds it
 * and since when, and takes it over only on purpose. A lease that runs out
 * (the device slept, closed, lost the network) leaves the timer running and
 * free to take: time is never lost, only control moves.
 */

/** How long a lease lasts without a heartbeat. */
export const TIMER_LEASE_MS = 90_000;
/** How often the owner renews it (well inside the lease, even throttled in a background tab: ~1/min). */
export const TIMER_HEARTBEAT_MS = 25_000;

/**
 * Why a timer action was refused, with what the page needs to say it:
 * `held` — another device controls the running timer (take over to act);
 * `moved` — the timer changed since this page last saw it (refresh, then retry).
 */
export type TimerConflict = {
  reason: "held" | "moved";
  issueKey: string;
  connectionId: number;
  ownerLabel: string;
  /** When the current run started (epoch ms, server clock) */
  since: number;
  epoch: number;
};
