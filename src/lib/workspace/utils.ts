import { useEffect, useState } from "react";
import type { DeviceClass, ResolvedPlacement, ResolvedWorkspace } from "@contracts/workspace/model";

/** An area's visible placements in their order (hosts render them as they come). */
export function placementsFor(workspace: ResolvedWorkspace, areaId: string): readonly ResolvedPlacement[] {
  return workspace.placements.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order);
}

export function useWorkspaceDeviceClass(): DeviceClass {
  const [deviceClass, setDeviceClass] = useState<DeviceClass>("desktop");
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setDeviceClass(media.matches ? "mobile" : "desktop");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return deviceClass;
}
