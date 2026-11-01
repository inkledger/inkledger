import type { LayoutOperation, ResolvedWorkspace } from "./model";

export function rollbackOperations(current: ResolvedWorkspace, target: ResolvedWorkspace, operationId: () => string): LayoutOperation[] {
  const operations: LayoutOperation[] = [];
  const targetByAnchor = new Map(target.placements.map(placement => [placement.anchorId, placement]));
  for (const placement of current.placements) {
    const wanted = targetByAnchor.get(placement.anchorId);
    // Not in the target (it came later, or it is critical): left where it is, never hidden by an undo.
    if (!wanted) continue;
    if (placement.areaId !== wanted.areaId || placement.order !== wanted.order && placement.areaId !== wanted.areaId) {
      operations.push({ type: "move", operationId: operationId(), anchorId: placement.anchorId, toAreaId: wanted.areaId, order: wanted.order });
    }
    if (placement.variant !== wanted.variant) operations.push({ type: "variant", operationId: operationId(), anchorId: placement.anchorId, variant: wanted.variant });
    if (placement.visible !== wanted.visible) operations.push({ type: "visibility", operationId: operationId(), anchorId: placement.anchorId, visible: wanted.visible });
    if (placement.pinned !== wanted.pinned) operations.push({ type: "pin", operationId: operationId(), anchorId: placement.anchorId, pinned: wanted.pinned });
  }
  const areas = new Set(target.placements.map(placement => placement.areaId));
  for (const areaId of areas) {
    const currentIds = current.placements.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order).map(placement => placement.anchorId);
    // A reorder lists the area's visible anchors exactly: the ones the target does not know stay, after its own.
    const kept = currentIds.filter(anchorId => !targetByAnchor.has(anchorId));
    const wanted = [...target.placements.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order).map(placement => placement.anchorId), ...kept];
    if (wanted.length > 0 && wanted.join("\n") !== currentIds.join("\n")) operations.push({ type: "reorder", operationId: operationId(), areaId, anchorIds: wanted });
  }
  return operations;
}
