import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import type { PresentationDescriptor, Scope } from "@contracts/workspace/model";

export function useWorkspaceTelemetry(
  scope: Scope,
  clientInstanceId: string,
  descriptor: PresentationDescriptor | undefined,
  presentation: { descriptor: PresentationDescriptor; presentationEpoch: number } | undefined,
  /** FlowMap is on for the user (settings.get) and this scope collects. */
  observe = true,
): void {
  const ingest = trpc.flowMap.ingest.useMutation();
  const send = ingest.mutateAsync;
  const effectiveRevision = descriptor?.effectiveRevision;
  const workspaceFingerprint = descriptor?.workspaceFingerprint;
  const epoch = presentation?.presentationEpoch;
  useEffect(() => {
    if (!observe || !descriptor || !presentation || presentation.descriptor.effectiveRevision !== effectiveRevision || presentation.descriptor.workspaceFingerprint !== workspaceFingerprint) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("./collector").then(({ startFlowCollection }) => {
      const dispose = startFlowCollection({
        scope,
        descriptor,
        clientInstanceId,
        presentationEpoch: presentation.presentationEpoch,
        send: events => send({ events }),
      });
      if (cancelled) dispose();
      else stop = dispose;
    }).catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [observe, scope, descriptor, presentation, effectiveRevision, workspaceFingerprint, epoch, clientInstanceId, send]);
}
