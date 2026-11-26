// Clicks on a module's own shape, and only there. A module drawn over the
// page (the tree on the day timeline, a figure on the Dashboard) never takes
// pointer events: its box and everything in it stay `pointer-events: none`
// (ModuleHost), so the page under it keeps working (tap a gap, cut a gap).
// To be clickable it registers a hit area: the host listens once, in the
// capture phase, and takes a gesture only when it starts on the module's
// shape (its `test`, e.g. a picture's alpha). Anywhere else the events go on
// untouched to whatever lies under it.

import type { HitActivation, HitDrag } from "./hostV2";

/** Whether a point is on the module's shape: x, y from the element's top left (CSS px), and its size. */
export type HitTest = (x: number, y: number, width: number, height: number) => boolean;

type Area = { el: HTMLElement; test: HitTest; activate: (how: HitActivation) => void; drag?: (d: HitDrag) => void };

/**
 * A draggable shape ("drag"): a press that moves past DRAG_SLOP px, or is held DRAG_HOLD_MS, picks it up (a
 * touch: held TOUCH_HOLD_MS without moving, so a swipe still scrolls); less is a click.
 */
export const DRAG_SLOP = 6;
export const DRAG_HOLD_MS = 200;
export const TOUCH_HOLD_MS = 300;
/** Release speed measured over the last moves of this long (ms), at most DRAG_SPEED_MAX px/s. */
const SPEED_WINDOW_MS = 100;
const DRAG_SPEED_MAX = 4000;

/** While a shape is carried: what takes the pointer over the whole window (it ends the drag's hold on the page when called). */
export type DragLayer = (pointerId: number) => () => void;

/** A transparent layer over everything with the pointer captured: the drag reaches no page element, wherever it goes. */
const domLayer = (doc: Document): DragLayer => pointerId => {
  const el = doc.createElement("div");
  el.dataset.moduleDrag = "";
  Object.assign(el.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor: "grabbing", touchAction: "none", background: "transparent" });
  doc.body.append(el);
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // The pointer already went up: the window's listeners end the drag.
  }
  return () => el.remove();
};

/** Layers over the page: a point under one of these belongs to it, not to a module below. */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-slot="dialog-overlay"]';

/**
 * Page controls drawn over modules on purpose (the running timer's Pause and Stop, Play on the open hole: over
 * the tree at the timeline's start), marked `data-above-modules`: a point on one is the control's, even where
 * a module's shape lies under it, and the page's own chrome over an overlay (its header, banners). Not every control: a gap of the timeline is a button too, and a tap on the
 * tree over it is the tree's.
 */
const ABOVE_MODULES = "[data-above-modules]";

/**
 * The page's own layer (AppLayout, `isolate`): what is marked above modules inside it is above the modules
 * drawn in the page only. A module drawn over the whole window (a page overlay) is drawn
 * over it (the sticky header too): where its shape is, the point is its, but on a control (below).
 */
const PAGE_LAYER = "[data-page-layer]";

/** Over the whole window (a page overlay's box), every control of the app keeps its points: a creature there never takes a click meant for one. */
const PAGE_OVERLAY = "[data-page-overlay]";
const CONTROLS = "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable]:not([contenteditable=false])";

const POINTER_EVENTS = ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "click"] as const;

export function createHitAreas(win: Window = window, o: { layer?: DragLayer; frame?: (fn: () => void) => void } = {}) {
  const doc = win.document;
  const layer = o.layer ?? domLayer(doc);
  const frame = o.frame ?? (fn => void requestAnimationFrame(fn));
  const areas = new Set<Area>();
  /** When each element first took a shape: setting it again never makes it newer. */
  const born = new WeakMap<HTMLElement, number>();
  let births = 0;
  /** The area that owns the gesture under way (it started on its shape). */
  let owner: Area | null = null;
  let hovering = false;
  /** A press on a draggable shape, not yet a click or a drag. */
  let press: { area: Area; x: number; y: number; id: number; touch: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The shape being carried: the pointer's recent places, the move waiting for the next frame. */
  let drag: { area: Area; id: number; samples: { x: number; y: number; t: number }[]; next: { x: number; y: number } | null; release: () => void } | null = null;
  /** A drag just ended: the click its release makes is no click. */
  let swallowClick = false;

  const at = (x: number, y: number): Area | null => {
    // The oldest first: a module come later never takes the clicks of one already there.
    for (const a of [...areas].sort((p, q) => (born.get(p.el) ?? 0) - (born.get(q.el) ?? 0))) {
      if (!a.el.isConnected) continue;
      const r = a.el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || x < r.left || y < r.top || x >= r.right || y >= r.bottom) continue;
      // Something opened over the page here (a dialog, a menu): the point is its.
      const top = doc.elementFromPoint(x, y);
      if (top?.closest(OVERLAYS) && !a.el.closest(OVERLAYS)) continue;
      // A box drawn in the page's main region: the app's chrome outside it (the phone's header, the tab bar) keeps its points.
      const region = a.el.closest("main");
      if (region && top && !region.contains(top)) continue;
      // A control of the page is here, over the shape: it gets the gesture (the module's own buttons stay its).
      if (top && !a.el.contains(top) && top.closest(ABOVE_MODULES) && !(a.el.closest(PAGE_OVERLAY) && top.closest(PAGE_LAYER))) continue;
      if (top && !a.el.contains(top) && a.el.closest(PAGE_OVERLAY) && top.closest(CONTROLS)) continue;
      if (a.test(x - r.left, y - r.top, r.width, r.height)) return a;
    }
    return null;
  };

  const take = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const inBox = (a: Area, x: number, y: number) => {
    const r = a.el.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };
  const unpress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const pickUp = () => {
    const p = press;
    if (!p) return;
    unpress();
    owner = null;
    const release = layer(p.id);
    drag = { area: p.area, id: p.id, samples: [{ x: p.x, y: p.y, t: performance.now() }], next: null, release };
    listenDrag(true);
    p.area.drag?.({ phase: "start", ...inBox(p.area, p.x, p.y) });
  };
  /** The drag over: at its last place, with its speed (none when the person called it off: Esc, the window left). */
  const putDown = (thrown: boolean) => {
    const d = drag;
    if (!d) return;
    drag = null;
    listenDrag(false);
    d.release();
    const last = d.samples[d.samples.length - 1];
    const recent = d.samples.filter(s => last.t - s.t <= SPEED_WINDOW_MS);
    const first = recent[0];
    const dt = (last.t - first.t) / 1000;
    const speed = (a: number, b: number) => (thrown && dt > 0 ? Math.max(-DRAG_SPEED_MAX, Math.min(DRAG_SPEED_MAX, Math.round((b - a) / dt))) : 0);
    d.area.drag?.({ phase: "end", ...inBox(d.area, last.x, last.y), vx: speed(first.x, last.x), vy: speed(first.y, last.y) });
  };
  const onDragMove = (e: Event) => {
    const p = e as PointerEvent;
    const d = drag;
    if (!d || p.pointerId !== d.id) return;
    take(e);
    d.samples.push({ x: p.clientX, y: p.clientY, t: performance.now() });
    if (d.samples.length > 32) d.samples.shift();
    // One move a frame, the latest.
    if (d.next) return void (d.next = { x: p.clientX, y: p.clientY });
    d.next = { x: p.clientX, y: p.clientY };
    frame(() => {
      const n = drag === d ? d.next : null;
      d.next = null;
      if (n) d.area.drag?.({ phase: "move", ...inBox(d.area, n.x, n.y) });
    });
  };
  const onDragKey = (e: Event) => {
    if ((e as KeyboardEvent).key !== "Escape") return;
    take(e);
    putDown(false);
  };
  const onDragBlur = () => putDown(false);
  // A carried shape: the page under the finger never scrolls.
  const onTouchMove = (e: Event) => e.cancelable && e.preventDefault();
  const listenDrag = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    win[method]("pointermove", onDragMove, { capture: true });
    win[method]("keydown", onDragKey, { capture: true });
    win[method]("blur", onDragBlur);
    win[method]("touchmove", onTouchMove, { capture: true, passive: false });
  };

  const onPointer = (e: Event) => {
    const p = e as PointerEvent;
    if (drag) {
      // Carried: the release puts it down where it is, with its speed; the click it makes is swallowed.
      take(e);
      if (e.type === "pointerup" || e.type === "pointercancel") {
        swallowClick = true;
        putDown(e.type === "pointerup");
      }
      return;
    }
    if (e.type === "click" && swallowClick) {
      swallowClick = false;
      return take(e);
    }
    if (e.type === "pointerdown") swallowClick = false;
    if (e.type === "pointercancel") {
      // The browser took the gesture (a swipe that scrolls): nothing of the module's.
      unpress();
      owner = null;
      return;
    }
    if (e.type === "pointerdown" || (e.type === "mousedown" && !owner)) owner = at(p.clientX, p.clientY);
    if (!owner) return;
    if (e.type === "pointerdown" && owner.drag) {
      const touch = p.pointerType === "touch";
      unpress();
      press = { area: owner, x: p.clientX, y: p.clientY, id: p.pointerId, touch, timer: setTimeout(pickUp, touch ? TOUCH_HOLD_MS : DRAG_HOLD_MS) };
    }
    if (e.type === "pointerup") unpress();
    take(e);
    if (e.type === "click") {
      const a = owner;
      owner = null;
      const r = a.el.getBoundingClientRect();
      a.activate({ via: "pointer", x: p.clientX - r.left, y: p.clientY - r.top });
    }
  };

  const onMove = (e: Event) => {
    const p = e as PointerEvent;
    if (press && p.pointerId === press.id && Math.hypot(p.clientX - press.x, p.clientY - press.y) > DRAG_SLOP) {
      // Moved before the hold: a mouse picks it up, a finger is scrolling (the page has it).
      if (press.touch) {
        unpress();
        owner = null;
      } else pickUp();
    }
    if (p.pointerType !== "mouse") return;
    const on = at(p.clientX, p.clientY) !== null;
    if (on === hovering) return;
    hovering = on;
    doc.documentElement.classList.toggle("ikl-hit-cursor", on);
  };

  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    for (const type of POINTER_EVENTS) win[method](type, onPointer, { capture: true });
    win[method]("pointermove", onMove, { capture: true, passive: true });
  };

  return {
    /**
     * Makes `el`'s shape clickable and, unless `a11y.focusable` is false (a
     * framed module whose own control takes the keyboard), `el` a focusable
     * button named `a11y.label` that Enter/Space activate; `a11y.onFocus` hears it take and lose the
     * focus (`visible`: the keyboard's, :focus-visible). Returns the undo.
     */
    add(
      el: HTMLElement,
      test: HitTest,
      activate: (how: HitActivation) => void,
      a11y: { focusable: boolean; label?: string; onFocus?: (focused: boolean, visible: boolean) => void } = { focusable: true },
      /** "drag": the shape can be picked up and carried (`onDrag` hears where, in its box). */
      onDrag?: (d: HitDrag) => void,
    ): () => void {
      const area: Area = { el, test, activate, ...(onDrag ? { drag: onDrag } : {}) };
      if (!born.has(el)) born.set(el, births++);
      if (areas.size === 0) listen(true);
      areas.add(area);
      const hadTab = el.getAttribute("tabindex");
      const hadRole = el.getAttribute("role");
      const hadLabel = el.getAttribute("aria-label");
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        activate({ via: "keyboard" });
      };
      const onFocus = () => a11y.onFocus?.(true, el.matches?.(":focus-visible") ?? true);
      const onBlur = () => a11y.onFocus?.(false, false);
      if (a11y.focusable) {
        el.tabIndex = 0;
        if (!hadRole) el.setAttribute("role", "button");
        if (a11y.label) el.setAttribute("aria-label", a11y.label);
        el.addEventListener("keydown", onKey);
        el.addEventListener("focus", onFocus);
        el.addEventListener("blur", onBlur);
      }
      return () => {
        if (!areas.delete(area)) return;
        if (a11y.focusable) {
          el.removeEventListener("keydown", onKey);
          el.removeEventListener("focus", onFocus);
          el.removeEventListener("blur", onBlur);
          if (hadTab === null) el.removeAttribute("tabindex");
          else el.setAttribute("tabindex", hadTab);
          if (!hadRole) el.removeAttribute("role");
          if (a11y.label && hadLabel === null) el.removeAttribute("aria-label");
          else if (a11y.label && hadLabel !== null) el.setAttribute("aria-label", hadLabel);
        }
        if (owner === area) owner = null;
        if (press?.area === area) unpress();
        if (drag?.area === area) putDown(false);
        if (areas.size === 0) {
          listen(false);
          hovering = false;
          doc.documentElement.classList.remove("ikl-hit-cursor");
        }
      };
    },
  };
}

let shared: ReturnType<typeof createHitAreas> | null = null;

/** The page's hit areas (one set of listeners for every module). */
export const hitAreas = () => (shared ??= createHitAreas());
