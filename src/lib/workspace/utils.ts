import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { DeviceClass, ResolvedPlacement, ResolvedWorkspace } from "@contracts/workspace/model";

/** An area's visible placements in their order (hosts render them as they come). */
export function placementsFor(workspace: ResolvedWorkspace, areaId: string): readonly ResolvedPlacement[] {
  return workspace.placements.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order);
}

export function useWorkspaceDeviceClass(): DeviceClass {
  return useMediaQuery("(max-width: 1023px)", false) ? "mobile" : "desktop";
}
