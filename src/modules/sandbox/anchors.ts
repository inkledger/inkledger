import { isClosed, isWaiting } from "@contracts/categories";
import type { Anchor, BoxRect, PageEvent } from "../hostV2";

/**
 * The app's landmarks for a framed module ("page.anchors") and what the
 * person does near them ("page.events"): rectangles in the module's box,
 * never what the elements hold. The page marks its landmarks with
 * `data-anchor="<kind>"` (a board column adds its category); a card and a
 * column carry the host's own ids (`data-anchor-card`, `data-anchor-column`)
 * so an event can find them again, and those ids never leave the host.
 */

/** At most this many anchors an answer. */
export const ANCHORS_MAX = 32;
/** Events told a second, at most, per watcher (a burst of moves is a few hops, not a flood). */
export const EVENTS_PER_SECOND = 8;

type Box = { left: number; top: number; width: number; height: number };
type R = { left: number; top: number; right: number; bottom: number };
export type AnchorEl = { getBoundingClientRect(): R; getAttribute(name: string): string | null };
export type AnchorPage = { anchors(): Iterable<AnchorEl>; width: number; height: number };

const KINDS = new Set(["timer", "log-time", "notifications", "search", "sidebar", "board-column"]);
/** The board's categories, said coarsely: waiting, under way, finished. */
const coarse = (c: string | null): "todo" | "doing" | "done" | null => (!c ? null : isWaiting(c) ? "todo" : c === "doing" ? "doing" : isClosed(c) ? "done" : null);

/** In sight: some of it in the window, and a size of its own (a hidden one has none). */
const shows = (r: R, page: { width: number; height: number }) => r.right - r.left > 0 && r.bottom - r.top > 0 && r.right > 0 && r.bottom > 0 && r.left < page.width && r.top < page.height;

/** `r` in the box's px, rounded. */
export const toBox = (r: R, box: Box): BoxRect => ({ x: Math.round(r.left - box.left), y: Math.round(r.top - box.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) });

/** The landmarks in sight, in the box's px; board columns numbered left to right. */
export function anchorsAround(page: AnchorPage, box: Box): Anchor[] {
  const out: Anchor[] = [];
  const columns: { r: R; category: string | null }[] = [];
  for (const el of page.anchors()) {
    const kind = el.getAttribute("data-anchor");
    if (!kind || !KINDS.has(kind)) continue;
    const r = el.getBoundingClientRect();
    if (!shows(r, page)) continue;
    if (kind === "board-column") {
      columns.push({ r, category: el.getAttribute("data-anchor-category") });
      continue;
    }
    // One of each (a hidden twin, the phone's or the desktop's, has no size and is gone already).
    if (out.some(a => a.kind === kind)) continue;
    out.push({ kind: kind as Exclude<Anchor["kind"], "board-column">, ...toBox(r, box) });
  }
  columns.sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top);
  columns.forEach((c, index) => out.push({ kind: "board-column", index, category: coarse(c.category), ...toBox(c.r, box) }));
  return out.slice(0, ANCHORS_MAX);
}

/** What the host knows of an event: which of its own elements to measure once the page has drawn it. */
export type PageSignal =
  | { kind: "card-moved"; card: string; from: string; to: string }
  | { kind: "card-closed"; card: string }
  | { kind: "timer-started" | "timer-stopped" | "notification" }
  /** `field`: the search field that took the focus (else the app's search, the palette's opener). */
  | { kind: "search"; focused: boolean; field?: AnchorEl }
  | { kind: "goal-reached" };

export type SignalPage = {
  /** An element by its host id, when in sight. */
  card(id: string): AnchorEl | null;
  column(id: string): AnchorEl | null;
  /** A landmark of this kind in sight. */
  anchor(kind: string): AnchorEl | null;
  width: number;
  height: number;
};

/** A signal as the module hears it: rects in its box, null where nothing shows. */
export function eventOf(s: PageSignal, page: SignalPage, box: Box): PageEvent {
  const rect = (el: AnchorEl | null) => {
    const r = el?.getBoundingClientRect();
    return r && shows(r, page) ? toBox(r, box) : null;
  };
  switch (s.kind) {
    case "card-moved":
      return { kind: "card-moved", from: rect(page.column(s.from)), to: rect(page.column(s.to)), card: rect(page.card(s.card)) };
    case "card-closed":
      return { kind: "card-closed", card: rect(page.card(s.card)) };
    case "timer-started":
    case "timer-stopped":
      return { kind: s.kind, at: rect(page.anchor("timer")) };
    case "notification":
      return { kind: "notification", at: rect(page.anchor("notifications")) };
    case "search":
      return { kind: "search", focused: s.focused, at: rect(s.field ?? page.anchor("search")) };
    case "goal-reached":
      return { kind: "goal-reached" };
  }
}

export type EventsWin = { requestAnimationFrame(fn: () => void): number; now(): number };

/**
 * Signals to the frames that watch: each measured in two animation frames
 * (the page has drawn what it means: a moved card in its new column), at
 * most EVENTS_PER_SECOND a watcher, the rest dropped. Listens to its sources
 * only while watched.
 */
export function createPageEvents(win: EventsWin, sources: readonly ((fn: (s: PageSignal) => void) => () => void)[]) {
  type Watcher = { box: () => Box; push: (e: PageEvent) => void; page: () => SignalPage; sent: number[] };
  const watchers = new Set<Watcher>();
  let offs: (() => void)[] = [];
  const tell = (s: PageSignal) => {
    win.requestAnimationFrame(() =>
      win.requestAnimationFrame(() => {
        const now = win.now();
        for (const w of watchers) {
          w.sent = w.sent.filter(t => now - t < 1000);
          if (w.sent.length >= EVENTS_PER_SECOND) continue;
          w.sent.push(now);
          w.push(eventOf(s, w.page(), w.box()));
        }
      }),
    );
  };
  return {
    watch(box: () => Box, page: () => SignalPage, push: (e: PageEvent) => void): () => void {
      const w: Watcher = { box, page, push, sent: [] };
      if (watchers.size === 0) offs = sources.map(src => src(tell));
      watchers.add(w);
      return () => {
        if (!watchers.delete(w) || watchers.size > 0) return;
        offs.forEach(off => off());
        offs = [];
      };
    },
  };
}

/** The page's own anchors. */
export const browserAnchors = (): AnchorPage => ({
  anchors: () => document.querySelectorAll<HTMLElement>("[data-anchor]"),
  width: window.innerWidth,
  height: window.innerHeight,
});

/** The first in sight of the elements matching `sel` (the phone's and the desktop's twins: one shows). */
const shown = (sel: string): AnchorEl | null => {
  for (const el of document.querySelectorAll<HTMLElement>(sel)) if (shows(el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })) return el;
  return null;
};

export const browserSignalPage = (): SignalPage => ({
  card: id => shown(`[data-anchor-card="${CSS.escape(id)}"]`),
  column: id => shown(`[data-anchor-column="${CSS.escape(id)}"]`),
  anchor: kind => shown(`[data-anchor="${CSS.escape(kind)}"]`),
  width: window.innerWidth,
  height: window.innerHeight,
});
