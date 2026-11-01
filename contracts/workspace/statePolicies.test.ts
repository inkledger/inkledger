import { describe, expect, it } from "vitest";
import {
  assertCriticalStatePolicies,
  canMoveBetweenParents,
  canReorderWithinParent,
  CRITICAL_STATE_ANCHOR_IDS,
  INITIAL_ANCHOR_STATE_POLICIES,
  requiresActivationDefer,
  statePolicyFor,
} from "./statePolicies";

describe("anchor state policies", () => {
  it("has an explicit strategy for every critical stateful anchor", () => {
    expect(() => assertCriticalStatePolicies()).not.toThrow();
    for (const anchorId of CRITICAL_STATE_ANCHOR_IDS) expect(requiresActivationDefer(anchorId)).toBe(true);
    expect(Object.keys(INITIAL_ANCHOR_STATE_POLICIES).length).toBeGreaterThanOrEqual(18);
  });

  it("does not move local, dirty or critical state between React parents", () => {
    expect(canMoveBetweenParents("dashboard.stats")).toBe(true);
    expect(canMoveBetweenParents("dashboard.tasks")).toBe(true);
    expect(canMoveBetweenParents("dashboard.period")).toBe(false);
    expect(canMoveBetweenParents("dashboard.quick-log")).toBe(false);
    expect(canMoveBetweenParents("shell.timer.active")).toBe(false);
  });

  it("allows local reorder only inside the stable parent and defers dirty activation", () => {
    expect(canReorderWithinParent("mobile.tabs")).toBe(true);
    expect(canReorderWithinParent("mobile.timer.active")).toBe(false);
    expect(requiresActivationDefer("dashboard.gap-cutter")).toBe(true);
    expect(requiresActivationDefer("dashboard.stats")).toBe(false);
    expect(() => statePolicyFor("dashboard.unknown")).toThrow("Missing state policy");
  });
});
