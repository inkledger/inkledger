import { byCodeUnit } from "./canonical";
import { resolve } from "./resolve";
import type { Constraint, Draft, LayoutOperation, ResolveInput, SuggestionPatch } from "./model";

/** A change of the stale draft that is not proposed again, and why: changed meanwhile, or refused by today's rules. */
export type ReproposalDrop = {
  /** The operation's id (a proposed constraint's id for a constraint). */
  operationId: string;
  anchorId?: string;
  areaId?: string;
  reason: "overlap" | "refused";
};

/** What a refused stale draft tells the page: how many of its changes the user can keep (workspace.reproposeDraft). */
export type StaleDraftInfo = { keepable: number };

export type Reproposal = {
  /** The draft's patches rebased on the current revision, each with only the changes kept (empty ones left out). */
  patches: SuggestionPatch[];
  /** The kept operations, in the draft's own order. */
  operations: LayoutOperation[];
  dropped: ReproposalDrop[];
};

const anchorsOf = (operation: LayoutOperation): readonly string[] => operation.type === "reorder" ? operation.anchorIds : [operation.anchorId];
const areasOf = (operation: LayoutOperation): readonly string[] =>
  operation.type === "move" ? [operation.toAreaId] : operation.type === "reorder" ? [operation.areaId] : [];

function dropOf(operation: LayoutOperation, reason: ReproposalDrop["reason"]): ReproposalDrop {
  if (operation.type === "reorder") return { operationId: operation.operationId, areaId: operation.areaId, reason };
  if (operation.type === "move") return { operationId: operation.operationId, anchorId: operation.anchorId, areaId: operation.toAreaId, reason };
  return { operationId: operation.operationId, anchorId: operation.anchorId, reason };
}

const constraintDrop = (constraint: Constraint, reason: ReproposalDrop["reason"]): ReproposalDrop =>
  ({ operationId: constraint.id, anchorId: constraint.anchorId, ...(constraint.areaId ? { areaId: constraint.areaId } : {}), reason });

/** The patch with exactly these revocations (none: the field left out, as a patch without any has it). */
function withRevoked(patch: SuggestionPatch, revokedConstraintIds: readonly string[]): SuggestionPatch {
  const copy: SuggestionPatch = { ...patch };
  delete copy.revokedConstraintIds;
  return revokedConstraintIds.length > 0 ? { ...copy, revokedConstraintIds } : copy;
}

const dropKey = (drop: ReproposalDrop) => [drop.anchorId ?? "", drop.areaId ?? "", drop.reason, drop.operationId].join("\n");

/**
 * The changes of a draft made on an older revision that can be proposed again on the current one
 * (§21 #16): those disjoint from what was committed since its base, i.e. touching no block a
 * committed change touched and, for a move or reorder, no area a committed move or reorder touched.
 * Each kept change is checked again with the resolver on the current revision, one at a time in the
 * draft's order: one that no longer resolves is listed as refused, never forced. Nothing here
 * applies anything: the result is only a proposal for the user to preview (D-54).
 */
export function reproposeDisjoint(staleDraft: Draft, committedSince: readonly LayoutOperation[], currentInput: ResolveInput): Reproposal {
  const baseRevision = currentInput.activeRevision.revisionId;
  const catalogVersion = currentInput.catalog.catalogVersion;
  const touchedAnchors = new Set(committedSince.flatMap(anchorsOf));
  const touchedAreas = new Set(committedSince.flatMap(areasOf));
  const overlaps = (operation: LayoutOperation) =>
    anchorsOf(operation).some(anchorId => touchedAnchors.has(anchorId)) || areasOf(operation).some(areaId => touchedAreas.has(areaId));
  const currentConstraintIds = new Set(currentInput.activeRevision.constraints.map(constraint => constraint.id));
  const dropped: ReproposalDrop[] = [];

  // Each patch as it would be proposed again: no operation yet, its own constraints on untouched blocks only.
  let patches: SuggestionPatch[] = staleDraft.patches.map(patch => {
    const proposedConstraints = patch.proposedConstraints.filter(constraint => {
      const touched = touchedAnchors.has(constraint.anchorId);
      if (touched) dropped.push(constraintDrop(constraint, "overlap"));
      return !touched;
    });
    // A revoked constraint already gone needs no revoking any more.
    const revokedConstraintIds = (patch.revokedConstraintIds ?? []).filter(id => currentConstraintIds.has(id));
    return withRevoked({ ...patch, baseRevision, catalogVersion, operations: [], proposedConstraints }, revokedConstraintIds);
  });

  const resolves = (candidate: readonly SuggestionPatch[]) => resolve({
    ...currentInput,
    draft: { ...staleDraft, baseRevision, patches: candidate.filter(patch => patch.operations.length > 0 || patch.proposedConstraints.length > 0 || (patch.revokedConstraintIds?.length ?? 0) > 0) },
  }).kind === "resolved";

  if (!resolves(patches)) {
    // What the patches carry besides their operations no longer holds: nothing of it is proposed.
    for (const patch of patches) for (const constraint of patch.proposedConstraints) dropped.push(constraintDrop(constraint, "refused"));
    patches = patches.map(patch => withRevoked({ ...patch, proposedConstraints: [] }, []));
  }

  const operations: LayoutOperation[] = [];
  staleDraft.patches.forEach((patch, index) => {
    for (const operation of patch.operations) {
      if (overlaps(operation)) {
        dropped.push(dropOf(operation, "overlap"));
        continue;
      }
      const candidate = patches.map((item, at) => at === index ? { ...item, operations: [...item.operations, operation] } : item);
      if (!resolves(candidate)) {
        dropped.push(dropOf(operation, "refused"));
        continue;
      }
      patches = candidate;
      operations.push(operation);
    }
  });

  return {
    patches: patches.filter(patch => patch.operations.length > 0 || patch.proposedConstraints.length > 0 || (patch.revokedConstraintIds?.length ?? 0) > 0),
    operations,
    dropped: dropped.sort((a, b) => byCodeUnit(dropKey(a), dropKey(b))),
  };
}
