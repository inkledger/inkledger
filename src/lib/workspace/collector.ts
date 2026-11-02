import superjson from "superjson";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import type { FlowEvent, FlowModality } from "@contracts/workspace/flowMap";
import type { PresentationDescriptor, Scope } from "@contracts/workspace/model";
import { workspaceMutationPath } from "./instrumentation";

export type FlowCollectionOptions = {
  scope: Scope;
  descriptor: PresentationDescriptor;
  clientInstanceId: string;
  presentationEpoch: number;
  activationId?: string;
  send: (events: FlowEvent[]) => Promise<unknown>;
};

function flowCell(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    x: Math.max(0, Math.min(7, Math.floor((clientX - rect.left) / rect.width * 8))),
    y: Math.max(0, Math.min(7, Math.floor((clientY - rect.top) / rect.height * 8))),
  };
}

export function startFlowCollection(options: FlowCollectionOptions): (stop?: { optedOut?: boolean }) => void {
  const { scope, descriptor, clientInstanceId, presentationEpoch, activationId, send } = options;
  let queue: FlowEvent[] = [];
  let sequence = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let stopped = false;
  let sessionId = crypto.randomUUID();
  let surfaceSeen = false;
  let lastAction: { controlId: string; semanticRevision: number; at: number } | undefined;
  let modality: FlowModality = "unknown";
  const exposed = new Set<string>();
  const pendingExposures = new Map<Element, ReturnType<typeof setTimeout>>();
  const anchors = new Map(CATALOG_V1.anchors.filter(anchor => anchor.surfaceId === scope.surfaceId).map(anchor => [anchor.id, anchor]));
  const controls = new Map(CATALOG_V1.controls.filter(control => anchors.has(control.anchorId) && !control.sensitive && control.interactions.some(item => item.telemetry === "allowed")).map(control => [control.id, control]));

  const schedule = () => {
    if (timer || sending || stopped || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 30_000);
  };
  const clearSchedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const push = (kind: FlowEvent["kind"], controlId?: string, anchorId?: string, semanticRevision = 1, cell?: FlowEvent["cell"], durationMs?: number, destinationControlId?: string) => {
    if (stopped) return;
    if (!surfaceSeen) {
      surfaceSeen = true;
      push("surface.view");
    }
    if (queue.length >= 500) {
      queue.shift();
      dropped++;
    }
    queue.push({
      eventSchemaVersion: 1,
      id: crypto.randomUUID(),
      kind,
      scope,
      ...(controlId ? { controlId } : {}),
      ...(anchorId ? { anchorId } : {}),
      ...(destinationControlId ? { destinationControlId } : {}),
      semanticRevision,
      descriptor,
      clientInstanceId,
      presentationEpoch,
      ...(activationId ? { activationId } : {}),
      sessionId,
      sequence: ++sequence,
      occurredAt: Date.now(),
      ...(durationMs !== undefined ? { durationMs } : {}),
      modality,
      ...(cell ? { cell } : {}),
      ...(dropped > 0 ? { droppedBefore: dropped } : {}),
    });
    dropped = 0;
    if (queue.length >= 50 || JSON.stringify(queue).length >= 32_000) void flush();
    else schedule();
  };
  const takeBatch = () => {
    const batch = queue.slice(0, 50);
    while (batch.length > 1 && JSON.stringify(batch).length > 32_000) batch.pop();
    queue = queue.slice(batch.length);
    return batch;
  };
  const flush = async () => {
    if (sending || stopped || queue.length === 0) return;
    clearSchedule();
    sending = true;
    const batch = takeBatch();
    try {
      await send(batch);
    } catch {
      const retry = new Map([...batch, ...queue].map(event => [event.id, event]));
      dropped += Math.max(0, retry.size - 500);
      queue = [...retry.values()].slice(-500);
    } finally {
      sending = false;
      schedule();
    }
  };
  const beacon = () => {
    if (stopped || queue.length === 0) return;
    clearSchedule();
    while (queue.length > 0) {
      const batch = takeBatch();
      const body = new Blob([superjson.stringify({ events: batch })], { type: "application/json" });
      if (!navigator.sendBeacon("/api/trpc/flowMap.ingest", body)) {
        queue = [...batch, ...queue].slice(-500);
        break;
      }
    }
  };
  const pointer = (event: PointerEvent) => {
    modality = event.pointerType === "touch" ? "touch" : "pointer";
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") modality = "keyboard";
  };
  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest("[data-workspace-control]");
    const controlId = element?.getAttribute("data-workspace-control");
    const control = controlId ? controls.get(controlId) : undefined;
    if (!element || !control) return;
    if (event.detail === 0) modality = "keyboard";
    const anchor = element.closest("[data-workspace-anchor]") ?? element;
    const cell = modality === "pointer" ? flowCell(event.clientX, event.clientY, anchor.getBoundingClientRect()) : undefined;
    push("control.activate", control.id, control.anchorId, control.semanticRevision, cell);
    lastAction = control.kind === "mutation" ? { controlId: control.id, semanticRevision: control.semanticRevision, at: Date.now() } : undefined;
    if (control.kind === "navigation") {
      const from = location.pathname;
      requestAnimationFrame(() => {
        if (location.pathname !== from) push("navigation.completed", control.id, control.anchorId, control.semanticRevision);
      });
    }
  };
  const mutationResult = (event: Event) => {
    const detail = (event as CustomEvent<{ path: string; succeeded: boolean }>).detail;
    const action = lastAction;
    // Only the action's own mutation settles it: a FlowMap flush or a settings save finishing first does not.
    if (!action || !detail || !workspaceMutationPath(action.controlId)?.includes(detail.path)) return;
    lastAction = undefined;
    if (Date.now() - action.at > 15_000) return;
    const control = controls.get(action.controlId);
    if (control) push(detail.succeeded ? "action.succeeded" : "action.failed", action.controlId, control.anchorId, action.semanticRevision);
  };
  const cancelExposure = (element: Element) => {
    const timeout = pendingExposures.get(element);
    if (timeout) clearTimeout(timeout);
    pendingExposures.delete(element);
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const anchorId = (entry.target as HTMLElement).dataset.workspaceAnchor;
      const anchor = anchorId ? anchors.get(anchorId) : undefined;
      if (!anchor) continue;
      cancelExposure(entry.target);
      if (!entry.isIntersecting || entry.intersectionRatio < 0.5 || document.hidden || exposed.has(anchor.id)) continue;
      const startedAt = Date.now();
      pendingExposures.set(entry.target, setTimeout(() => {
        pendingExposures.delete(entry.target);
        if (document.hidden || exposed.has(anchor.id)) return;
        exposed.add(anchor.id);
        observer.unobserve(entry.target);
        push("anchor.exposure", undefined, anchor.id, anchor.semanticRevision, undefined, Date.now() - startedAt);
      }, 1_000));
    }
  }, { threshold: [0, 0.5, 1] });
  const observeAnchors = () => {
    for (const element of document.querySelectorAll("[data-workspace-anchor]")) {
      const id = (element as HTMLElement).dataset.workspaceAnchor;
      if (id && anchors.has(id) && !exposed.has(id)) observer.observe(element);
    }
  };
  const visibility = () => {
    if (document.hidden) {
      for (const element of pendingExposures.keys()) cancelExposure(element);
      beacon();
    } else {
      sessionId = crypto.randomUUID();
      exposed.clear();
      observeAnchors();
    }
  };
  const search = (event: Event) => {
    const detail = (event as CustomEvent<{ kind: string; destinationControlId?: string }>).detail;
    if (!detail || !["search.opened", "search.selected", "search.abandoned"].includes(detail.kind)) return;
    const kind = detail.kind as "search.opened" | "search.selected" | "search.abandoned";
    const controlId = kind === "search.selected" ? "shell.search.select" : "shell.search.open";
    const control = controls.get(controlId);
    if (control) push(kind, control.id, control.anchorId, control.semanticRevision, undefined, undefined, detail.destinationControlId);
  };
  const pageHide = () => beacon();
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", keyboard, true);
  document.addEventListener("click", click, true);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("workspace:search", search);
  window.addEventListener("workspace:mutation-result", mutationResult);
  window.addEventListener("pagehide", pageHide);
  observeAnchors();
  const mutations = new MutationObserver(observeAnchors);
  mutations.observe(document.body, { childList: true, subtree: true });
  return ({ optedOut = false } = {}) => {
    // What was collected still goes when the page or layout changes; after an opt-out not even a request leaves.
    if (!optedOut) beacon();
    stopped = true;
    clearSchedule();
    observer.disconnect();
    mutations.disconnect();
    for (const element of pendingExposures.keys()) cancelExposure(element);
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", keyboard, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("workspace:search", search);
    window.removeEventListener("workspace:mutation-result", mutationResult);
    window.removeEventListener("pagehide", pageHide);
    queue = [];
  };
}
