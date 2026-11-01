import { useEffect, useLayoutEffect, useRef } from "react";
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
  // Read by the cleanup: a collection that ends because FlowMap was turned off sends nothing more.
  // A layout effect, so it is current before the passive cleanup below runs.
  const observing = useRef(observe);
  useLayoutEffect(() => {
    observing.current = observe;
  }, [observe]);
  useEffect(() => {
    if (!observe || !descriptor || !presentation || presentation.descriptor.effectiveRevision !== effectiveRevision || presentation.descriptor.workspaceFingerprint !== workspaceFingerprint) return;
    let cancelled = false;
    let stop: ((options?: { optedOut?: boolean }) => void) | undefined;
    void import("./collector").then(({ startFlowCollection }) => {
      const dispose = startFlowCollection({
        scope,
        descriptor,
        clientInstanceId,
        presentationEpoch: presentation.presentationEpoch,
        send: events => send({ events }),
      });
      if (cancelled) dispose({ optedOut: !observing.current });
      else stop = dispose;
    }).catch(() => {});
    return () => {
      cancelled = true;
      stop?.({ optedOut: !observing.current });
    };
  }, [observe, scope, descriptor, presentation, effectiveRevision, workspaceFingerprint, epoch, clientInstanceId, send]);
}
