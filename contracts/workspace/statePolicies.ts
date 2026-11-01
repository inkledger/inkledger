import type { StatePolicy } from "./model";

export const INITIAL_ANCHOR_STATE_POLICIES = {
  "dashboard.timeline": "local",
  "dashboard.stats": "stateless",
  "dashboard.summary": "local",
  "dashboard.tasks": "external",
  "dashboard.activity": "stateless",
  "dashboard.recap": "stateless",
  "dashboard.period": "local",
  "dashboard.quick-log": "dirty",
  "dashboard.planned-dialog": "dirty",
  "dashboard.gap-cutter": "dirty",
  "shell.navigation": "stateless",
  "shell.command-palette": "external",
  "shell.notifications": "external",
  "shell.quick-start": "external",
  "shell.sync": "external",
  "shell.timer.active": "critical",
  "mobile.tabs": "local",
  "mobile.more": "local",
  "mobile.timer.active": "critical",
} as const satisfies Readonly<Record<string, StatePolicy>>;

export const CRITICAL_STATE_ANCHOR_IDS = [
  "dashboard.quick-log",
  "dashboard.planned-dialog",
  "dashboard.gap-cutter",
  "shell.timer.active",
  "mobile.timer.active",
] as const;

export function statePolicyFor(anchorId: string): StatePolicy {
  const policy = INITIAL_ANCHOR_STATE_POLICIES[anchorId as keyof typeof INITIAL_ANCHOR_STATE_POLICIES] as StatePolicy | undefined;
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
