/**
 * Whose gesture it was. A framed module's dialog, share, download, picture or
 * position needs the person's gesture, and the browser's activation alone
 * can't say whose: any click or key on the app, or in another module's frame,
 * activates the page. The page sees nothing of a pointer inside a frame, and
 * a frame may take the focus by itself, so the host keeps what it can trust:
 * a gesture on the app itself, a module's host box activated (its hit area),
 * and what the frame's bootstrap saw (a real pointer down or key, told over a
 * port the module's code never gets). A key counts only in a frame the person
 * moved into by Tab (a frame that took the focus by itself gets the keys
 * typed for the app). A runtime frame, which the person can't touch, gets none.
 */

/** How long a gesture still counts: the browser's own window for its activation. */
export const GESTURE_MS = 5000;

export type OwnGesture = "pointer" | "key";

export function createGestures(env: { now(): number; active(): boolean }) {
  let appAt = -Infinity;
  let tabAt = -Infinity;
  const boxAt = new WeakMap<object, number>();
  const ownAt = new WeakMap<object, { kind: OwnGesture; at: number }>();
  const tabbedInto = new WeakSet<object>();
  return {
    /** A pointer down or a key on the app's own page. */
    app() {
      appAt = env.now();
    },
    /** Tab on the app: the focus moving into a frame next is the keyboard's. */
    tab() {
      tabAt = env.now();
    },
    /** A module's host box activated (its hit area clicked, Enter on it): an act on the app for every other one. */
    box(el: object) {
      appAt = env.now();
      boxAt.set(el, appAt);
    },
    /** The focus went from the app into a frame: by Tab, or by a click or tap there, or the frame took it. */
    focusIn(frame: object) {
      if (env.now() - tabAt <= 1000) tabbedInto.add(frame);
      else tabbedInto.delete(frame);
    },
    /** A real gesture inside a frame, as its bootstrap saw it. */
    own(frame: object, kind: OwnGesture) {
      ownAt.set(frame, { kind, at: env.now() });
    },
    /** Whether the person's latest gesture was in this view: its host box, or its frame (`focused`: it has the focus now). */
    has(frame: object, box: object, focused: boolean): boolean {
      if (!env.active()) return false;
      const t = env.now();
      const b = boxAt.get(box);
      if (b !== undefined && b >= appAt && t - b <= GESTURE_MS) return true;
      const g = ownAt.get(frame);
      if (!g || g.at < appAt || t - g.at > GESTURE_MS) return false;
      return g.kind === "pointer" || (focused && tabbedInto.has(frame));
    },
  };
}

export type Gestures = ReturnType<typeof createGestures>;

let page: Gestures | null = null;

/** The page's: listens once, in the capture phase, passive. */
export function pageGestures(): Gestures {
  if (page) return page;
  const g = createGestures({ now: () => performance.now(), active: () => navigator.userActivation?.isActive === true });
  const opts = { capture: true, passive: true };
  document.addEventListener("pointerdown", () => g.app(), opts);
  document.addEventListener(
    "keydown",
    e => {
      g.app();
      if (e.key === "Tab") g.tab();
    },
    opts,
  );
  // The page's window loses the focus to one of its frames (no event reaches the iframe element itself).
  window.addEventListener("blur", () => {
    const at = document.activeElement;
    if (at instanceof HTMLIFrameElement && at.dataset.moduleFrame === "view") g.focusIn(at);
  });
  page = g;
  return g;
}
