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

/** The layout's state from its sources; `poke` when one without its own signal changed (a dock). */
export function createLayoutFeed(src: { rail(): boolean; docked(): boolean; subscribe(fn: () => void): () => void }) {
  const watchers = new Set<{ push: (v: LayoutState) => void; last: string }>();
  const read = (): LayoutState => ({ sidebar: src.rail() ? "rail" : "full", docked: src.docked() });
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
