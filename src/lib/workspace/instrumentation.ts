import { useContext } from "react";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { WorkspaceContext } from "./context";

export function flowControlProps(controlId: string) {
  const control = CATALOG_V1.controls.find(item => item.id === controlId);
  if (!control || control.sensitive || control.interactions.some(item => item.telemetry === "disabled")) throw new Error(`Unknown or private workspace control ${controlId}`);
  return { "data-workspace-control": control.id, "data-workspace-anchor": control.anchorId } as const;
}

export function useFlowControlProps(localControlId: string) {
  const context = useContext(WorkspaceContext);
  if (!context || context.scope.surfaceId === "mobile-tabs") return {};
  const prefix = context.scope.surfaceId === "shell-desktop" ? "shell" : "dashboard";
  const controlId = `${prefix}.${localControlId}`;
  return CATALOG_V1.controls.some(control => control.id === controlId) ? flowControlProps(controlId) : {};
}

export function workspaceMutationPath(controlId: string): readonly string[] | undefined {
  if (controlId === "dashboard.quickLog.save") return ["worklogs.create"];
  if (controlId === "dashboard.planned.save") return ["planned.create", "planned.update"];
  if (controlId === "dashboard.timer.pause" || controlId === "shell.timer.pause") return ["timers.pause"];
  if (controlId === "dashboard.timer.resume" || controlId === "shell.timer.resume" || controlId === "shell.timer.start" || controlId === "mobile.timer.start") return ["timers.start"];
  if (controlId === "dashboard.timer.stop" || controlId === "shell.timer.stop") return ["timers.stop"];
  if (controlId === "shell.sync.start") return ["issues.sync"];
  return undefined;
}
