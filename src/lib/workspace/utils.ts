import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { DeviceClass, ResolvedPlacement, ResolvedWorkspace } from "@contracts/workspace/model";

/** An area's visible placements in their order, the same order apart by id (hosts render them as they come). */
export function placementsFor(workspace: ResolvedWorkspace, areaId: string): readonly ResolvedPlacement[] {
  return workspace.placements.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order || (a.anchorId < b.anchorId ? -1 : 1));
}

/** Whether the anchor is shown in that area. */
export function isPlaced(workspace: ResolvedWorkspace, anchorId: string, areaId: string): boolean {
  return workspace.placements.some(placement => placement.anchorId === anchorId && placement.areaId === areaId && placement.visible);
}

export function useWorkspaceDeviceClass(): DeviceClass {
  return useMediaQuery("(max-width: 1023px)", false) ? "mobile" : "desktop";
}
