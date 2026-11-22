import { CATALOG_V1 } from "./catalogV1";
import type { StatePolicy } from "./model";

// Read from the catalog: a hand-kept copy drifted from it.
export const INITIAL_ANCHOR_STATE_POLICIES: Readonly<Record<string, StatePolicy>> = Object.fromEntries(
  CATALOG_V1.anchors.map(anchor => [anchor.id, anchor.statePolicy]),
);

export const CRITICAL_STATE_ANCHOR_IDS = [
  "dashboard.quick-log",
  "dashboard.planned-dialog",
  "dashboard.gap-cutter",
  "shell.timer.active",
  "mobile.timer.active",
] as const;

export function statePolicyFor(anchorId: string): StatePolicy {
  const policy: StatePolicy | undefined = INITIAL_ANCHOR_STATE_POLICIES[anchorId];
  if (!policy) throw new Error(`Missing state policy for ${anchorId}`);
  return policy;
}

export function canMoveBetweenParents(anchorId: string): boolean {
  const policy = statePolicyFor(anchorId);
  return policy === "stateless" || policy === "external";
}

export function canReorderWithinParent(anchorId: string): boolean {
  return ["stateless", "external", "local"].includes(statePolicyFor(anchorId));
}

export function requiresActivationDefer(anchorId: string): boolean {
  const policy = statePolicyFor(anchorId);
  return policy === "dirty" || policy === "critical";
}

export function assertCriticalStatePolicies(): void {
  for (const anchorId of CRITICAL_STATE_ANCHOR_IDS) {
    if (!requiresActivationDefer(anchorId)) throw new Error(`Unsafe state policy for ${anchorId}`);
  }
}
