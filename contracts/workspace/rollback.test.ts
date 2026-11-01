import { describe, expect, it } from "vitest";
import type { ResolvedPlacement, ResolvedWorkspace } from "./model";
import { rollbackOperations } from "./rollback";

function workspace(placements: readonly ResolvedPlacement[]): ResolvedWorkspace {
  return { scope: { surfaceId: "dashboard", deviceClass: "desktop" }, sourceActiveRevision: "revision", catalogVersion: "1.0.0", productDefaultVersion: "product-1", resolverVersion: 1, placements, fallbacks: [], discoveryAnchorIds: [], discoveryAreaIds: [], opaque: [] };
}
const targetPlacement: ResolvedPlacement = { anchorId: "dashboard.stats", areaId: "dashboard.secondary", order: 0, visible: true, variant: "default", pinned: false, origin: "product" };

describe("rollback layout diff", () => {
  it("undoes later visibility and variant changes instead of replaying the target history", () => {
    const operations = rollbackOperations(workspace([{ ...targetPlacement, visible: false, variant: "compact", origin: "user" }]), workspace([targetPlacement]), (() => { let id = 0; return () => `op-${id++}`; })());
    expect(operations).toEqual(expect.arrayContaining([
      { type: "visibility", operationId: expect.any(String), anchorId: "dashboard.stats", visible: true },
      { type: "variant", operationId: expect.any(String), anchorId: "dashboard.stats", variant: "default" },
    ]));
    expect(operations.some(operation => operation.type === "pin")).toBe(false);
  });

  it("does not create churn for a layout already equal to its target", () => {
    expect(rollbackOperations(workspace([targetPlacement]), workspace([targetPlacement]), () => "unused")).toEqual([]);
  });

  it("leaves alone what the target does not know instead of hiding it", () => {
    const later: ResolvedPlacement = { anchorId: "dashboard.timer", areaId: "dashboard.secondary", order: 1, visible: true, variant: "default", pinned: false, origin: "product" };
    const operations = rollbackOperations(workspace([targetPlacement, later]), workspace([targetPlacement]), () => "op");
    expect(operations.some(operation => operation.type === "visibility")).toBe(false);
    expect(operations.filter(operation => operation.type === "reorder")).toEqual([]);
  });
});

