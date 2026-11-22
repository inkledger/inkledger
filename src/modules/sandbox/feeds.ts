import type { LayoutState, PointerState } from "../hostV2";

/**
 * What a framed module may watch of the page around it, each pushed only
 * when it changes: the pointer relative to its box ("pointer"), the layout
 * ("layout") and a backdrop's blur radius ("backdrop.preblurred").
 */

export type PointerWin = Pick<Window, "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "innerWidth" | "innerHeight"> & {
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
};
type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * One passive listener and at most one animation frame for every watcher:
 * a move is read once per frame, and nothing is sent while the page is
 * hidden, the box is off screen or the pointer is away (then null, once).
 */
export function createPointerFeed(win: PointerWin) {
  type Watcher = { rect: () => Rect; push: (v: PointerState) => void; last: string };
  const watchers = new Set<Watcher>();
  let at: { x: number; y: number } | null = null;
  let frame = 0;
  const send = (w: Watcher) => {
    let v: PointerState = null;
    if (at && !win.document.hidden) {
      const r = w.rect();
      if (r.right >= 0 && r.bottom >= 0 && r.left <= win.innerWidth && r.top <= win.innerHeight) v = { x: Math.round(at.x - r.left), y: Math.round(at.y - r.top) };
    }
    const key = v ? `${v.x},${v.y}` : "";
    if (key === w.last) return;
    w.last = key;
    w.push(v);
  };
  const flush = () => {
    frame = 0;
    watchers.forEach(send);
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(flush);
  };
  const onMove = (e: PointerEvent) => {
    at = { x: e.clientX, y: e.clientY };
    schedule();
  };
  // Out of the window altogether (nothing under it any more).
  const onOut = (e: PointerEvent) => {
    if (e.relatedTarget !== null) return;
    at = null;
    schedule();
  };
  const opts = { passive: true, capture: true };
  const listen = (on: boolean) => {
    if (on) {
      win.addEventListener("pointermove", onMove, opts);
      win.document.addEventListener("pointerout", onOut, opts);
      win.document.addEventListener("visibilitychange", schedule);
    } else {
      win.removeEventListener("pointermove", onMove, opts);
      win.document.removeEventListener("pointerout", onOut, opts);
      win.document.removeEventListener("visibilitychange", schedule);
    }
  };
  return {
    watch(rect: () => Rect, push: (v: PointerState) => void): () => void {
      const w: Watcher = { rect, push, last: "" };
      if (watchers.size === 0) listen(true);
      watchers.add(w);
      push(null);
      return () => {
        if (!watchers.delete(w)) return;
        if (watchers.size === 0) {
          listen(false);
          at = null;
        }
      };
    },
  };
}

/**
 * The layout's state from its sources; `poke` when one without its own signal
 * changed (a dock). The optional readers add the window's size, whether the
 * sidebar's scroller has more below, and whether the page is scrolling.
 */
export function createLayoutFeed(src: {
  rail(): boolean;
  docked(): boolean;
  subscribe(fn: () => void): () => void;
  viewport?(): { width: number; height: number };
  navMore?(): boolean;
  scrolling?(): boolean;
}) {
  const watchers = new Set<{ push: (v: LayoutState) => void; last: string }>();
  const read = (): LayoutState => ({
    sidebar: src.rail() ? "rail" : "full",
    docked: src.docked(),
    ...(src.viewport ? { viewport: src.viewport() } : {}),
    ...(src.navMore ? { navMore: src.navMore() } : {}),
    ...(src.scrolling ? { scrolling: src.scrolling() } : {}),
  });
  const tell = () => {
    const v = read();
    const key = JSON.stringify(v);
    for (const w of watchers) {
      if (w.last === key) continue;
      w.last = key;
      w.push(v);
    }
  };
  let off: (() => void) | null = null;
  return {
    poke: tell,
    watch(push: (v: LayoutState) => void): () => void {
      const v = read();
      const w = { push, last: JSON.stringify(v) };
      off ??= src.subscribe(tell);
      watchers.add(w);
      push(v);
      return () => {
        watchers.delete(w);
        if (watchers.size === 0) {
          off?.();
          off = null;
        }
      };
    },
  };
}

export type LayoutChangedWin = Pick<Window, "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "setTimeout" | "clearTimeout">;

/** Quiet this long after the last scroll, resize or switch before a change is told. */
export const LAYOUT_SETTLE_MS = 150;

/**
 * "The page moved under you" (scroll, resize, a route, the sidebar folding, a
 * sheet), told once things settle and then in an animation frame: never a
 * message per scroll event. Listens only while watched.
 */
export function createLayoutChangedFeed(win: LayoutChangedWin, sources: readonly ((fn: () => void) => () => void)[]) {
  const watchers = new Set<() => void>();
  let timer: number | undefined;
  let frame = 0;
  let offs: (() => void)[] = [];
  const tell = () => {
    frame = 0;
    watchers.forEach(fn => fn());
  };
  const poke = () => {
    if (watchers.size === 0) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      timer = undefined;
      frame ||= win.requestAnimationFrame(tell);
    }, LAYOUT_SETTLE_MS);
  };
  const opts = { passive: true, capture: true };
  return {
    poke,
    watch(fn: () => void): () => void {
      if (watchers.size === 0) {
        win.addEventListener("scroll", poke, opts);
        win.addEventListener("resize", poke, { passive: true });
        offs = sources.map(s => s(poke));
      }
      watchers.add(fn);
      return () => {
        if (!watchers.delete(fn) || watchers.size > 0) return;
        win.removeEventListener("scroll", poke, opts);
        win.removeEventListener("resize", poke);
        offs.forEach(off => off());
        offs = [];
        win.clearTimeout(timer);
        timer = undefined;
      };
    },
  };
}

/**
 * Whether the page is scrolling: true at a gesture's first scroll event, false
 * once it has been quiet LAYOUT_SETTLE_MS (two changes a gesture, not one a
 * frame). Listens only while subscribed.
 */
export function createScrollingFlag(win: LayoutChangedWin) {
  const fns = new Set<() => void>();
  let on = false;
  let timer: number | undefined;
  const tell = () => fns.forEach(fn => fn());
  const onScroll = () => {
    win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      timer = undefined;
      on = false;
      tell();
    }, LAYOUT_SETTLE_MS);
    if (on) return;
    on = true;
    tell();
  };
  const opts = { passive: true, capture: true };
  return {
    get: () => on,
    subscribe(fn: () => void): () => void {
      if (fns.size === 0) win.addEventListener("scroll", onScroll, opts);
      fns.add(fn);
      return () => {
        if (!fns.delete(fn) || fns.size > 0) return;
        win.removeEventListener("scroll", onScroll, opts);
        win.clearTimeout(timer);
        timer = undefined;
        on = false;
      };
    },
  };
}

/**
 * The blur the host wants over a backdrop (px), for a module that bakes it
 * into its own picture: read from `--backdrop-blur` where the host sets it,
 * again whenever that element's style changes.
 */
export function watchBlur(
  box: Element,
  push: (px: number) => void,
  o: { style(e: Element): { getPropertyValue(k: string): string }; observe(e: Element, fn: () => void): () => void },
): () => void {
  const source = box.closest('[style*="--backdrop-blur"]');
  let last = -1;
  const read = () => {
    const px = Math.max(0, Math.min(64, Number.parseFloat(o.style(box).getPropertyValue("--backdrop-blur")) || 0));
    if (px === last) return;
    last = px;
    push(px);
  };
  read();
  return source ? o.observe(source, read) : () => {};
}
