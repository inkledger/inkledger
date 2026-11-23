// Clicks on a module's own shape, and only there. A module drawn over the
// page (the tree on the day timeline, a figure on the Dashboard) never takes
// pointer events: its box and everything in it stay `pointer-events: none`
// (ModuleHost), so the page under it keeps working (tap a gap, cut a gap).
// To be clickable it registers a hit area: the host listens once, in the
// capture phase, and takes a gesture only when it starts on the module's
// shape (its `test`, e.g. a picture's alpha). Anywhere else the events go on
// untouched to whatever lies under it.

import type { HitActivation } from "./hostV2";

/** Whether a point is on the module's shape: x, y from the element's top left (CSS px), and its size. */
export type HitTest = (x: number, y: number, width: number, height: number) => boolean;

type Area = { el: HTMLElement; test: HitTest; activate: (how: HitActivation) => void };

/** Layers over the page: a point under one of these belongs to it, not to a module below. */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

/**
 * Page controls drawn over modules on purpose (the running timer's Pause and Stop, Play on the open hole: over
 * the tree at the timeline's start), marked `data-above-modules`: a point on one is the control's, even where
 * a module's shape lies under it, and the page's own chrome over an overlay (its header, banners). Not every control: a gap of the timeline is a button too, and a tap on the
 * tree over it is the tree's.
 */
const ABOVE_MODULES = "[data-above-modules]";

/** Over the whole window (a page overlay's box), every control of the app keeps its points: a creature there never takes a click meant for one. */
const PAGE_OVERLAY = "[data-page-overlay]";
const CONTROLS = "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable]:not([contenteditable=false])";

const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"] as const;

export function createHitAreas(win: Window = window) {
  const doc = win.document;
  const areas = new Set<Area>();
  /** When each element first took a shape: setting it again never makes it newer. */
  const born = new WeakMap<HTMLElement, number>();
  let births = 0;
  /** The area that owns the gesture under way (it started on its shape). */
  let owner: Area | null = null;
  let hovering = false;

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
      if (top && !a.el.contains(top) && top.closest(ABOVE_MODULES)) continue;
      if (top && !a.el.contains(top) && a.el.closest(PAGE_OVERLAY) && top.closest(CONTROLS)) continue;
      if (a.test(x - r.left, y - r.top, r.width, r.height)) return a;
    }
    return null;
  };

  const take = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onPointer = (e: Event) => {
    const p = e as MouseEvent;
    if (e.type === "pointerdown" || (e.type === "mousedown" && !owner)) owner = at(p.clientX, p.clientY);
    if (!owner) return;
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
    ): () => void {
      const area: Area = { el, test, activate };
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
