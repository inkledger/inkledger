import type { AnchorManifest, AreaManifest } from "@contracts/workspace/catalogTypes";
import type { Constraint, ResolvedPlacement } from "@contracts/workspace/model";

export type WorkspaceDropAssessment =
  | { allowed: true; operation: "move" | "reorder" }
  | { allowed: false; reason: "incompatible" | "capacity" | "constraint" | "state" };

export function assessWorkspaceDrop(input: {
  anchor: AnchorManifest;
  sourceAreaId: string;
  targetArea: AreaManifest;
  visible: boolean;
  targetVisibleCount: number;
  constraints: readonly Constraint[];
  placements?: readonly Pick<ResolvedPlacement, "anchorId" | "areaId" | "order">[];
  anchorsById?: ReadonlyMap<string, AnchorManifest>;
  orderedAnchorIds?: readonly string[];
}): WorkspaceDropAssessment {
  const { anchor, sourceAreaId, targetArea, visible, targetVisibleCount, constraints, placements, anchorsById, orderedAnchorIds } = input;
  if (anchor.critical || anchor.statePolicy === "dirty" || anchor.statePolicy === "critical") return { allowed: false, reason: "state" };
  if (constraints.some(constraint => constraint.status === "explicit" && constraint.anchorId === anchor.id && constraint.kind === "pin")) return { allowed: false, reason: "constraint" };
  if (targetArea.id === sourceAreaId) {
    if (!visible || !anchor.studio.operations.includes("reorder")) return { allowed: false, reason: "state" };
    if (orderedAnchorIds && placements && anchorsById) {
      for (const placement of placements.filter(item => item.areaId === sourceAreaId)) {
        const current = anchorsById.get(placement.anchorId);
        if ((current?.critical || current?.statePolicy === "dirty" || current?.statePolicy === "critical") && orderedAnchorIds.indexOf(placement.anchorId) !== placement.order) return { allowed: false, reason: "state" };
      }
    }
    return { allowed: true, operation: "reorder" };
  }
  if (anchor.statePolicy === "local" || !anchor.studio.operations.includes("move")) return { allowed: false, reason: "state" };
  if (!targetArea.allowedAnchorIds.includes(anchor.id)) return { allowed: false, reason: "incompatible" };
  if (visible && targetVisibleCount >= targetArea.capacity) return { allowed: false, reason: "capacity" };
  if (constraints.some(constraint => constraint.status === "explicit" && constraint.anchorId === anchor.id && constraint.kind === "expectHere" && constraint.areaId !== targetArea.id)) return { allowed: false, reason: "constraint" };
  return { allowed: true, operation: "move" };
}
