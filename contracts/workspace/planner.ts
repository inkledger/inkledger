import { canonicalJSON } from "./canonical";
import type { EvidenceSet } from "./flowMap";
import type { CatalogManifest } from "./catalogTypes";
import type { Draft, LayoutOperation, ResolvedPlacement, ResolvedWorkspace } from "./model";

export type OperationSeed = LayoutOperation extends infer Operation
  ? Operation extends LayoutOperation ? Omit<Operation, "operationId"> : never
  : never;
export type Ranking = {
  benefit: { metric: "steps"; minimum: number; maximum: number };
  evidenceQuality: number;
  relearningCost: number;
  instability: number;
  crossDeviceImpact: "none";
  draftCompatibility: "supports" | "neutral";
};
export type CandidateSeed = {
  operation: OperationSeed;
  anchorId: string;
  sourceControlId?: string;
  reason: "sequence-neighbor" | "frequent-control";
  ranking: Ranking;
};

function ranking(evidence: EvidenceSet, operation: OperationSeed["type"], activations: number): Ranking {
  const observed = evidence.heat.reduce((sum, point) => sum + point.activations, 0);
  const quality = Math.min(1, evidence.coverage.activeDays / 5) * Math.min(1, observed / 30) * Math.max(0.25, 1 - evidence.coverage.gaps / Math.max(1, observed));
  const cost = operation === "move" ? 0.45 : operation === "reorder" ? 0.2 : 0.15;
  return {
    benefit: { metric: "steps", minimum: Math.min(1, activations / Math.max(1, observed)), maximum: Math.min(3, activations / Math.max(1, observed) * 2) },
    evidenceQuality: Math.round(quality * 100) / 100,
    relearningCost: cost,
    instability: 0.1,
    crossDeviceImpact: "none",
    draftCompatibility: "neutral",
  };
}

export function candidateSeeds(input: {
  evidence: EvidenceSet;
  workspace: ResolvedWorkspace;
  catalog: CatalogManifest;
  draft: Draft | null;
  effectiveRevision: string;
}): CandidateSeed[] {
  const { evidence, workspace, catalog, draft } = input;
  if (evidence.origin !== "local" || evidence.descriptor.effectiveRevision !== input.effectiveRevision) return [];
  const activations = evidence.heat.reduce((sum, point) => sum + point.activations, 0);
  if (evidence.coverage.activeDays < 5 || activations < 30) return [];
  const placements = new Map(workspace.placements.map(placement => [placement.anchorId, placement]));
  const anchors = new Map(catalog.anchors.map(anchor => [anchor.id, anchor]));
  const allowed = (placement: ResolvedPlacement | undefined, operation: "move" | "reorder" | "variant") => {
    if (!placement || placement.pinned || placement.origin === "user") return false;
    const anchor = anchors.get(placement.anchorId);
    if (!anchor || anchor.critical || !anchor.studio.operations.includes(operation)) return false;
    return !draft?.patches.some(patch => patch.operations.some(item => (item.type === "reorder" ? item.anchorIds : [item.anchorId]).includes(placement.anchorId)));
  };
  const candidates: CandidateSeed[] = [];
  for (const edge of evidence.flows.slice(0, 12)) {
    const from = evidence.heat.find(point => point.controlId === edge.fromControlId);
    const to = evidence.heat.find(point => point.controlId === edge.toControlId);
    const source = from ? placements.get(from.anchorId) : undefined;
    const destination = to ? placements.get(to.anchorId) : undefined;
    if (!source || !destination || source.anchorId === destination.anchorId || !allowed(destination, source.areaId === destination.areaId ? "reorder" : "move")) continue;
    if (source.areaId === destination.areaId) {
      if (source.origin === "user" || draft?.patches.some(patch => patch.operations.some(item => (item.type === "reorder" ? item.anchorIds : [item.anchorId]).includes(source.anchorId)))) continue;
      const current = workspace.placements.filter(item => item.areaId === source.areaId && item.visible).sort((a, b) => a.order - b.order);
      const ids = current.map(item => item.anchorId);
      const fromIndex = ids.indexOf(destination.anchorId);
      const toIndex = ids.indexOf(source.anchorId);
      if (fromIndex < 0 || toIndex < 0 || Math.abs(fromIndex - toIndex) === 1) continue;
      ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, destination.anchorId);
      if (!keepsFixed(current, ids, anchors)) continue;
      candidates.push({ operation: { type: "reorder", areaId: source.areaId, anchorIds: ids }, anchorId: destination.anchorId, sourceControlId: edge.fromControlId, reason: "sequence-neighbor", ranking: ranking(evidence, "reorder", edge.count) });
    } else {
      const area = catalog.areas.find(item => item.id === source.areaId);
      const used = workspace.placements.filter(item => item.areaId === source.areaId && item.visible).length;
      if (!area || used >= area.capacity) continue;
      candidates.push({ operation: { type: "move", anchorId: destination.anchorId, toAreaId: source.areaId, order: source.order }, anchorId: destination.anchorId, sourceControlId: edge.fromControlId, reason: "sequence-neighbor", ranking: ranking(evidence, "move", edge.count) });
    }
    if (candidates.length >= 3) break;
  }
  if (candidates.length === 0) {
    const point = [...evidence.heat].sort((a, b) => b.activations - a.activations)[0];
    const placement = point ? placements.get(point.anchorId) : undefined;
    if (point && placement && placement.variant !== "expanded" && allowed(placement, "variant")) {
      candidates.push({ operation: { type: "variant", anchorId: placement.anchorId, variant: "expanded" }, anchorId: placement.anchorId, reason: "frequent-control", ranking: ranking(evidence, "variant", point.activations) });
    }
  }
  return candidates.slice(0, 6);
}

/** What a suggestion must leave at its index: critical, dirty and pinned anchors (only the user moves those). */
function isFixed(placement: ResolvedPlacement, anchors: ReadonlyMap<string, CatalogManifest["anchors"][number]>): boolean {
  const anchor = anchors.get(placement.anchorId);
  return Boolean(placement.pinned || anchor?.critical || anchor?.statePolicy === "dirty" || anchor?.statePolicy === "critical");
}

function keepsFixed(current: readonly ResolvedPlacement[], anchorIds: readonly string[], anchors: ReadonlyMap<string, CatalogManifest["anchors"][number]>): boolean {
  return current.every((placement, index) => !isFixed(placement, anchors) || anchorIds.indexOf(placement.anchorId) === index);
}

export function requestOperationSeeds(workspace: ResolvedWorkspace, catalog: CatalogManifest): OperationSeed[] {
  const options: OperationSeed[] = [];
  const anchors = new Map(catalog.anchors.map(anchor => [anchor.id, anchor]));
  const areas = new Map(catalog.areas.map(area => [area.id, area]));
  for (const placement of workspace.placements) {
    const anchor = anchors.get(placement.anchorId);
    if (!anchor || placement.pinned) continue;
    if (anchor.studio.operations.includes("variant")) {
      for (const variant of anchor.studio.variants) if (variant !== placement.variant) options.push({ type: "variant", anchorId: anchor.id, variant });
    }
    if (anchor.studio.operations.includes("move")) {
      for (const area of areas.values()) {
        const used = workspace.placements.filter(item => item.areaId === area.id && item.visible).length;
        if (area.id !== placement.areaId && area.allowedAnchorIds.includes(anchor.id) && (!placement.visible || used < area.capacity)) options.push({ type: "move", anchorId: anchor.id, toAreaId: area.id });
      }
    }
    if (anchor.studio.operations.includes("hide")) options.push({ type: "visibility", anchorId: anchor.id, visible: !placement.visible });
    if (anchor.studio.operations.includes("pin")) options.push({ type: "pin", anchorId: anchor.id, pinned: !placement.pinned });
  }
  for (const area of areas.values()) {
    const current = workspace.placements.filter(placement => placement.areaId === area.id && placement.visible).sort((a, b) => a.order - b.order);
    const currentIds = current.map(placement => placement.anchorId);
    for (const placement of current) {
      const anchor = anchors.get(placement.anchorId);
      if (!anchor || isFixed(placement, anchors) || !anchor.studio.operations.includes("reorder")) continue;
      const remaining = currentIds.filter(id => id !== anchor.id);
      for (let index = 0; index <= remaining.length; index++) {
        const anchorIds = [...remaining];
        anchorIds.splice(index, 0, anchor.id);
        if (anchorIds.join("\n") === currentIds.join("\n") || !keepsFixed(current, anchorIds, anchors)) continue;
        options.push({ type: "reorder", areaId: area.id, anchorIds });
      }
    }
  }
  // Moving A one place on and B one place back is the same order: one option, one id for the model.
  const seen = new Set<string>();
  return options.filter(option => {
    const key = canonicalJSON(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 256);
}

export function compareEvidence(before: EvidenceSet, after: EvidenceSet) {
  const reasons: string[] = ["observational", "placement-exposure"];
  const activations = (evidence: EvidenceSet) => evidence.heat.reduce((sum, point) => sum + point.activations, 0);
  const exposures = (evidence: EvidenceSet) => evidence.heat.reduce((sum, point) => sum + point.exposures, 0);
  const successes = (evidence: EvidenceSet) => evidence.heat.reduce((sum, point) => sum + point.successes, 0);
  if (before.descriptor.effectiveRevision === after.descriptor.effectiveRevision || before.semanticRevision !== after.semanticRevision || before.scope.surfaceId !== after.scope.surfaceId || before.scope.deviceClass !== after.scope.deviceClass) reasons.push("incomparable");
  if (after.coverage.activeDays < 5 || before.coverage.activeDays < 5 || activations(before) < 30 || activations(after) < 30) reasons.push("adaptation-window");
  if (exposures(before) === 0 || exposures(after) === 0) reasons.push("insufficient-exposure");
  if (successes(before) === 0 || successes(after) === 0) reasons.push("insufficient-outcomes");
  if (reasons.length > 2) return { outcome: "inconclusive" as const, confounds: reasons };
  const beforeRate = activations(before) / successes(before);
  const afterRate = activations(after) / successes(after);
  if (Math.abs(beforeRate - afterRate) < 0.05) return { outcome: "inconclusive" as const, confounds: reasons };
  return { outcome: afterRate < beforeRate ? "improved" as const : "worsened" as const, beforeRate, afterRate, confounds: reasons };
}
