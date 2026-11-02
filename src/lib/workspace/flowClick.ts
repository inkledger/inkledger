import type { FlowModality } from "@contracts/workspace/flowMap";

/** A click on a control FlowMap counts, read when it happens: the block may move or go right after. */
export type FlowClick = {
  controlId: string;
  clientX: number;
  clientY: number;
  /** The block the control sits in, where the click's spot is measured. */
  block: { left: number; top: number; width: number; height: number };
  modality: FlowModality;
  /** The page it was made on: a navigation is known by the page that follows. */
  path: string;
};

export function flowClickOf(event: MouseEvent): FlowClick | null {
  if (!(event.target instanceof Element)) return null;
  const element = event.target.closest("[data-workspace-control]");
  const controlId = element?.getAttribute("data-workspace-control");
  if (!element || !controlId) return null;
  // A control carries its block's name too: the block is the nearest marked element above it.
  const block = element.parentElement?.closest("[data-workspace-anchor]:not([data-workspace-control])") ?? element;
  const { left, top, width, height } = block.getBoundingClientRect();
  const pointerType = "pointerType" in event ? event.pointerType : undefined;
  const modality: FlowModality = event.detail === 0 ? "keyboard" : pointerType === "touch" ? "touch" : pointerType ? "pointer" : "unknown";
  return { controlId, clientX: event.clientX, clientY: event.clientY, block: { left, top, width, height }, modality, path: location.pathname };
}

/** Holds the clicks made while the collector's code is still loading; the returned function stops and hands them over. */
export function holdFlowClicks(): () => FlowClick[] {
  const clicks: FlowClick[] = [];
  const listener = (event: MouseEvent) => {
    const click = flowClickOf(event);
    if (click && clicks.length < 50) clicks.push(click);
  };
  document.addEventListener("click", listener, true);
  return () => {
    document.removeEventListener("click", listener, true);
    return clicks;
  };
}
