import { describe, expect, it } from "vitest";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "./catalogV1";
import { productDefaultFor } from "./catalog";
import type { EvidenceSet, HeatPoint } from "./flowMap";
import type { PresentationDescriptor, Scope } from "./model";
import { candidateSeeds, compareEvidence, requestOperationSeeds, type CandidateSeed } from "./planner";
import { resolve } from "./resolve";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
const descriptor: PresentationDescriptor = { effectiveRevision: "eff-current", sourceActiveRevision: "default", workspaceFingerprint: "fp", productDefaultVersion: "product-1", catalogVersion: "1.0.0", resolverVersion: 1, constraintsFingerprint: "constraints", feedbackFingerprint: "feedback", discoveryFingerprint: "discovery", rendererBindingsFingerprint: "renderers" };
const workspace = resolve({ catalog: CATALOG_V1, productDefault: productDefaultFor(PRODUCT_DEFAULTS_V1, "dashboard"), activeRevision: { revisionId: "default", scope, catalogVersion: "1.0.0", productDefaultVersion: "product-1", committedAt: 0, operations: [], constraints: [], opaque: [] }, draft: null, explicitConstraints: [], feedback: { suppressedSuggestionSignatures: [] }, discoveryState: { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [] } });
if (workspace.kind !== "resolved") throw new Error("Invalid fixture");
const baseWorkspace = workspace.workspace;

function point(controlId: string, anchorId: string, successes: number): HeatPoint {
  return { controlId, anchorId, semanticRevision: 1, activations: 30, successes, failures: 0, exposures: 10, activationRate: 3, modalities: { pointer: 30, touch: 0, keyboard: 0, unknown: 0 }, cells: Array.from({ length: 8 }, () => Array<number>(8).fill(0)) };
}
function evidence(overrides: Partial<EvidenceSet> = {}): EvidenceSet {
  return { evidenceId: "evidence-current", scope, descriptor, semanticRevision: 1, algorithmVersion: 1, origin: "local", coverage: { firstAt: 1, lastAt: 2, activeDays: 5, sessions: 5, exposures: 10, droppedEvents: 0, gaps: 0 }, heat: [point("dashboard.tasks.openBoard", "dashboard.tasks", 0), point("dashboard.timeline.gap", "dashboard.timeline", 5)], flows: [{ fromControlId: "dashboard.tasks.openBoard", toControlId: "dashboard.timeline.gap", count: 15 }], friction: [], expectations: [], ...overrides };
}

describe("co-adaptive planner", () => {
  it("proposes only a scoped reorder with visible ranking dimensions", () => {
    const candidates = candidateSeeds({ evidence: evidence(), workspace: baseWorkspace, catalog: CATALOG_V1, draft: null, effectiveRevision: "eff-current" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].operation).toEqual({ type: "reorder", areaId: "dashboard.primary", anchorIds: ["dashboard.summary", "dashboard.tasks", "dashboard.timeline", "dashboard.activity", "dashboard.recap"] });
    expect(candidates[0].ranking).toMatchObject({ crossDeviceImpact: "none", draftCompatibility: "neutral" });
    expect(candidates[0].ranking.benefit.maximum).toBeGreaterThan(0);
  });

  it("does not override manual choices or elevate imported evidence", () => {
    const manual = { ...baseWorkspace, placements: baseWorkspace.placements.map(placement => placement.anchorId === "dashboard.timeline" ? { ...placement, origin: "user" as const } : placement) };
    const touched = (operation: CandidateSeed["operation"]) => operation.type === "reorder" ? operation.anchorIds : [operation.anchorId];
    for (const candidate of candidateSeeds({ evidence: evidence(), workspace: manual, catalog: CATALOG_V1, draft: null, effectiveRevision: "eff-current" })) {
      // A reorder lists every anchor of the area, the manual one too: none may be proposed.
      expect(touched(candidate.operation)).not.toContain("dashboard.timeline");
    }
    expect(candidateSeeds({ evidence: evidence({ origin: "import" }), workspace: baseWorkspace, catalog: CATALOG_V1, draft: null, effectiveRevision: "eff-current" })).toEqual([]);
    expect(candidateSeeds({ evidence: evidence({ coverage: { ...evidence().coverage, activeDays: 4 } }), workspace: baseWorkspace, catalog: CATALOG_V1, draft: null, effectiveRevision: "eff-current" })).toEqual([]);
  });

  it("does not move a manually positioned neighbor to optimize another anchor", () => {
    const manualSource = { ...baseWorkspace, placements: baseWorkspace.placements.map(placement => placement.anchorId === "dashboard.tasks" ? { ...placement, origin: "user" as const } : placement) };
    expect(candidateSeeds({ evidence: evidence(), workspace: manualSource, catalog: CATALOG_V1, draft: null, effectiveRevision: "eff-current" })).toEqual([]);
  });

  it("never suggests moving what is pinned or critical, even to reach a neighbour", () => {
    // The header's pinned timer and period sit between log time and the period: no reorder may shift them.
    const header = evidence({ heat: [point("dashboard.period.next", "dashboard.period", 0), point("dashboard.customize.open", "dashboard.customize", 5)], flows: [{ fromControlId: "dashboard.period.next", toControlId: "dashboard.customize.open", count: 15 }] });
    for (const candidate of candidateSeeds({ evidence: header, workspace: baseWorkspace, catalog: CATALOG_V1, draft: null, effectiveRevision: "eff-current" })) {
      if (candidate.operation.type !== "reorder") continue;
      expect(candidate.operation.anchorIds.slice(0, 2)).toEqual(["dashboard.headerTimer", "dashboard.period"]);
    }
  });

  it("offers only effective and catalog-compatible operations for request translation", () => {
    const options = requestOperationSeeds(baseWorkspace, CATALOG_V1);
    expect(options).toContainEqual({ type: "variant", anchorId: "dashboard.stats", variant: "expanded" });
    expect(options).not.toContainEqual({ type: "move", anchorId: "dashboard.stats", toAreaId: "dashboard.desk" });
    expect(options).not.toContainEqual({ type: "move", anchorId: "dashboard.stats", toAreaId: "dashboard.secondary" });
    expect(new Set(options.map(operation => JSON.stringify(operation))).size).toBe(options.length);
    for (const operation of options.filter(operation => operation.type === "reorder")) {
      const expected = baseWorkspace.placements.filter(placement => placement.areaId === operation.areaId && placement.visible).map(placement => placement.anchorId).sort();
      expect([...operation.anchorIds].sort()).toEqual(expected);
    }
  });

  it("keeps adaptation-window and confounds explicit in before/after comparisons", () => {
    const before = evidence({ heat: [point("dashboard.logTime", "dashboard.quickActions", 5)] });
    const after = evidence({ descriptor: { ...descriptor, effectiveRevision: "eff-after" }, heat: [{ ...point("dashboard.logTime", "dashboard.quickActions", 10), activations: 30, exposures: 30 }] });
    expect(compareEvidence(before, after)).toMatchObject({ outcome: "improved", confounds: ["observational", "placement-exposure"] });
    expect(compareEvidence(before, { ...after, coverage: { ...after.coverage, activeDays: 3 } }).outcome).toBe("inconclusive");
    const fewerOutcomes = evidence({ heat: [point("dashboard.logTime", "dashboard.quickActions", 2)] });
    const moreOutcomes = evidence({ descriptor: { ...descriptor, effectiveRevision: "eff-more-outcomes" }, heat: [point("dashboard.logTime", "dashboard.quickActions", 5)] });
    expect(compareEvidence(fewerOutcomes, moreOutcomes)).toMatchObject({ outcome: "improved", beforeRate: 15, afterRate: 6 });
    const noOutcomes = evidence({ descriptor: { ...descriptor, effectiveRevision: "eff-no-outcomes" }, heat: [point("dashboard.logTime", "dashboard.quickActions", 0)] });
    expect(compareEvidence(fewerOutcomes, noOutcomes)).toMatchObject({ outcome: "inconclusive", confounds: expect.arrayContaining(["insufficient-outcomes"]) });
  });
});
