import { createContext, useContext } from "react";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { WorkspaceContext } from "./context";

export function flowControlProps(controlId: string) {
  const control = CATALOG_V1.controls.find(item => item.id === controlId);
  if (!control || control.sensitive || control.interactions.some(item => item.telemetry === "disabled")) throw new Error(`Unknown or private workspace control ${controlId}`);
  return { "data-workspace-control": control.id, "data-workspace-anchor": control.anchorId } as const;
}

/** What a shared component spreads on an element when its caller has it counted (flowControlProps). */
export type FlowControlAttributes = ReturnType<typeof flowControlProps>;

/** The block a shared control is drawn in (the sidebar timer, the Dashboard header's): elsewhere it is not counted. */
export const FlowControlHost = createContext<string | null>(null);

export function useFlowControlProps(localControlId: string) {
  const context = useContext(WorkspaceContext);
  const host = useContext(FlowControlHost);
  if (!context || !host || context.scope.surfaceId === "mobile-tabs") return {};
  // The page's own name, the shell's "shell": a shared control (timer, period) is counted where it is drawn.
  const prefix = context.scope.surfaceId === "shell-desktop" ? "shell" : context.scope.surfaceId;
  const controlId = `${prefix}.${localControlId}`;
  return CATALOG_V1.controls.some(control => control.id === controlId && control.anchorId === host) ? flowControlProps(controlId) : {};
}

export function workspaceMutationPath(controlId: string): readonly string[] | undefined {
  if (controlId === "dashboard.quickLog.save") return ["worklogs.create"];
  if (controlId === "dashboard.planned.save") return ["planned.create", "planned.update"];
  if (controlId === "dashboard.timer.pause" || controlId === "shell.timer.pause") return ["timers.pause"];
  if (controlId === "dashboard.timer.resume" || controlId === "shell.timer.resume" || controlId === "shell.timer.start" || controlId === "board.card.start" || controlId === "dashboard.activity.start") return ["timers.start"];
  if (controlId === "dashboard.timer.stop" || controlId === "shell.timer.stop") return ["timers.stop"];
  if (controlId === "shell.sync.start") return ["issues.sync"];
  // A gap cut logs its pieces as new worklogs, or grows a neighbouring one into the gap.
  if (controlId === "dashboard.gapCutter.save") return ["worklogs.create", "worklogs.update"];
  return undefined;
}
