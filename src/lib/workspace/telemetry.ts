import { useEffect, useLayoutEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import type { PresentationDescriptor, Scope } from "@contracts/workspace/model";
import { holdFlowClicks, type FlowClick } from "./flowClick";

/** Clicks held by a collection that ended before its code arrived (its layout changed meanwhile): the next one of the scope counts them. */
const carried = new Map<string, FlowClick[]>();

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
    // The collector's code arrives after the page: clicks meanwhile are held, not lost.
    const handOver = holdFlowClicks();
    const key = `${scope.surfaceId}:${scope.deviceClass}`;
    void import("./collector").then(({ startFlowCollection }) => {
      if (cancelled) return;
      const early = [...(carried.get(key) ?? []), ...handOver()];
      carried.delete(key);
      const dispose = startFlowCollection({
        scope,
        descriptor,
        clientInstanceId,
        presentationEpoch: presentation.presentationEpoch,
        send: events => send({ events }),
        early,
      });
      stop = dispose;
    }).catch(() => handOver());
    return () => {
      cancelled = true;
      const held = handOver();
      if (!observing.current) carried.delete(key);
      else if (!stop && held.length > 0) carried.set(key, [...(carried.get(key) ?? []), ...held].slice(-50));
      stop?.({ optedOut: !observing.current });
    };
  }, [observe, scope, descriptor, presentation, effectiveRevision, workspaceFingerprint, epoch, clientInstanceId, send]);
}
