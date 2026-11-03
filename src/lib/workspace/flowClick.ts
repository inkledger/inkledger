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
  const pointerType = "pointerType" in event ? event.pointerType : undefined;
  const modality: FlowModality = event.detail === 0 ? "keyboard" : pointerType === "touch" ? "touch" : pointerType ? "pointer" : "unknown";
  return { controlId, clientX: event.clientX, clientY: event.clientY, block: visiblePart(block.getBoundingClientRect()), modality, path: location.pathname };
}

/**
 * What of a block is on screen: a spot measured on a table ten screens tall would only say which
 * row band it was. The whole rect where the screen size is unknown.
 */
function visiblePart(rect: { left: number; top: number; width: number; height: number }): FlowClick["block"] {
  const screenWidth = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : Infinity;
  const screenHeight = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : Infinity;
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.left + rect.width, screenWidth);
  const bottom = Math.min(rect.top + rect.height, screenHeight);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Tells FlowMap a control was used from the keyboard (a hotkey): the click it stands for. */
export function emitFlowKey(controlId: string | undefined): void {
  if (!controlId) return;
  window.dispatchEvent(new CustomEvent("workspace:key", { detail: { controlId, path: location.pathname } }));
}

/** The control a key press stood for, as a click read from the keyboard (no spot in a block). */
export function flowKeyOf(event: Event): FlowClick | null {
  const detail = (event as CustomEvent<{ controlId?: string; path?: string } | undefined>).detail;
  if (!detail?.controlId) return null;
  return { controlId: detail.controlId, clientX: 0, clientY: 0, block: { left: 0, top: 0, width: 0, height: 0 }, modality: "keyboard", path: detail.path ?? location.pathname };
}

/** Holds the clicks made while the collector's code is still loading; the returned function stops and hands them over. */
export function holdFlowClicks(): () => FlowClick[] {
  const clicks: FlowClick[] = [];
  const listener = (event: MouseEvent) => {
    const click = flowClickOf(event);
    if (click && clicks.length < 50) clicks.push(click);
  };
  const key = (event: Event) => {
    const read = flowKeyOf(event);
    if (read && clicks.length < 50) clicks.push(read);
  };
  document.addEventListener("click", listener, true);
  window.addEventListener("workspace:key", key);
  return () => {
    document.removeEventListener("click", listener, true);
    window.removeEventListener("workspace:key", key);
    return clicks;
  };
}
