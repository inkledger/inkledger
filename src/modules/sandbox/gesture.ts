/**
 * Whose gesture it was. A framed module's dialog, share, download, picture or
 * position needs the person's gesture, and the browser's activation alone
 * can't say whose: any click or key on the app, or in another module's frame,
 * activates the page. The page sees nothing of a pointer inside a frame, and
 * a frame may take the focus by itself, so the host keeps what it can trust:
 * a gesture on the app itself, a module's host box activated (its hit area),
 * and what the frame's bootstrap saw (a real pointer down or key, told over a
 * port the module's code never gets). A key counts only in a frame the person
 * put the focus in (Tab, a click there, or the host's own focus, as a sheet
 * opens): a frame that took the focus by itself gets the keys typed for the
 * app. A runtime frame, which the person can't touch, gets none.
 */

/**
 * How long a gesture still counts for what follows it (a sheet, the settings, the position): the
 * browser's own transient activation. Only ever this module's own gesture, so a wider window gives
 * nothing to another module; a busy page delays a call past one second.
 */
export const GESTURE_MS = 5000;
/** For a picture to share, save or open: the module draws it first (the browser's own window for its activation). */
export const PICTURE_GESTURE_MS = 5000;

export type OwnGesture = "pointer" | "key";
/** What a frame's bootstrap tells: a gesture, or Tab (a key that also moves the focus on). */
export type OwnReport = OwnGesture | "tab";

export function createGestures(env: { now(): number; active(): boolean }) {
  let appAt = -Infinity;
  let tabAt = -Infinity;
  const boxAt = new WeakMap<object, number>();
  const pointerAt = new WeakMap<object, number>();
  const keyAt = new WeakMap<object, number>();
  /** Frames whose focus the person (or the host) put there. */
  const placed = new WeakSet<object>();
  const hostAt = new WeakMap<object, number>();
  /** Tab in a frame the person put the focus in (the focus moves on to the next), and which. */
  let anyKeyAt = -Infinity;
  let keyFrame: object | null = null;
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
    /** The focus went from the app into a frame: by Tab, by a click or tap there (its pointer down comes just before or after), or the frame took it. */
    focusIn(frame: object) {
      const t = env.now();
      const p = pointerAt.get(frame) ?? -Infinity;
      if (t - tabAt <= 1000 || (p >= appAt && t - p <= 1000)) placed.add(frame);
      else placed.delete(frame);
    },
    /** The host itself focused the frame (a sheet opening, the focus handed back to its opener). */
    hostFocus(frame: object) {
      placed.add(frame);
      hostAt.set(frame, env.now());
    },
    /** The frame's window took the focus (its bootstrap told): whether by Tab, a pointer there or the host; else it reached for it itself. */
    tookFocus(frame: object): boolean {
      const t = env.now();
      const p = pointerAt.get(frame) ?? -Infinity;
      const ok = t - tabAt <= 1000 || (t - anyKeyAt <= 1000 && keyFrame !== frame) || t - (hostAt.get(frame) ?? -Infinity) <= 1000 || (p >= appAt && t - p <= 1000);
      if (ok) placed.add(frame);
      else placed.delete(frame);
      return ok;
    },
    /** Whether the focus in this frame is the person's (or the host's) doing, as last judged. */
    placedIn: (frame: object) => placed.has(frame),
    /** A real gesture inside a frame, as its bootstrap saw it. */
    own(frame: object, kind: OwnReport) {
      (kind === "pointer" ? pointerAt : keyAt).set(frame, env.now());
      if (kind === "pointer") placed.add(frame);
      else if (kind === "tab" && placed.has(frame)) {
        anyKeyAt = env.now();
        keyFrame = frame;
      }
    },
    /** Whether the person's latest gesture, within `ms`, was in this view: its host box, or its frame (`focused`: it has the focus now). */
    has(frame: object, box: object, focused: boolean, ms = GESTURE_MS): boolean {
      if (!env.active()) return false;
      const t = env.now();
      const fresh = (at: number | undefined) => at !== undefined && at >= appAt && t - at <= ms;
      return fresh(boxAt.get(box)) || fresh(pointerAt.get(frame)) || (focused && placed.has(frame) && fresh(keyAt.get(frame)));
    },
  };
}

export type Gestures = ReturnType<typeof createGestures>;

/**
 * A view's own port, host end: its bootstrap's reports, counted. The frame's
 * calls ride the window and the reports this port, which keep no order between
 * them: a call made at once after a gesture is held (at most `GESTURE_MS`)
 * until the reports it follows have arrived.
 */
export function ownReports(onReport: (kind: OwnReport) => void, onFocus?: () => void) {
  const ch = new MessageChannel();
  let seen = 0;
  const waiting = new Set<{ g: number; done: () => void }>();
  ch.port1.onmessage = (e: MessageEvent<unknown>) => {
    const kind = e.data;
    // Its window took the focus: no gesture (not counted), only when to read where the focus is.
    if (kind === "focus") return onFocus?.();
    if (kind !== "pointer" && kind !== "key" && kind !== "tab") return;
    seen++;
    onReport(kind);
    for (const w of waiting) if (seen >= w.g) w.done();
  };
  return {
    /** Handed to the bootstrap, before init. */
    port: ch.port2,
    /** Null once the `g`-th report is in; else a wait for it (a frame's made-up count only holds its own call). */
    settle(g: number): Promise<void> | null {
      if (seen >= g) return null;
      return new Promise<void>(resolve => {
        const w = {
          g,
          done: () => {
            clearTimeout(timer);
            waiting.delete(w);
            resolve();
          },
        };
        const timer = setTimeout(w.done, GESTURE_MS);
        waiting.add(w);
      });
    },
    close() {
      ch.port1.close();
      for (const w of waiting) w.done();
    },
  };
}

/**
 * How long after a frame's grab was refused the host keeps handing the focus back. Chrome moves its
 * own focus into the frame apart from the page and may tell the page (activeElement, blur) frames
 * later, or move it again after the page took it back: one look after a frame would miss either.
 */
export const GIVE_BACK_MS = 3000;

/**
 * A refused grab, watched until the deadline: after each of the browser's frames, the focus still in
 * the frame (and not put there since by the person or the host) goes back. Ends early once the focus
 * there is placed, or a newer grab of the same frame is watched instead.
 */
export function watchGiveBack(env: {
  now(): number;
  /** The next look: after the browser's frame and a task. */
  next(fn: () => void): void;
  /** The page's focus is in the frame. */
  holds(): boolean;
  /** The person (or the host) put the focus in the frame since. */
  placed(): boolean;
  /** Still the frame's latest watch. */
  current(): boolean;
  giveBack(): void;
}) {
  const until = env.now() + GIVE_BACK_MS;
  const look = () => {
    if (!env.current() || env.placed()) return;
    if (env.holds()) env.giveBack();
    if (env.now() < until) env.next(look);
  };
  env.next(look);
}

let page: Gestures | null = null;
/** The page's element, or the frame the person put it in, that had the focus last. */
let holder: HTMLElement | null = null;
const giveBack = (g: Gestures, frame: HTMLIFrameElement) => {
  const back = holder;
  if (back && back !== frame && back.isConnected) {
    if (back instanceof HTMLIFrameElement) g.hostFocus(back);
    back.focus({ preventScroll: true });
  } else frame.blur();
};

/** The page's: listens once, in the capture phase, passive. */
export function pageGestures(): Gestures {
  if (page) return page;
  const g = createGestures({ now: () => performance.now(), active: () => navigator.userActivation?.isActive === true });
  const opts = { capture: true, passive: true };
  document.addEventListener(
    "focusin",
    e => {
      if (e.target instanceof HTMLElement && !(e.target instanceof HTMLIFrameElement && e.target.dataset.moduleFrame)) holder = e.target;
    },
    opts,
  );
  document.addEventListener(
    "pointerdown",
    e => {
      g.app();
      // On the frame element itself (Chrome routes a tap there while a woken frame isn't hit-testable yet): the person's, in that frame.
      if (e.target instanceof HTMLIFrameElement && e.target.dataset.moduleFrame === "view") g.own(e.target, "pointer");
    },
    opts,
  );
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
    if (!(at instanceof HTMLIFrameElement && at.dataset.moduleFrame === "view")) return;
    g.focusIn(at);
    // Told late that a frame whose grab was refused has the focus: given back all the same.
    if (!g.placedIn(at) && performance.now() - (refusedAt.get(at) ?? -Infinity) <= REFUSED_MS) later(g, at);
  });
  page = g;
  return g;
}

/**
 * A view frame's window took the focus (its bootstrap told, after any pointer down there: one port,
 * in order). Not by the person or the host: the focus goes straight back where it was.
 */
export function frameTookFocus(frame: HTMLIFrameElement): "kept" | "refused" {
  const g = pageGestures();
  if (g.tookFocus(frame)) {
    refusedAt.delete(frame);
    holder = frame;
    return "kept";
  }
  refusedAt.set(frame, performance.now());
  later(g, frame);
  return "refused";
}

/** The focus back where it was, the frame that reached for it gone (its module stopped). */
export function focusBack() {
  if (holder?.isConnected && document.activeElement !== holder) holder.focus({ preventScroll: true });
}

/** When a frame's grab was refused, and how long the page's late word of it still counts. */
const refusedAt = new WeakMap<HTMLIFrameElement, number>();
const REFUSED_MS = 10_000;
/** Each frame's latest watch. */
const watches = new WeakMap<HTMLIFrameElement, object>();

// After the browser has moved its own focus into the frame (Chrome does that apart from the page, and
// may tell the page later): given back sooner, the page believes it has the keys while the browser
// still sends them to the frame.
const later = (g: Gestures, frame: HTMLIFrameElement) => {
  const token = {};
  watches.set(frame, token);
  watchGiveBack({
    now: () => performance.now(),
    next: fn => requestAnimationFrame(() => setTimeout(fn)),
    holds: () => document.activeElement === frame,
    placed: () => g.placedIn(frame),
    current: () => watches.get(frame) === token,
    giveBack: () => giveBack(g, frame),
  });
};
