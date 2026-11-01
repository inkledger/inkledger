import { createHash } from "node:crypto";
import { attributeEvent } from "@contracts/workspace/applyMachine";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import type { FlowEvent } from "@contracts/workspace/flowMap";
import type { PresentationState } from "@contracts/workspace/applyMachine";
import type { Scope } from "@contracts/workspace/model";
import { getFlowSettings, saveFlowEvents } from "./flowStore";
import { loadApplyState } from "./store";

async function record(userId: number, scope: Scope, kind: "committed" | "presented" | "undone" | "seen" | "placed", clientInstanceId: string, epoch: number, descriptor: { effectiveRevision: string; workspaceFingerprint: string }, observedCommittedRevision: string, anchorId?: string, semanticRevision = 1, areaId?: string): Promise<void> {
  if (!(await getFlowSettings(userId)).enabled) return;
  const state = await loadApplyState(userId, scope);
  const proof = attributeEvent(state, { clientInstanceId, effectiveRevision: descriptor.effectiveRevision, workspaceFingerprint: descriptor.workspaceFingerprint, presentationEpoch: epoch });
  if (proof.kind !== "attributed") return;
  const discovery = kind === "seen" || kind === "placed";
  const event: FlowEvent = {
    eventSchemaVersion: 1,
    // One event per fact: per scope (a tab shows desktop and phone layouts), per presentation, and per revision a commit saw.
    // Hashed: a fixed, short id whatever the length of the tab and revision ids.
    id: `${discovery ? `discovery.${kind}` : `layout.${kind}`}.${createHash("sha256").update([anchorId ?? areaId ?? "", scope.surfaceId, scope.deviceClass, clientInstanceId, epoch, kind === "committed" ? observedCommittedRevision : ""].join("\n")).digest("hex").slice(0, 40)}`,
    kind: discovery ? `discovery.${kind}` : `layout.${kind}`,
    scope,
    ...(anchorId ? { anchorId } : {}),
    ...(areaId ? { areaId } : {}),
    semanticRevision,
    descriptor: proof.descriptor,
    clientInstanceId,
    presentationEpoch: epoch,
    sessionId: crypto.randomUUID(),
    sequence: 1,
    occurredAt: Date.now(),
    modality: "unknown",
    observedCommittedRevision,
  };
  await saveFlowEvents(userId, [event]);
}

export async function recordWorkspaceDiscovery(userId: number, scope: Scope, clientInstanceId: string, kind: "seen" | "placed", anchorId: string, targetKind: "anchor" | "area" = "anchor"): Promise<void> {
  if (targetKind === "area") {
    const area = CATALOG_V1.areas.find(item => item.id === anchorId && item.surfaceId === scope.surfaceId);
    if (!area) return;
    const state = await loadApplyState(userId, scope);
    const presented = state.presentations[clientInstanceId]?.presented;
    if (presented) await record(userId, scope, kind, clientInstanceId, presented.presentationEpoch, presented.descriptor, presented.descriptor.sourceActiveRevision, undefined, 1, area.id);
    return;
  }
  const anchor = CATALOG_V1.anchors.find(item => item.id === anchorId && item.surfaceId === scope.surfaceId);
  if (!anchor) return;
  const state = await loadApplyState(userId, scope);
  const presented = state.presentations[clientInstanceId]?.presented;
  if (presented) await record(userId, scope, kind, clientInstanceId, presented.presentationEpoch, presented.descriptor, presented.descriptor.sourceActiveRevision, anchor.id, anchor.semanticRevision);
}

export async function recordWorkspaceCommitted(userId: number, scope: Scope, clientInstanceId: string, revisionId: string): Promise<void> {
  const state = await loadApplyState(userId, scope);
  const presented = state.presentations[clientInstanceId]?.presented;
  if (presented) await record(userId, scope, "committed", clientInstanceId, presented.presentationEpoch, presented.descriptor, revisionId);
}

export async function recordWorkspacePresented(userId: number, scope: Scope, presentation: PresentationState, undone = false): Promise<void> {
  if (!presentation.presented) return;
  await record(userId, scope, undone ? "undone" : "presented", presentation.clientInstanceId, presentation.presented.presentationEpoch, presentation.presented.descriptor, presentation.presented.descriptor.sourceActiveRevision);
}
