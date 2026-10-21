// Clicks on a module's own shape, and only there. A module drawn over the
// page (the tree on the day timeline, a figure on the Dashboard) never takes
// pointer events: its box and everything in it stay `pointer-events: none`
// (ModuleHost), so the page under it keeps working (tap a gap, cut a gap).
// To be clickable it registers a hit area: the host listens once, in the
// capture phase, and takes a gesture only when it starts on the module's
// shape (its `test`, e.g. a picture's alpha). Anywhere else the events go on
// untouched to whatever lies under it.

/** Whether a point is on the module's shape: x, y from the element's top left (CSS px), and its size. */
export type HitTest = (x: number, y: number, width: number, height: number) => boolean;

type Area = { el: HTMLElement; test: HitTest; activate: () => void };

/** Layers over the page: a point under one of these belongs to it, not to a module below. */
const OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"] as const;

export function createHitAreas(win: Window = window) {
  const doc = win.document;
  const areas = new Set<Area>();
  /** The area that owns the gesture under way (it started on its shape). */
  let owner: Area | null = null;
  let hovering = false;

  const at = (x: number, y: number): Area | null => {
    // The newest first: a module registered later is drawn over an older one.
    for (const a of [...areas].reverse()) {
      if (!a.el.isConnected) continue;
      const r = a.el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || x < r.left || y < r.top || x >= r.right || y >= r.bottom) continue;
      // Something opened over the page here (a dialog, a menu): the point is its.
      const top = doc.elementFromPoint(x, y);
      if (top?.closest(OVERLAYS) && !a.el.closest(OVERLAYS)) continue;
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
      a.activate();
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
    /** Makes `el`'s shape clickable (and `el` focusable, Enter/Space activate). Returns the undo. */
    add(el: HTMLElement, test: HitTest, activate: () => void): () => void {
      const area: Area = { el, test, activate };
      if (areas.size === 0) listen(true);
      areas.add(area);
      const hadTab = el.getAttribute("tabindex");
      const hadRole = el.getAttribute("role");
      el.tabIndex = 0;
      if (!hadRole) el.setAttribute("role", "button");
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        activate();
      };
      el.addEventListener("keydown", onKey);
      return () => {
        if (!areas.delete(area)) return;
        el.removeEventListener("keydown", onKey);
        if (hadTab === null) el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", hadTab);
        if (!hadRole) el.removeAttribute("role");
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
