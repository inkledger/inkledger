/**
 * Whose box has the keys. While the focus is in a framed module's view the
 * host names the module in a badge of its own, outside the frame and above
 * every module frame, so a login drawn in a module's box can't pass for the
 * app's. The host's own focus (document.activeElement) is the truth: events
 * only say when to read it again, and none of them can make it up.
 */

import { pageGestures } from "./gesture";

export type FocusedView = { moduleId: string; name: { en: string; it: string }; box: HTMLElement };

/** How often a named view is checked again (a badge left on is the one thing worse than late). */
const POLL_MS = 250;

export function createFocusBadge<V>(active: () => unknown) {
  const views = new WeakMap<object, V>();
  let now: { frame: object; view: V } | null = null;
  const listeners = new Set<() => void>();
  // The browser may move the focus without an event the page hears (or before activeElement follows): while a view is named, read it again.
  let poll: ReturnType<typeof setInterval> | null = null;
  const check = () => {
    const at = active();
    const view = typeof at === "object" && at !== null ? views.get(at) : undefined;
    const next = view !== undefined && typeof at === "object" && at !== null ? { frame: at, view } : null;
    if ((now?.frame ?? null) === (next?.frame ?? null)) return;
    now = next;
    if (now && !poll) poll = setInterval(check, POLL_MS);
    else if (!now && poll) {
      clearInterval(poll);
      poll = null;
    }
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

/** The page's: read again as the page's window loses the focus to a frame or gets it back; a frame that took it by itself is named by none. */
export function pageFocusBadge(): FocusBadge {
  if (page) return page;
  const gestures = pageGestures();
  const b = createFocusBadge<FocusedView>(() => {
    const at = document.activeElement;
    return at instanceof HTMLIFrameElement && !gestures.placedIn(at) ? null : at;
  });
  window.addEventListener("blur", b.check);
  window.addEventListener("focus", b.check);
  page = b;
  return b;
}

export const focusedView = (): FocusedView | null => page?.get() ?? null;
