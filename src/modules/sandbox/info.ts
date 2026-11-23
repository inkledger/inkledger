/**
 * What the page shows, as geometry only ("page.info"): the information a
 * module drawn over it must keep off (text one rect per line box, controls,
 * pictures, data marks) and the horizontal faces it may stand on or hang
 * under, each with the scroller it moves with. Never what any of it says.
 * Read in slices of a few milliseconds and kept until the page changes; a
 * scroll only shifts what was read.
 */

export type InfoKind = "text" | "control" | "media" | "mark";
export type InfoRect = { x: number; y: number; w: number; h: number; kind: InfoKind; interactive: boolean; s: number };
export type Surface = { x: number; y: number; w: number; kind: "top" | "bottom"; s: number };
export type Scroller = { id: number; x: number; y: number; w: number; h: number };
export type InfoSnapshot = { v: number; viewport: { w: number; h: number }; rects: InfoRect[]; surfaces: Surface[]; scrollers: Scroller[] };

export const INFO_MAX_RECTS = 4000;
export const INFO_MAX_SURFACES = 1500;
/** Read past the visible part by this much (what a scroll brings in next). */
export const INFO_MARGIN = 200;
/** The page's thread a slice may take before it yields. */
export const INFO_SLICE_MS = 4;
/** What the items of something that never scrolls (fixed) carry as their scroller. */
export const FIXED = -1;

type Rect = { left: number; top: number; right: number; bottom: number };
export type InfoStyle = Pick<
  CSSStyleDeclaration,
  | "display"
  | "visibility"
  | "opacity"
  | "position"
  | "overflowX"
  | "overflowY"
  | "backgroundColor"
  | "backgroundImage"
  | "boxShadow"
  | "borderTopWidth"
  | "borderTopStyle"
  | "borderTopColor"
  | "borderBottomWidth"
  | "borderBottomStyle"
  | "borderBottomColor"
  | "color"
  | "cursor"
>;

/** One element as the scan reads it (the browser's, or a test's). */
export type InfoEl = {
  /** Who it is across scans (a scroller keeps its id). */
  key: object;
  tag: string;
  role: string | null;
  /** Where the person types rich text (the editable root only): one control, never looked into. */
  editable: boolean;
  style(): InfoStyle;
  rect(): Rect;
  /** Its padding box on the page, and how far its content scrolls. */
  client(): Rect & { scrollW: number; scrollH: number; clientW: number; clientH: number; scrollX: number; scrollY: number };
  /** The line boxes of its own text (not its children's). */
  textRects(): Rect[];
  children(): Iterable<InfoEl>;
};

const TYPING_TAGS = new Set(["input", "select", "textarea"]);
const CONTROL_TAGS = new Set(["a", "button", "label", "summary"]);
const CONTROL_ROLES = new Set(["button", "link", "tab", "checkbox", "switch", "slider", "progressbar", "meter", "textbox", "menuitem", "option", "radio", "combobox"]);
const MEDIA_TAGS = new Set(["svg", "canvas", "img", "video", "picture"]);
const SKIP_TAGS = new Set(["script", "style", "template", "noscript", "iframe", "head", "link", "meta"]);
// Up to a touch target's height and a wide button's width a control counts whole; past it, by what it holds.
const CONTROL_H = 48;
const CONTROL_W = 480;
// Small coloured shapes are data (bars, chips, dots); bigger ones are fills.
const MARK_MAX_H = 24;
const MIN_SURFACE_W = 24;

const alpha = (c: string) => {
  if (!c || c === "transparent") return 0;
  const n = c.match(/[\d.]+/g)?.map(Number) ?? [];
  return n.length >= 4 ? (n[3] ?? 0) : n.length === 3 ? 1 : 0;
};
const line = (w: string, style: string, color: string) => parseFloat(w) >= 1 && style !== "none" && style !== "hidden" && alpha(color) > 0.1;
const clipTo = (r: Rect, c: Rect): Rect | null => {
  const out = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
  return out.right - out.left >= 1 && out.bottom - out.top >= 1 ? out : null;
};
const grow = (r: Rect, m: number): Rect => ({ left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m });
const half = (v: number) => Math.round(v * 2) / 2;

type Ctx = { clip: Rect; s: number; bg: string; interactive: boolean; pointer: boolean };
/** A scroller as read: whose it is, inside which, and where its content stood. */
export type ScrollerRead = Scroller & { parent: number; scrollX: number; scrollY: number; key: object };
type Found = { rects: InfoRect[]; surfaces: Surface[]; scrollers: ScrollerRead[] };

/** Scroller ids that last as long as their element. */
export type ScrollerIds = { of(key: object): number };
export function scrollerIds(): ScrollerIds {
  const ids = new WeakMap<object, number>();
  let next = 1;
  return {
    of(key) {
      let id = ids.get(key);
      if (id === undefined) ids.set(key, (id = next++));
      return id;
    },
  };
}

/** The walk, one element a step (a slice stops between any two). */
function* walk(el: InfoEl, ctx: Ctx, view: Rect, ids: ScrollerIds, out: Found): Generator<void> {
  yield;
  if (SKIP_TAGS.has(el.tag)) return;
  const st = el.style();
  if (st.display === "none" || Number(st.opacity) === 0) return;
  const fixed = st.position === "fixed";
  let clip = fixed ? grow(view, INFO_MARGIN) : ctx.clip;
  let s = fixed ? FIXED : ctx.s;
  const r = el.rect();
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  // Wholly past what is read, and nothing of it can spill out of an ordinary box: skipped with what it holds.
  if (st.position !== "absolute" && !fixed && st.display !== "contents" && !clipTo(grow(r, 1), clip)) return;
  const shown = st.visibility !== "hidden" && st.visibility !== "collapse" && st.display !== "contents";
  const typing = TYPING_TAGS.has(el.tag) || el.role === "textbox" || el.editable;
  const control = typing || CONTROL_TAGS.has(el.tag) || (el.role !== null && CONTROL_ROLES.has(el.role));
  // The cursor is inherited: only where it starts is a clickable thing.
  const pointer = st.cursor === "pointer" && !ctx.pointer;
  const interactive = ctx.interactive || control || pointer;
  const rect = (b: Rect, kind: InfoKind) => {
    const c = clipTo(b, clip);
    if (c) out.rects.push({ x: c.left, y: c.top, w: c.right - c.left, h: c.bottom - c.top, kind, interactive, s });
  };
  const face = (y: number, kind: Surface["kind"]) => {
    if (y < clip.top || y > clip.bottom) return;
    const l = Math.max(r.left, clip.left);
    const rt = Math.min(r.right, clip.right);
    if (rt - l >= MIN_SURFACE_W) out.surfaces.push({ x: l, y, w: rt - l, kind, s });
  };
  const bgA = alpha(st.backgroundColor);
  const filled = bgA >= 0.1 && st.backgroundColor !== ctx.bg;
  if (shown && st.display !== "inline" && w >= MIN_SURFACE_W) {
    const shadow = !!st.boxShadow && st.boxShadow !== "none";
    const top = line(st.borderTopWidth, st.borderTopStyle, st.borderTopColor);
    const bottom = line(st.borderBottomWidth, st.borderBottomStyle, st.borderBottomColor);
    if (top || filled || shadow) face(r.top, "top");
    // A divider under a box: stood on from above.
    if (bottom && h > parseFloat(st.borderBottomWidth)) face(r.bottom - parseFloat(st.borderBottomWidth), "top");
    if (bottom || filled || shadow) face(r.bottom, "bottom");
  }
  const small = h <= CONTROL_H && w <= CONTROL_W;
  if (shown && (typing || ((control || pointer) && small))) {
    rect(r, "control");
    return;
  }
  if (shown && MEDIA_TAGS.has(el.tag)) {
    rect(r, "media");
    return;
  }
  if (shown && filled && h >= 3 && h <= MARK_MAX_H && st.display !== "inline") rect(r, "mark");
  if (st.overflowX !== "visible" || st.overflowY !== "visible") {
    const c = el.client();
    const pad = { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
    const scrolls = /auto|scroll/.test(st.overflowX + st.overflowY) && (c.scrollW > c.clientW + 1 || c.scrollH > c.clientH + 1);
    if (scrolls) {
      const id = ids.of(el.key);
      out.scrollers.push({ id, x: pad.left, y: pad.top, w: pad.right - pad.left, h: pad.bottom - pad.top, parent: s, scrollX: c.scrollX, scrollY: c.scrollY, key: el.key });
      s = id;
      clip = clipTo(clip, grow(pad, INFO_MARGIN)) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    } else clip = clipTo(clip, pad) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    if (clip.right - clip.left < 1 || clip.bottom - clip.top < 1) return;
  }
  // Its own text inside its own box: what it cuts off does not show.
  if (shown && alpha(st.color) > 0)
    for (const t of el.textRects()) {
      const c = clipTo(t, clip);
      if (c) out.rects.push({ x: c.left, y: c.top, w: c.right - c.left, h: c.bottom - c.top, kind: "text", interactive, s });
    }
  const next: Ctx = { clip, s, bg: bgA >= 0.5 ? st.backgroundColor : ctx.bg, interactive, pointer: st.cursor === "pointer" };
  for (const ch of el.children()) yield* walk(ch, next, view, ids, out);
}

/** Text fragments on one line, close side by side, as one rect (a line box, not its words). */
export function mergeLines(rects: readonly InfoRect[]): InfoRect[] {
  const text = rects.filter(r => r.kind === "text").sort((a, b) => a.s - b.s || a.y - b.y || a.x - b.x);
  const out: InfoRect[] = [];
  for (const r of text) {
    let merged = false;
    for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if (!o || o.s !== r.s || o.y < r.y - 8) break;
      const overlap = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
      const gap = Math.max(r.x - (o.x + o.w), o.x - (r.x + r.w));
      if (overlap >= 0.6 * Math.min(o.h, r.h) && gap <= 8) {
        const x = Math.min(o.x, r.x);
        const y = Math.min(o.y, r.y);
        out[i] = { ...o, x, y, w: Math.max(o.x + o.w, r.x + r.w) - x, h: Math.max(o.y + o.h, r.y + r.h) - y, interactive: o.interactive || r.interactive };
        merged = true;
        break;
      }
    }
    if (!merged) out.push({ ...r });
  }
  return [...out, ...rects.filter(r => r.kind !== "text")];
}

/** Faces at one height, touching or overlapping, as one (never bridging a gap). */
export function mergeSurfaces(faces: readonly Surface[]): Surface[] {
  const sorted = [...faces].map(f => ({ ...f, y: half(f.y) })).sort((a, b) => a.s - b.s || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.y - b.y || a.x - b.x);
  const out: Surface[] = [];
  for (const f of sorted) {
    const o = out[out.length - 1];
    if (o && o.s === f.s && o.kind === f.kind && o.y === f.y && f.x <= o.x + o.w + 0.5) o.w = Math.max(o.w, f.x + f.w - o.x);
    else out.push({ ...f });
  }
  return out;
}

const away = (view: Rect, x: number, y: number, w: number, h: number) => Math.max(0, view.left - (x + w), x - view.right, view.top - (y + h), y - view.bottom);
const nearest = <T extends { x: number; y: number }>(items: T[], max: number, view: Rect, size: (t: T) => [number, number]): T[] =>
  items.length <= max ? items : items.map(t => [t, away(view, t.x, t.y, ...size(t))] as const).sort((a, b) => a[1] - b[1]).slice(0, max).map(([t]) => t);

export type InfoPage = { root: InfoEl; width: number; height: number; scrollX: number; scrollY: number };
export type ScanResult = Omit<InfoSnapshot, "v" | "scrollers"> & { scrollers: ScrollerRead[] };

/** Reads the page, a slice at a time; `yieldNow` lets the page breathe between slices. */
export async function scanInfo(page: InfoPage, ids: ScrollerIds, clock: { now(): number; yield(): Promise<void> }, sliceMs = INFO_SLICE_MS): Promise<ScanResult> {
  const view = { left: 0, top: 0, right: page.width, bottom: page.height };
  const found: Found = { rects: [], surfaces: [], scrollers: [] };
  const steps = walk(page.root, { clip: grow(view, INFO_MARGIN), s: 0, bg: "", interactive: false, pointer: false }, view, ids, found);
  for (;;) {
    const from = clock.now();
    let done = false;
    while (!(done = !!steps.next().done) && clock.now() - from < sliceMs);
    if (done) break;
    await clock.yield();
  }
  const rects = nearest(mergeLines(found.rects), INFO_MAX_RECTS, view, r => [r.w, r.h]).map(r => ({ ...r, x: half(r.x), y: half(r.y), w: half(r.w), h: half(r.h) }));
  const surfaces = nearest(mergeSurfaces(found.surfaces), INFO_MAX_SURFACES, view, f => [f.w, 0]).map(f => ({ ...f, x: half(f.x), w: half(f.w) }));
  const scrollers = [{ id: 0, x: 0, y: 0, w: page.width, h: page.height, parent: FIXED, scrollX: page.scrollX, scrollY: page.scrollY, key: page.root.key }, ...found.scrollers];
  return { viewport: { w: page.width, h: page.height }, rects, surfaces, scrollers };
}

/** Moves what scrolls with `id` (and with the scrollers inside it) by (dx, dy) on screen. */
export function shiftBy(snap: ScanResult, id: number, dx: number, dy: number): ScanResult {
  const moved = new Set([id]);
  // Scrollers are listed outer before inner: one pass finds the nested ones.
  for (const sc of snap.scrollers) if (sc.id !== id && moved.has(sc.parent)) moved.add(sc.id);
  const inner = (s: number) => moved.has(s) && s !== id;
  return {
    ...snap,
    rects: snap.rects.map(r => (moved.has(r.s) ? { ...r, x: r.x + dx, y: r.y + dy } : r)),
    surfaces: snap.surfaces.map(f => (moved.has(f.s) ? { ...f, x: f.x + dx, y: f.y + dy } : f)),
    scrollers: snap.scrollers.map(sc => (inner(sc.id) ? { ...sc, x: sc.x + dx, y: sc.y + dy } : sc)),
  };
}

export type ScrollEvent = { kind: "scroll"; s: number; dx: number; dy: number };
export type InfoEnv = {
  page(): InfoPage;
  now(): number;
  yield(): Promise<void>;
  requestAnimationFrame(fn: () => void): unknown;
  /** Watches the page: `change` when its layout may have changed, `scroll` with a scroller's (or the window's: the root's key) new offsets. Returns the undo. */
  watch(on: { change: () => void; scroll: (key: object, x: number, y: number) => void }): () => void;
};
/**
 * The page's info, read again only once it changed; a scroll shifts what was read and is told per
 * frame. The page is watched (observers and listeners, never a timer) while someone holds it.
 */
export function createInfoSource(env: InfoEnv) {
  const ids = scrollerIds();
  let version = 1;
  let dirty = true;
  let snap: ScanResult | null = null;
  let snapV = 0;
  let drift = 0;
  let running: Promise<ScanResult> | null = null;
  let off: (() => void) | null = null;
  let holders = 0;
  const listeners = new Set<(e: ScrollEvent) => void>();
  const moves = new Map<number, { dx: number; dy: number }>();
  let frame = false;
  const change = () => {
    version++;
    dirty = true;
  };
  const tell = () => {
    frame = false;
    const all = [...moves];
    moves.clear();
    for (const [s, m] of all) for (const fn of listeners) fn({ kind: "scroll", s, dx: m.dx, dy: m.dy });
  };
  const scroll = (key: object, x: number, y: number) => {
    const sc = snap?.scrollers.find(c => c.key === key);
    if (!snap || !sc || running) return change();
    // On screen, what scrolls moves the other way.
    const dx = sc.scrollX - x;
    const dy = sc.scrollY - y;
    if (!dx && !dy) return;
    snap = shiftBy(snap, sc.id, dx, dy);
    snap.scrollers = snap.scrollers.map(c => (c.id === sc.id ? { ...c, scrollX: x, scrollY: y } : c));
    drift += Math.abs(dx) + Math.abs(dy);
    // Past half the margin read around it, what comes in next was never read.
    if (drift > INFO_MARGIN / 2) change();
    const m = moves.get(sc.id) ?? { dx: 0, dy: 0 };
    moves.set(sc.id, { dx: m.dx + dx, dy: m.dy + dy });
    if (!frame && listeners.size > 0) {
      frame = true;
      env.requestAnimationFrame(tell);
    }
  };
  const shown = (r: ScanResult, v: number): InfoSnapshot => ({ v, viewport: r.viewport, rects: r.rects, surfaces: r.surfaces, scrollers: r.scrollers.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) });
  return {
    /** Watches the page until the undo (each module frame that asks holds it while it lives). */
    hold(): () => void {
      holders++;
      if (!off) {
        // What was read unwatched may be stale already.
        dirty = true;
        off = env.watch({ change, scroll });
      }
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--holders > 0) return;
        off?.();
        off = null;
        // Unwatched, what was read may go stale.
        dirty = true;
      };
    },
    /** Unheld, it reads the page every time. */
    async get(): Promise<InfoSnapshot> {
      if (snap && !dirty && off) return shown(snap, snapV);
      running ??= (async () => {
        // A page that keeps changing under the scan (a ticking timer) is taken as the third read finds it.
        for (let i = 0; ; i++) {
          const at = version;
          dirty = false;
          const r = await scanInfo(env.page(), ids, env);
          if (version === at || i >= 2) {
            snap = r;
            snapV = at;
            drift = 0;
            return r;
          }
        }
      })().finally(() => (running = null));
      const r = await running;
      return shown(r, snapV);
    },
    /** Each scroller's move on screen, once a frame. Returns the undo. */
    onScroll(fn: (e: ScrollEvent) => void): () => void {
      listeners.add(fn);
      const release = this.hold();
      return () => {
        listeners.delete(fn);
        release();
      };
    },
    /** The page's version (a new one whenever it changed). */
    version: () => version,
  };
}

const OVERLAY = "[data-page-overlay], [data-module-frame]";

/** The browser's page as the scan reads it. */
export function browserInfoPage(): InfoPage {
  const wrap = (e: Element): InfoEl => ({
    key: e,
    tag: e.localName,
    role: e.getAttribute("role"),
    editable: e instanceof HTMLElement && e.isContentEditable && !e.parentElement?.isContentEditable,
    style: () => getComputedStyle(e),
    rect: () => e.getBoundingClientRect(),
    client() {
      const r = e.getBoundingClientRect();
      const left = r.left + e.clientLeft;
      const top = r.top + e.clientTop;
      return { left, top, right: left + e.clientWidth, bottom: top + e.clientHeight, scrollW: e.scrollWidth, scrollH: e.scrollHeight, clientW: e.clientWidth, clientH: e.clientHeight, scrollX: e.scrollLeft, scrollY: e.scrollTop };
    },
    textRects() {
      const out: Rect[] = [];
      for (const n of Array.from(e.childNodes))
        if (n.nodeType === 3 && n.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          out.push(...Array.from(range.getClientRects()));
        }
      return out;
    },
    *children() {
      for (const c of Array.from(e.children)) if (!c.matches(OVERLAY)) yield wrap(c);
    },
  });
  return { root: wrap(document.body), width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY };
}

/** Watches the browser's page for what may move its info (a module's own frames never count). */
export function watchBrowserPage(on: { change: () => void; scroll: (key: object, x: number, y: number) => void }): () => void {
  const mine = (n: Node) => {
    const e = n instanceof Element ? n : n.parentElement;
    return !!e?.closest(OVERLAY);
  };
  const mo = new MutationObserver(records => {
    if (records.some(r => !mine(r.target))) on.change();
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const onScroll = (ev: Event) => {
    const t = ev.target;
    if (t instanceof Element) on.scroll(t, t.scrollLeft, t.scrollTop);
    else on.scroll(document.body, window.scrollX, window.scrollY);
  };
  const opts = { passive: true, capture: true };
  window.addEventListener("scroll", onScroll, opts);
  window.addEventListener("resize", on.change, { passive: true });
  // What moves without a mutation of its own: a fold's or a sheet's transition ending, the fonts arriving.
  window.addEventListener("transitionend", on.change, opts);
  window.addEventListener("animationend", on.change, opts);
  document.fonts?.addEventListener?.("loadingdone", on.change);
  return () => {
    mo.disconnect();
    window.removeEventListener("scroll", onScroll, opts);
    window.removeEventListener("resize", on.change);
    window.removeEventListener("transitionend", on.change, opts);
    window.removeEventListener("animationend", on.change, opts);
    document.fonts?.removeEventListener?.("loadingdone", on.change);
  };
}

let pageSource: ReturnType<typeof createInfoSource> | null = null;

/** The page's one info source, shared by every module that has "page.info". */
export const browserInfo = () =>
  (pageSource ??= createInfoSource({
    page: browserInfoPage,
    now: () => performance.now(),
    yield: yieldToPage,
    requestAnimationFrame: fn => requestAnimationFrame(fn),
    watch: watchBrowserPage,
  }));

/** Lets the page's thread do its work (input, a frame) and comes back: the scheduler's yield, else a message round trip (no timer). */
export function yieldToPage(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}
