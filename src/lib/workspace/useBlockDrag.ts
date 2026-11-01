import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { insertionIndex, type SketchAxis } from "./sketch";

/** A block being moved: where it came from, and where it would land now (index among the target's other blocks). */
export type BlockDrag = { anchorId: string; sourceAreaId: string; targetAreaId: string | null; index: number; mode: "pointer" | "keyboard" };

type Options = {
  /** The canvas: areas are `[data-drop-area]` inside it, blocks `[data-tile]` inside those. */
  root: RefObject<HTMLElement | null>;
  /** The areas in page order, with how each lines its blocks up (keyboard moves go through them in this order). */
  areas: readonly { areaId: string; axis: SketchAxis }[];
  /** How many blocks an area holds without the one being moved (keyboard moves stop at its ends). */
  countIn: (areaId: string, anchorId: string) => number;
  indexOf: (areaId: string, anchorId: string) => number;
  onDrop: (drag: BlockDrag) => void;
  announce: (drag: BlockDrag | null, what: "picked" | "moved" | "dropped" | "cancelled") => void;
};

const START_DISTANCE = 4;
const EDGE = 48;

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

/**
 * Moving blocks on the canvas with a pointer (mouse, pen or finger on the block's handle, which alone
 * stops the page from scrolling) or with the keyboard (Space picks up, arrows move, Enter drops, Escape
 * puts back). The block follows the pointer as a picture; the canvas draws where it would land.
 */
export function useBlockDrag({ root, areas, countIn, indexOf, onDrop, announce }: Options) {
  const [drag, setDrag] = useState<BlockDrag | null>(null);
  const current = useRef<BlockDrag | null>(null);
  const ghost = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const update = useCallback((next: BlockDrag | null) => {
    current.current = next;
    setDrag(next);
  }, []);
  useEffect(() => () => cleanup.current?.(), []);

  const axisOf = (areaId: string) => areas.find(area => area.areaId === areaId)?.axis ?? "column";

  const target = (x: number, y: number, anchorId: string): { areaId: string; index: number } | null => {
    const area = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-area]");
    if (!area || !root.current?.contains(area)) return null;
    const areaId = area.dataset.dropArea!;
    // Its own blocks only: an area drawn inside it (the rail beside the timeline) has its own.
    const rects = [...area.querySelectorAll<HTMLElement>("[data-tile]")]
      .filter(tile => tile.dataset.anchor !== anchorId && tile.closest("[data-drop-area]") === area)
      .map(tile => tile.getBoundingClientRect());
    return { areaId, index: insertionIndex(rects, { x, y }, axisOf(areaId)) };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>, anchorId: string, sourceAreaId: string) => {
    if (event.button !== 0 || current.current) return;
    const handle = event.currentTarget;
    const tile = handle.closest<HTMLElement>("[data-tile]");
    if (!tile) return;
    const start = { x: event.clientX, y: event.clientY };
    const box = tile.getBoundingClientRect();
    const offset = { x: start.x - box.left, y: start.y - box.top };
    const scroller = scrollParent(root.current);
    let started = false;
    let point = start;
    let frame = 0;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the window listeners below still follow it.
    }

    const place = () => {
      if (ghost.current) ghost.current.style.transform = `translate(${point.x - offset.x}px, ${point.y - offset.y}px)`;
      const next = target(point.x, point.y, anchorId);
      const now = current.current;
      if (now && (now.targetAreaId !== (next?.areaId ?? null) || now.index !== (next?.index ?? -1))) update({ ...now, targetAreaId: next?.areaId ?? null, index: next?.index ?? -1 });
    };
    // Near the scroller's edge the page scrolls by itself, so a far area can be reached in one move.
    const edgeScroll = () => {
      frame = 0;
      if (!started || !scroller) return;
      const bounds = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const step = point.y < bounds.top + EDGE ? -12 : point.y > bounds.bottom - EDGE ? 12 : 0;
      if (step === 0) return;
      scroller.scrollBy({ top: step });
      place();
      frame = requestAnimationFrame(edgeScroll);
    };
    const begin = () => {
      started = true;
      // The picture that follows the pointer: a copy of the block, out of the page's flow and of its names.
      const copy = tile.cloneNode(true) as HTMLElement;
      for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("[id], [data-anchor], [data-tile]")]) {
        element.removeAttribute("id");
        element.removeAttribute("data-anchor");
        element.removeAttribute("data-tile");
      }
      copy.setAttribute("aria-hidden", "true");
      copy.dataset.dragGhost = "";
      Object.assign(copy.style, { position: "fixed", left: "0", top: "0", width: `${box.width}px`, pointerEvents: "none", zIndex: "60", margin: "0" });
      document.body.append(copy);
      ghost.current = copy;
      const next: BlockDrag = { anchorId, sourceAreaId, targetAreaId: sourceAreaId, index: indexOf(sourceAreaId, anchorId), mode: "pointer" };
      update(next);
      announce(next, "picked");
      place();
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!started && Math.hypot(point.x - start.x, point.y - start.y) < START_DISTANCE) return;
      if (!started) begin();
      place();
      if (!frame) frame = requestAnimationFrame(edgeScroll);
    };
    const finish = (drop: boolean) => {
      const last = current.current;
      cleanup.current?.();
      if (!started || !last) return;
      update(null);
      if (drop && last.targetAreaId) {
        onDrop(last);
        announce(last, "dropped");
      } else announce(last, "cancelled");
    };
    const up = (upEvent: globalThis.PointerEvent) => { if (upEvent.pointerId === event.pointerId) finish(true); };
    const cancel = (cancelEvent: globalThis.PointerEvent) => { if (cancelEvent.pointerId === event.pointerId) finish(false); };
    const key = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      if (frame) cancelAnimationFrame(frame);
      ghost.current?.remove();
      ghost.current = null;
      cleanup.current = null;
    };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, anchorId: string, sourceAreaId: string) => {
    const now = current.current;
    if (!now) {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      const next: BlockDrag = { anchorId, sourceAreaId, targetAreaId: sourceAreaId, index: indexOf(sourceAreaId, anchorId), mode: "keyboard" };
      update(next);
      announce(next, "picked");
      return;
    }
    if (now.mode !== "keyboard" || now.anchorId !== anchorId) return;
    const position = areas.findIndex(area => area.areaId === now.targetAreaId);
    const step = (direction: -1 | 1) => {
      const areaId = now.targetAreaId ?? sourceAreaId;
      const index = now.index + direction;
      if (index >= 0 && index <= countIn(areaId, anchorId)) return { ...now, index };
      // Past an area's end: on into the next area, at its start (or back into the previous one, at its end).
      const neighbour = areas[position + direction];
      if (!neighbour) return now;
      return { ...now, targetAreaId: neighbour.areaId, index: direction > 0 ? 0 : countIn(neighbour.areaId, anchorId) };
    };
    let next: BlockDrag | null = now;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = step(-1);
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") next = step(1);
    else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      update(null);
      onDrop(now);
      announce(now, "dropped");
      return;
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      update(null);
      announce(now, "cancelled");
      return;
    } else return;
    event.preventDefault();
    if (next !== now) {
      update(next);
      announce(next, "moved");
    }
  };

  return { drag, onPointerDown, onKeyDown };
}
