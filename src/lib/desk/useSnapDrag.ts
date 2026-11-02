import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { moveTargets, paneId, PRESETS, sameTarget, slotRects, tracksOf, zoneAt, type DeskLayout, type PresetId, type Rect, type SnapTarget } from "@contracts/desk";
import { slotNames, targetName } from "@/lib/desk/targetName";
import { t } from "@/i18n";

/**
 * A pane being moved: which, and where it would land now (null: nowhere, it goes back). `places`:
 * the slots it is moved among (the panes, or one more for an issue dragged in from outside the
 * desk, `index` -1 then).
 */
export type SnapDrag = { id: string; key: string; index: number; target: SnapTarget | null; mode: "pointer" | "keyboard"; places: number };

/**
 * The drag in progress, kept out of React's state: only what draws it (the overlay, the grips)
 * listens, so moving the pointer never redraws the panes.
 */
export type SnapStore = { get: () => SnapDrag | null; set: (drag: SnapDrag | null) => void; subscribe: (listener: () => void) => () => void };

function createStore(): SnapStore {
  let drag: SnapDrag | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => drag,
    set: next => {
      drag = next;
      listeners.forEach(listener => listener());
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const useSnapState = (store: SnapStore) => useSyncExternalStore(store.subscribe, store.get, store.get);

/**
 * What a point of the window means over the desk drawn in `grid`: a slot of the snap bar
 * (`data-snap-preset` / `data-snap-slot`), an edge band, or the middle of another pane. `n` is
 * the number of places: the panes shown, or one more for an issue brought from outside
 * (`dragged` null), with `rects` where the panes are drawn now.
 */
export function snapTargetAt(x: number, y: number, grid: HTMLElement, n: number, rects: readonly Rect[], dragged: number | null): SnapTarget | null {
  const slot = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-snap-preset]");
  const preset = slot?.dataset.snapPreset as PresetId | undefined;
  if (slot && preset && PRESETS[preset]?.slots === n) return { kind: "slot", preset, slot: Number(slot.dataset.snapSlot) };
  const box = grid.getBoundingClientRect();
  if (x < box.left || x > box.right || y < box.top || y > box.bottom || !box.width || !box.height) return null;
  return zoneAt({ x: (x - box.left) / box.width, y: (y - box.top) / box.height }, n, rects, dragged);
}

type Options = {
  /** The desk's grid: edges and the panes' places are read on it. */
  grid: RefObject<HTMLElement | null>;
  desk: DeskLayout | undefined;
  /** The arrangement drawn (it may differ from the chosen one on a small desk). */
  drawn: PresetId;
  onDrop: (id: string, target: SnapTarget) => void;
  /** Says it in the desk's live region. */
  announce: (text: string) => void;
};

export type SnapHandle = {
  store: SnapStore;
  onPointerDown: (event: PointerEvent<HTMLElement>, id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, id: string) => void;
  onBlur: (id: string) => void;
};

const START_DISTANCE = 4;
const GHOST_MAX_WIDTH = 420;
const GHOST_GAP = 16;
const paneEl = (id: string) => document.getElementById(`desk-pane-${id}`);
const gripEl = (id: string) => document.querySelector<HTMLElement>(`[data-snap-grip="${CSS.escape(id)}"]`);

/**
 * Moving a pane on the desk by its grip, like a window snapped on a desktop: with a pointer (a
 * picture of its header follows; edges, corners, another pane's middle and the snap bar's slots
 * are targets) or with the keyboard (Space picks up, arrows go through every place, Enter drops,
 * Escape puts back). The pane moves once, on the drop; each target is said as it changes.
 */
export function useSnapDrag(options: Options): SnapHandle {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const [handle] = useState<SnapHandle>(() => {
    const store = createStore();
    const keysOf = (desk: DeskLayout) => slotNames(desk.panes);
    const say = (drag: SnapDrag, desk: DeskLayout) =>
      latest.current.announce(drag.target ? t("pages.desk.snap.target", { key: drag.key, target: targetName(drag.target, keysOf(desk)) }) : t("pages.desk.snap.nowhere", { key: drag.key }));
    const start = (id: string, mode: SnapDrag["mode"]): { drag: SnapDrag; desk: DeskLayout } | null => {
      const desk = latest.current.desk;
      const index = desk?.panes.findIndex(pane => paneId(pane) === id) ?? -1;
      if (!desk || index < 0 || desk.panes.length < 2) return null;
      paneEl(id)?.setAttribute("data-snap-dragging", "");
      const target: SnapTarget | null = mode === "keyboard" ? { kind: "slot", preset: desk.preset, slot: index } : null;
      return { drag: { id, key: keysOf(desk)[index], index, target, mode, places: desk.panes.length }, desk };
    };
    const end = (drag: SnapDrag, drop: boolean) => {
      paneEl(drag.id)?.removeAttribute("data-snap-dragging");
      store.set(null);
      const desk = latest.current.desk;
      if (drop && drag.target && desk) {
        latest.current.onDrop(drag.id, drag.target);
        latest.current.announce(t("pages.desk.snap.dropped", { key: drag.key, target: targetName(drag.target, keysOf(desk)) }));
        // The pane may have moved in the page: the focus stays on its grip.
        if (drag.mode === "keyboard") requestAnimationFrame(() => gripEl(drag.id)?.focus({ preventScroll: true }));
      } else latest.current.announce(t("pages.desk.snap.cancelled", { key: drag.key }));
    };

    const onPointerDown = (event: PointerEvent<HTMLElement>, id: string) => {
      if (event.button !== 0 || store.get()) return;
      const grip = event.currentTarget;
      const header = grip.closest("header");
      const origin = { x: event.clientX, y: event.clientY };
      let point = origin;
      let rects: Rect[] = [];
      let ghost: HTMLElement | null = null;
      let size = { w: 0, h: 0 };
      grip.focus({ preventScroll: true });
      try {
        grip.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks: the window listeners below still follow it.
      }

      const place = () => {
        const now = store.get();
        const grid = latest.current.grid.current;
        const desk = latest.current.desk;
        if (ghost) {
          // Beside the pointer, never over it (the name of the place sits under it), flipped near the window's edges.
          const x = point.x + GHOST_GAP + size.w > window.innerWidth ? point.x - GHOST_GAP - size.w : point.x + GHOST_GAP;
          const y = point.y + GHOST_GAP + size.h > window.innerHeight ? point.y - GHOST_GAP - size.h : point.y + GHOST_GAP;
          ghost.style.transform = `translate(${x}px, ${y}px)`;
        }
        if (!now || !grid || !desk) return;
        const target = snapTargetAt(point.x, point.y, grid, desk.panes.length, rects, now.index);
        if (sameTarget(target, now.target)) return;
        const next = { ...now, target };
        store.set(next);
        say(next, desk);
      };
      const begin = () => {
        const started = start(id, "pointer");
        if (!started) return false;
        const { desk } = started;
        const drawn = latest.current.drawn;
        rects = slotRects(drawn, tracksOf(desk, drawn));
        if (header) {
          // The picture that follows the pointer: a copy of the pane's header only, out of the page's flow and of its names.
          const box = header.getBoundingClientRect();
          size = { w: Math.min(box.width, GHOST_MAX_WIDTH), h: box.height };
          const copy = header.cloneNode(true) as HTMLElement;
          for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("[id], [data-snap-grip]")]) {
            element.removeAttribute("id");
            element.removeAttribute("data-snap-grip");
          }
          copy.setAttribute("aria-hidden", "true");
          copy.setAttribute("inert", "");
          copy.dataset.dragGhost = "";
          copy.classList.add("rounded-lg", "border", "shadow-sm", "opacity-95");
          Object.assign(copy.style, { position: "fixed", left: "0", top: "0", width: `${size.w}px`, pointerEvents: "none", zIndex: "60", margin: "0" });
          document.body.append(copy);
          ghost = copy;
        }
        document.documentElement.style.cursor = "grabbing";
        store.set(started.drag);
        return true;
      };
      const move = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        point = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!store.get()) {
          if (Math.hypot(point.x - origin.x, point.y - origin.y) < START_DISTANCE || !begin()) return;
        }
        place();
      };
      const finish = (drop: boolean) => {
        const drag = store.get();
        cleanup.current?.();
        if (drag?.mode === "pointer") end(drag, drop);
      };
      const up = (upEvent: globalThis.PointerEvent) => upEvent.pointerId === event.pointerId && finish(true);
      const cancel = (cancelEvent: globalThis.PointerEvent) => cancelEvent.pointerId === event.pointerId && finish(false);
      const key = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key !== "Escape" || !store.get()) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
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
        ghost?.remove();
        ghost = null;
        document.documentElement.style.cursor = "";
        cleanup.current = null;
      };
    };

    const onKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
      const now = store.get();
      const desk = latest.current.desk;
      if (!desk || event.altKey || event.metaKey || event.ctrlKey) return;
      if (!now) {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        const started = start(id, "keyboard");
        if (!started) return;
        store.set(started.drag);
        latest.current.announce(t("pages.desk.snap.picked", { key: started.drag.key }));
        return;
      }
      if (now.mode !== "keyboard" || now.id !== id) return;
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (step) {
        event.preventDefault();
        const targets = moveTargets(desk, now.index);
        if (!targets.length) return;
        const at = targets.findIndex(target => sameTarget(target, now.target));
        const next = { ...now, target: targets[(at + step + targets.length) % targets.length] };
        store.set(next);
        say(next, desk);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        end(now, true);
      } else if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        end(now, false);
      }
    };

    // The focus left the grip in the middle of a keyboard move (a click elsewhere): it goes back.
    const onBlur = (id: string) => {
      const now = store.get();
      if (now?.mode === "keyboard" && now.id === id) end(now, false);
    };

    return { store, onPointerDown, onKeyDown, onBlur };
  });
  return handle;
}
