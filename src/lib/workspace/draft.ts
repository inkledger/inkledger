import type { Draft, ResolvedWorkspace, SuggestionPatch } from "@contracts/workspace/model";

export function draftFromWorkspace(workspace: ResolvedWorkspace, patches: readonly SuggestionPatch[], previous?: Draft | null): Draft {
  const reusable = previous?.baseRevision === workspace.sourceActiveRevision ? previous : null;
  return {
    draftId: reusable?.draftId ?? `draft_${crypto.randomUUID()}`,
    draftRevision: reusable ? reusable.draftRevision + 1 : 1,
    baseRevision: workspace.sourceActiveRevision,
    scope: workspace.scope,
    patches: [...(reusable?.patches ?? []), ...patches],
    status: "ready",
  };
}

export function visibilityPatch(workspace: ResolvedWorkspace, anchorId: string, visible: boolean): SuggestionPatch {
  return {
    patchId: `patch_${crypto.randomUUID()}`,
    patchSchemaVersion: 1,
    scope: workspace.scope,
    baseRevision: workspace.sourceActiveRevision,
    catalogVersion: workspace.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: visible ? "keepVisible" : "reduce", status: "explicit", anchorId },
    operations: [{ type: "visibility", operationId: `op_${crypto.randomUUID()}`, anchorId, visible }],
    evidence: [],
    proposedConstraints: [],
  };
}

export function reorderPatch(workspace: ResolvedWorkspace, areaId: string, anchorIds: readonly string[]): SuggestionPatch {
  return {
    patchId: `patch_${crypto.randomUUID()}`,
    patchSchemaVersion: 1,
    scope: workspace.scope,
    baseRevision: workspace.sourceActiveRevision,
    catalogVersion: workspace.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: "group", status: "explicit", areaId },
    operations: [{ type: "reorder", operationId: `op_${crypto.randomUUID()}`, areaId, anchorIds }],
    evidence: [],
    proposedConstraints: [],
  };
}

export function pinPatch(workspace: ResolvedWorkspace, anchorId: string, pinned: boolean): SuggestionPatch {
  return {
    patchId: `patch_${crypto.randomUUID()}`,
    patchSchemaVersion: 1,
    scope: workspace.scope,
    baseRevision: workspace.sourceActiveRevision,
    catalogVersion: workspace.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: "keepVisible", status: "explicit", anchorId },
    operations: [{ type: "pin", operationId: `op_${crypto.randomUUID()}`, anchorId, pinned }],
    evidence: [],
    proposedConstraints: [],
  };
}

export function movePatch(workspace: ResolvedWorkspace, anchorId: string, toAreaId: string, order?: number): SuggestionPatch {
  return {
    patchId: `patch_${crypto.randomUUID()}`,
    patchSchemaVersion: 1,
    scope: workspace.scope,
    baseRevision: workspace.sourceActiveRevision,
    catalogVersion: workspace.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: "group", status: "explicit", anchorId, areaId: toAreaId },
    operations: [{ type: "move", operationId: `op_${crypto.randomUUID()}`, anchorId, toAreaId, ...(order === undefined ? {} : { order }) }],
    evidence: [],
    proposedConstraints: [],
  };
}

export function variantPatch(workspace: ResolvedWorkspace, anchorId: string, variant: "compact" | "default" | "expanded"): SuggestionPatch {
  return {
    patchId: `patch_${crypto.randomUUID()}`,
    patchSchemaVersion: 1,
    scope: workspace.scope,
    baseRevision: workspace.sourceActiveRevision,
    catalogVersion: workspace.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: "custom", status: "explicit", anchorId },
    operations: [{ type: "variant", operationId: `op_${crypto.randomUUID()}`, anchorId, variant }],
    evidence: [],
    proposedConstraints: [],
  };
}
