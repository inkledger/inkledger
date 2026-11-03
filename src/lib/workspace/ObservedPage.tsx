import type { ReactNode } from "react";
import type { SurfaceId } from "@contracts/workspace/model";
import { WorkspaceScopeProvider } from "./provider";
import { useWorkspaceDeviceClass } from "./utils";

/**
 * A page FlowMap observes as it is (its blocks seen, its controls used), on this device class:
 * nothing is collected unless the user turned FlowMap on, and nothing on the page moves.
 */
export function ObservedPage({ surfaceId, children }: { surfaceId: SurfaceId; children: ReactNode }) {
  const deviceClass = useWorkspaceDeviceClass();
  return <WorkspaceScopeProvider scope={{ surfaceId, deviceClass }}>{children}</WorkspaceScopeProvider>;
}
