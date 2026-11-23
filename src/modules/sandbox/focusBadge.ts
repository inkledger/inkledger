/**
 * Whose box has the keys. While the focus is in a framed module's view the
 * host names the module in a badge of its own, outside the frame and above
 * every module frame, so a login drawn in a module's box can't pass for the
 * app's. The host's own focus (document.activeElement) is the truth: events
 * only say when to read it again, and none of them can make it up.
 */

export type FocusedView = { moduleId: string; name: { en: string; it: string }; box: HTMLElement };

export function createFocusBadge<V>(active: () => unknown) {
  const views = new WeakMap<object, V>();
  let now: { frame: object; view: V } | null = null;
  const listeners = new Set<() => void>();
  const check = () => {
    const at = active();
    const view = typeof at === "object" && at !== null ? views.get(at) : undefined;
    const next = view !== undefined && typeof at === "object" && at !== null ? { frame: at, view } : null;
    if ((now?.frame ?? null) === (next?.frame ?? null)) return;
    now = next;
    listeners.forEach(l => l());
  };
  return {
    /** A view frame on the page; returns its leave (a parked frame may still hold the focus). */
    add(frame: object, view: V) {
      views.set(frame, view);
      check();
      return () => {
        views.delete(frame);
        check();
      };
    },
    check,
    /** The view the focus is in, the same object until it moves. */
    get: (): V | null => now?.view ?? null,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export type FocusBadge = ReturnType<typeof createFocusBadge<FocusedView>>;

let page: FocusBadge | null = null;

/** The page's: read again as the page's window loses the focus to a frame or gets it back. */
export function pageFocusBadge(): FocusBadge {
  if (page) return page;
  const b = createFocusBadge<FocusedView>(() => document.activeElement);
  window.addEventListener("blur", b.check);
  window.addEventListener("focus", b.check);
  page = b;
  return b;
}

export const focusedView = (): FocusedView | null => page?.get() ?? null;
