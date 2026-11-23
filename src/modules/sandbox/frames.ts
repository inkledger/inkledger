import type { ModuleListEntry } from "@contracts/modules";
import { currentLocale } from "@/i18n";
import { SURFACES } from "@/components/app/surface";
import type { Hub } from "../host";
import type { ViewSlot } from "../hostV2";
import { mobileMore, sheetOpen } from "./sheet";
import { frameMethods, type ViewBox } from "./methods";
import { capabilityMethods } from "./capabilities";
import { createPageLight } from "./light";
import { browserBroker, createBroker } from "./broker";
import { focusBack, frameTookFocus, ownReports, pageGestures } from "./gesture";
import { browserPage } from "./importance";
import { browserLedges } from "./ledges";
import { browserAnchors, browserSignalPage, createPageEvents, watchTransitions, type AnchorEl, type PageSignal } from "./anchors";
import { cardId, pageSignals } from "../pageSignals";
import { enabledSignals } from "../enabledSignals";
import { commandPalette } from "@/lib/commandPalette";
import type { HostApiV1 } from "../types";
import { createLayoutChangedFeed, createLayoutFeed, createPointerFeed, createScrollingFlag, watchBlur, watchContent } from "./feeds";
import { pageCache } from "./cache";
import { fontLoader, themeSheet } from "./themeSheet";
import interUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import interTightUrl from "@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2?url";
import { sidebar } from "@/hooks/useSidebar";
import { createRateBuckets, createRpcPeer, RPC_VERSION, type HostMessage, type RateBuckets, type RpcPeer } from "./rpc";
import { budgetOf, markStopped, watchFrame } from "./watchdog";
import { createFrameBudget } from "./budget";
import { moduleSessions } from "./session";
import { pageFocusBadge } from "./focusBadge";

/**
 * Framed modules on the page: one sandboxed view frame per slot mount, and
 * one persistent runtime frame per module that asks for one ("runtime"),
 * with a port between each view and the runtime. Frames are made when the
 * page is idle, never moved (a moved frame reloads), and a frame that loads
 * again (it navigated) stops its whole module for the session.
 */

/** How long a removed view's (or runtime's) cleanup may take before its frame goes anyway: the frame waits up to 1 s for a cleanup's promise. */
const UNMOUNT_MS = 1300;
/** Slots with no height of their own: the view frame takes its content's, up to FIT_MAX_PX. */
const FIT_SLOTS: readonly ViewSlot[] = ["settings", "sidebar-footer", "mobile-more"];
const FIT_MAX_PX = 2000;
/** A view frame larger than its box (the module's box inside keeps the slot's size): the dock pill's shadow. */
const ROOM: Partial<Record<ViewSlot, { top: number; right: number; bottom: number; left: number }>> = {
  "mobile-dock": { top: 16, right: 8, bottom: 16, left: 16 },
};

const budget = createFrameBudget();
const peers = new Set<RpcPeer>();
const killed = new Set<string>();
/** Each module's rates for its costly methods, shared by its frames (a module with more frames gets no more). */
const rates = new Map<string, RateBuckets>();
const ratesOf = (id: string) => {
  let r = rates.get(id);
  if (!r) rates.set(id, (r = createRateBuckets()));
  return r;
};
const onKill = new Map<string, Set<() => void>>();

const onMessage = (e: MessageEvent) => peers.forEach(p => p.receive(e));
const addPeer = (p: RpcPeer) => {
  if (peers.size === 0) window.addEventListener("message", onMessage);
  peers.add(p);
  return () => {
    peers.delete(p);
    p.dispose();
    if (peers.size === 0) window.removeEventListener("message", onMessage);
  };
};

const idle = (fn: () => void) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 1);
  return () => clearTimeout(id);
};

const locale = (): "en" | "it" => (currentLocale() === "it" ? "it" : "en");

let pointer: ReturnType<typeof createPointerFeed> | null = null;
const fonts = fontLoader(
  [
    { family: "Inter Variable", url: interUrl },
    { family: "Inter Tight Variable", url: interTightUrl },
  ],
  url => fetch(url).then(r => r.blob()),
);
// Read once per theme change for every frame (the hub hands each subscriber the same object).
const looks = new WeakMap<object, string>();
const readLook = (theme: object) => {
  const known = looks.get(theme);
  if (known !== undefined) return known;
  const root = getComputedStyle(document.documentElement);
  const css = themeSheet({ token: n => root.getPropertyValue(n), fontFamily: getComputedStyle(document.body).fontFamily, fontSize: root.fontSize });
  looks.set(theme, css);
  return css;
};
let layoutChanged: ReturnType<typeof createLayoutChangedFeed> | null = null;
// The main region's content too (a route's page arriving, a list growing), not only scrolls and resizes.
const mainContent = (fn: () => void) => watchContent(document.querySelector("main") ?? document.body, fn);
const layoutChangedFeed = () => (layoutChanged ??= createLayoutChangedFeed(window, [sidebar.subscribe, sheetOpen.subscribe, mainContent]));
let layout: ReturnType<typeof createLayoutFeed> | null = null;
let scrolling: ReturnType<typeof createScrollingFlag> | null = null;
/** The sidebar's scrollers: the favorites, and the whole column on a short screen. */
const SIDEBAR_SCROLLERS = 'aside [class*="overflow-y-auto"]';
const layoutFeed = () =>
  (layout ??= createLayoutFeed({
    rail: sidebar.collapsed,
    docked: () => document.querySelector('[data-module-slot="mobile-dock"] [data-docked]') !== null,
    viewport: () => ({ width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) }),
    navMore: () => [...document.querySelectorAll(SIDEBAR_SCROLLERS)].some(e => e.scrollHeight - e.clientHeight - e.scrollTop > 2),
    scrolling: () => scrolling?.get() ?? false,
    // Read again on a fold, once the page settles after a scroll or resize, and as a scroll starts and ends.
    subscribe(fn) {
      const flag = (scrolling ??= createScrollingFlag(window));
      const offs = [sidebar.subscribe(fn), layoutChangedFeed().watch(fn), flag.subscribe(fn)];
      return () => offs.forEach(off => off());
    },
  }));
const blur = (box: Element, push: (px: number) => void) =>
  watchBlur(box, push, {
    style: e => getComputedStyle(e),
    observe(e, fn) {
      const o = new MutationObserver(fn);
      o.observe(e, { attributes: true, attributeFilter: ["style"] });
      return () => o.disconnect();
    },
  });
let pageLight: ReturnType<typeof createPageLight> | null = null;
const light = () =>
  (pageLight ??= createPageLight(
    {
      root: document.documentElement.style,
      addStyle(css) {
        const el = document.createElement("style");
        el.id = "ikl-surface-light";
        el.textContent = css;
        document.head.append(el);
        return el;
      },
      frame(fn) {
        const id = requestAnimationFrame(fn);
        return () => cancelAnimationFrame(id);
      },
    },
    SURFACES,
  ));

/** The palette's dialog grows in this long (dialog.tsx's zoom-in): measured after, where it stays. */
const PALETTE_GROW_MS = 220;

/**
 * What the person does, as the host sees it ("page.events"): the hub's events, the page's own
 * (Board moves, notifications), the search palette and any search field taking the focus, and
 * this module switched on from its Store card.
 */
function signalSources(api: Pick<HostApiV1, "on">, moduleId: string): ((fn: (s: PageSignal) => void) => () => void)[] {
  const isSearch = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.type === "search";
  return [
    fn => pageSignals.subscribe(fn),
    fn => enabledSignals.subscribe(moduleId, from => fn({ kind: "enabled", from })),
    fn => {
      const offs = [
        api.on("timer-started", () => fn({ kind: "timer-started" })),
        api.on("timer-stopped", () => fn({ kind: "timer-stopped" })),
        api.on("issue-closed", d => fn({ kind: "card-closed", card: cardId(d.ref?.connectionId, d.issueKey) })),
        api.on("goal-reached", () => fn({ kind: "goal-reached" })),
      ];
      return () => offs.forEach(off => off());
    },
    // The page changing under the overlay (which stays): a route, a fold, a resize; ready once it settles.
    fn => {
      const feed = layoutChangedFeed();
      const onResize = (poke: () => void) => {
        window.addEventListener("resize", poke, { passive: true });
        return () => window.removeEventListener("resize", poke);
      };
      return watchTransitions(fn, [poke => api.on("route", poke), poke => sidebar.subscribe(poke), onResize], done => feed.watch(done), feed.poke);
    },
    fn => {
      let open = commandPalette.get();
      let wait = 0;
      // The palette itself (its field is its top row; its edge is where to stand), once drawn and done growing in
      // (its body may load first): else the app's search.
      const field = (): AnchorEl | undefined => document.querySelector<HTMLElement>('[data-slot="command-input-wrapper"]')?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? undefined;
      const tellOpen = (tries: number) => {
        const f = field();
        if (!f && tries > 0) return void (wait = window.setTimeout(() => tellOpen(tries - 1), 50));
        wait = window.setTimeout(() => open && fn({ kind: "search", focused: true, field: field() ?? f }), f ? PALETTE_GROW_MS : 0);
      };
      const off = commandPalette.subscribe(() => {
        if (commandPalette.get() === open) return;
        open = commandPalette.get();
        clearTimeout(wait);
        if (open) tellOpen(20);
        else fn({ kind: "search", focused: false });
      });
      const onIn = (e: FocusEvent) => isSearch(e.target) && fn({ kind: "search", focused: true, field: e.target });
      const onOut = (e: FocusEvent) => isSearch(e.target) && fn({ kind: "search", focused: false, field: e.target });
      document.addEventListener("focusin", onIn);
      document.addEventListener("focusout", onOut);
      return () => {
        off();
        clearTimeout(wait);
        document.removeEventListener("focusin", onIn);
        document.removeEventListener("focusout", onOut);
      };
    },
  ];
}

/** A module that navigated or slowed the page: all its frames go, and it stays off until the page reloads. */
function kill(id: string, why: string, reason: "slow" | "navigated" | "focus") {
  if (killed.has(id)) return;
  killed.add(id);
  markStopped(id, reason);
  console.warn(`[module ${id}] stopped: ${why}`);
  [...(onKill.get(id) ?? [])].forEach(f => f());
}

/** Cleanups under way in a module's frames: its runtime closes after its views' (their last words reach it). */
const settling = new Map<string, Set<Promise<void>>>();
const settle = (id: string, p: Promise<void>) => {
  const set = settling.get(id) ?? new Set();
  settling.set(id, set);
  set.add(p);
  void p.then(() => {
    set.delete(p);
    if (set.size === 0 && settling.get(id) === set) settling.delete(id);
  });
};

const whenKilled = (id: string, fn: () => void) => {
  const set = onKill.get(id) ?? new Set();
  onKill.set(id, set);
  set.add(fn);
  return () => void set.delete(fn);
};

type Frame = { iframe: HTMLIFrameElement; stop: () => void };

const focusedBox = (id: string) => {
  const at = document.activeElement;
  return at instanceof HTMLElement ? at.closest<HTMLElement>(`[data-module="${CSS.escape(id)}"]`) : null;
};

type Movable = HTMLElement & { moveBefore(node: Node, child: Node | null): void };
const movable = (el: HTMLElement): el is Movable => "moveBefore" in el && typeof el.moveBefore === "function";

/** Off screen without reloading it (moveBefore keeps its document, appendChild would not); false where it can't. */
function park(iframe: HTMLIFrameElement): boolean {
  const to = shelfEl();
  if (!iframe.isConnected || !movable(to)) return false;
  try {
    to.moveBefore(iframe, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * One sandboxed frame of a module, its messages served from the hub's API for
 * it. `init` is what it gets once it says ready (with `transfer`).
 */
function openFrame(
  hub: Hub,
  entry: ModuleListEntry,
  slot: ViewSlot,
  parent: HTMLElement,
  role: "view" | "runtime",
  ready: (peer: RpcPeer) => Transferable[],
  failed?: () => void,
): Frame | null {
  if (!entry.frameUrl || killed.has(entry.id) || !budget.take(role, entry.id)) return null;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.dataset.moduleFrame = role;
  iframe.title = entry.name[locale()];
  if (role === "runtime") {
    iframe.setAttribute("allow", "autoplay");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
  }
  const fit = role === "view" && FIT_SLOTS.includes(slot);
  // Same colour scheme as the frame's document (light: it declares none), or the browser paints it
  // opaque. Not "normal": under the app's "light dark" meta that turns dark with a dark system.
  Object.assign(iframe.style, { display: "block", border: "0", width: role === "view" ? "100%" : "0", height: role === "view" && !fit ? "100%" : "0", colorScheme: "light", background: "transparent" });
  const room = role === "view" ? ROOM[slot] : undefined;
  if (room) {
    Object.assign(iframe.style, {
      position: "absolute",
      top: `-${room.top}px`,
      left: `-${room.left}px`,
      width: `calc(100% + ${room.left + room.right}px)`,
      height: `calc(100% + ${room.top + room.bottom}px)`,
      // Clipped to the box until the module sets a shape (the box then takes no pointer): a box that
      // takes the pointer itself never takes a tap in its room (ModuleHost lifts the clip).
      clipPath: `inset(${room.top}px ${room.right}px ${room.bottom}px ${room.left}px)`,
    });
  }
  // Its content's height, once a frame at most (no 150 px default).
  let sizeFrame = 0;
  let sizeNext = 0;
  const resize = (h: number) => {
    if (!fit) return;
    sizeNext = Math.min(h, FIT_MAX_PX);
    sizeFrame ||= requestAnimationFrame(() => {
      sizeFrame = 0;
      iframe.style.height = `${sizeNext}px`;
    });
  };
  // The sheet and the page overlay are no manifest slots: their API is the module's as in its first slot.
  const { api, cas, dispose: disposeApi } = hub.apiFor(entry.id, slot === "sheet" || slot === "page-overlay" ? (entry.slots[0] ?? "settings") : slot);
  const gestures = pageGestures();
  // The person's gesture, as this frame's own: in its view (its frame, its host box); a runtime has none.
  const gesture = role === "view" ? (ms?: number) => gestures.has(iframe, parent, document.activeElement === iframe, ms) : () => false;
  const box: ViewBox | null =
    role === "view"
      ? {
          el: parent,
          slot,
          activate: how => {
            gestures.box(parent);
            peer.send({ v: RPC_VERSION, t: "activate", ...(how ? { how } : {}) });
          },
          focus: (focused, visible) => peer.send({ v: RPC_VERSION, t: "hit-focus", focused, visible }),
          onDock: () => layoutFeed().poke(),
        }
      : null;
  const served = frameMethods(api, cas, box, budgetOf(entry.id), { moduleId: entry.id, store: moduleSessions }, gesture);
  const sheet = {
    // From a view (a runtime has no gesture of its own): its box, or the focused one, gets the focus back.
    open: (id: string, from?: HTMLElement | null) => sheetOpen.open(id, from ?? focusedBox(id)),
    // A sheet view going (its cleanup may still run) never closes the sheet opened again meanwhile.
    close: (id: string) => void (slot === "sheet" && role === "view" && stopped ? null : sheetOpen.close(id)),
  };
  const caps = capabilityMethods({ moduleId: entry.id, view: box, light: light(), broker: createBroker({ ...browserBroker(), active: gesture }), page: browserPage, ledges: browserLedges, anchors: browserAnchors, pageEvents: { feed: createPageEvents({ requestAnimationFrame: fn => requestAnimationFrame(fn), now: () => performance.now() }, signalSources(api, entry.id)), page: browserSignalPage }, pointer: (pointer ??= createPointerFeed(window)), layout: layoutFeed(), blur, cache: pageCache(), account: hub.account, sheet, more: mobileMore, look: { watch: push => api.theme(t => push(readLook(t))), fonts }, layoutChanged: { feed: layoutChangedFeed(), route: fn => api.on("route", fn) } });
  let initialised = false;
  // When this view's frame reached for the focus by itself.
  const grabbedAt: number[] = [];
  let own: ReturnType<typeof ownReports> | null = null;
  let mounted = false;
  let onUnmounted: (() => void) | null = null;
  const warned = new Set<string>();
  const peer = createRpcPeer({
    source: () => iframe.contentWindow,
    post: (m: HostMessage, transfer) => iframe.contentWindow?.postMessage(m, "*", transfer),
    capabilities: entry.capabilities,
    methods: { ...served.methods, ...caps.methods },
    buckets: ratesOf(entry.id),
    onReady() {
      if (initialised) return;
      initialised = true;
      if (role === "view") {
        // Its bootstrap's own port, before the module loads: the person's real gestures in this view.
        // Its window took the focus: given back unless the person (or the host) put it there, then the badge.
        own = ownReports(
          kind => gestures.own(iframe, kind),
          () => {
            // Again within seconds: Chrome then keeps sending the keys to the frame, whatever the page does.
            if (frameTookFocus(iframe) === "refused" && grabbedAt.push(performance.now()) > 1 && grabbedAt[grabbedAt.length - 1] - grabbedAt[grabbedAt.length - 2] <= 5000) {
              kill(entry.id, "it kept taking the focus", "focus");
              focusBack();
            }
            pageFocusBadge().check();
          },
        );
        peer.send({ v: RPC_VERSION, t: "own" }, [own.port]);
      }
      const transfer = ready(peer);
      peer.send(
        { v: RPC_VERSION, t: "init", role, moduleId: entry.id, slot: role === "view" ? slot : null, locale: locale(), capabilities: entry.capabilities, catalog: SURFACES, fit, ...(room ? { room } : {}) },
        transfer,
      );
    },
    onMounted() {
      mounted = true;
      iframe.dataset.state = "live";
      // The sheet's frame comes after the dialog took the focus: it takes it (Esc then reaches the frame).
      if (slot === "sheet" && role === "view" && !stopped && sheetOpen.get() === entry.id) {
        iframe.focus({ preventScroll: true });
        gestures.hostFocus(iframe);
      }
    },
    onUnmounted: () => onUnmounted?.(),
    onSize: resize,
    settle: g => own?.settle(g) ?? null,
    onBeat: busy => watch?.beat(busy),
    onFlood: () => watch?.flood(),
    onCost: ms => watch?.hostWork(ms),
    onFailed(reason) {
      iframe.dataset.state = "failed";
      console.error(`[module ${entry.id}] ${reason}`);
      failed?.();
    },
    onRefused(why, m) {
      if (warned.has(why)) return;
      warned.add(why);
      console.warn(`[module ${entry.id}] refused ${m ?? "a message"}: ${why}`);
    },
  });
  const removePeer = addPeer(peer);
  // Named by the host while the focus is in it (a sheet's own header names it already).
  const leaveBadge = role === "view" && slot !== "sheet" ? pageFocusBadge().add(iframe, { moduleId: entry.id, name: entry.name, box: parent }) : null;
  let loads = 0;
  // The first load is the document; any later one is the frame navigating (blocked or not).
  iframe.addEventListener("load", () => {
    if (stopped) return;
    if (++loads > 1) kill(entry.id, "its frame navigated", "navigated");
  });
  iframe.src = entry.frameUrl;
  parent.append(iframe);
  // Judged from its first beat on (the ladder gives startup its grace).
  let watch: ReturnType<typeof watchFrame> | null = null;
  watch = watchFrame(entry.id, iframe, role, why => kill(entry.id, why, "slow"));
  let stopped = false;
  return {
    iframe,
    stop() {
      if (stopped) return;
      stopped = true;
      leaveBadge?.();
      watch?.dispose();
      watch = null;
      cancelAnimationFrame(sizeFrame);
      sizeFrame = 0;
      let ended = false;
      let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
      let settled = () => {};
      let unpark: (() => void) | null = null;
      const end = () => {
        if (ended) return;
        ended = true;
        unpark?.();
        clearTimeout(deadline);
        settled();
        onUnmounted = null;
        removePeer();
        own?.close();
        served.dispose();
        caps.dispose();
        disposeApi();
        iframe.remove();
      };
      // A live view or runtime runs its cleanup first (it may still save), served until it's done. A view
      // is parked off screen where moveBefore keeps its document, else (WebKit) left where it is, unseen.
      if (!mounted || killed.has(entry.id) || !iframe.isConnected) {
        budget.give(role, entry.id);
        return end();
      }
      // Counted off as live now (a box remounted while this one is parked gets its frame), counted as parked until it ends.
      unpark = budget.park(role, entry.id, end);
      if (role === "view" && !park(iframe)) Object.assign(iframe.style, { visibility: "hidden", position: "absolute" });
      settle(entry.id, new Promise<void>(resolve => (settled = resolve)));
      onUnmounted = end;
      peer.send({ v: RPC_VERSION, t: "unmount" });
      deadline = setTimeout(end, UNMOUNT_MS);
    },
  };
}

// ---- Runtime frames: one per module, in a container that never moves ----

/** `views`: the peers of the views linked to it, told when it goes. */
type Runtime = { hub: Hub; frame: Frame | null; ready: boolean; waiting: [MessagePort, ViewSlot][]; peer: RpcPeer | null; views: Set<RpcPeer>; offKill: () => void };
const runtimes = new Map<string, Runtime>();
/** Modules whose runtime failed: not made again this session (each new view would only fail it again). */
const failedRuntimes = new Set<string>();
let shelf: HTMLElement | null = null;

const shelfEl = () => {
  if (shelf?.isConnected) return shelf;
  shelf = document.createElement("div");
  shelf.dataset.moduleRuntimes = "";
  shelf.setAttribute("aria-hidden", "true");
  Object.assign(shelf.style, { position: "fixed", left: "0", top: "0", width: "0", height: "0", overflow: "hidden" });
  document.body.append(shelf);
  return shelf;
};

function stopRuntime(id: string) {
  const r = runtimes.get(id);
  if (!r) return;
  runtimes.delete(id);
  r.offKill();
  // Told to close (and given its deadline to save) once its views' cleanups are done.
  const frame = r.frame;
  const views = [...(settling.get(id) ?? [])];
  if (views.length === 0) frame?.stop();
  else void Promise.all(views).then(() => frame?.stop());
  r.waiting.forEach(([p]) => p.close());
  // Never a dead port without a word: the views fall back on their own.
  r.views.forEach(v => v.send({ v: RPC_VERSION, t: "runtime-gone" }));
  r.views.clear();
}

/**
 * The module's runtime, made with its first view; a view's port reaches it
 * once it is ready. Returns the view's leave, or null when there is no
 * runtime for it (refused, failed): the view then gets no port.
 */
function connectRuntime(hub: Hub, entry: ModuleListEntry, slot: ViewSlot, port: MessagePort, view: RpcPeer): (() => void) | null {
  if (failedRuntimes.has(entry.id)) return null;
  let r = runtimes.get(entry.id);
  if (r && r.hub !== hub) {
    stopRuntime(entry.id);
    r = undefined;
  }
  if (!r) {
    const made: Runtime = { hub, frame: null, ready: false, waiting: [], peer: null, views: new Set(), offKill: () => {} };
    runtimes.set(entry.id, made);
    made.frame = openFrame(
      hub,
      entry,
      entry.slots[0] ?? slot,
      shelfEl(),
      "runtime",
      peer => {
        made.ready = true;
        made.peer = peer;
        queueMicrotask(() => made.waiting.splice(0).forEach(([p, s]) => peer.send({ v: RPC_VERSION, t: "port", slot: s }, [p])));
        return [];
      },
      () => {
        failedRuntimes.add(entry.id);
        if (runtimes.get(entry.id) === made) stopRuntime(entry.id);
      },
    );
    if (!made.frame) {
      runtimes.delete(entry.id);
      return null;
    }
    made.offKill = whenKilled(entry.id, () => stopRuntime(entry.id));
    r = made;
  }
  if (r.ready && r.peer) r.peer.send({ v: RPC_VERSION, t: "port", slot }, [port]);
  else r.waiting.push([port, slot]);
  const linked = r;
  linked.views.add(view);
  return () => void linked.views.delete(view);
}

/** Lets go of the runtimes of modules no longer running (all of them with no list). */
export function keepRuntimes(ids: readonly string[] = []) {
  for (const id of [...runtimes.keys()]) if (!ids.includes(id)) stopRuntime(id);
}

export function mountView(hub: Hub, entry: ModuleListEntry, slot: ViewSlot, box: HTMLElement): () => void {
  let frame: Frame | null = null;
  let leaveRuntime: (() => void) | null = null;
  const stop = () => {
    leaveRuntime?.();
    leaveRuntime = null;
    frame?.stop();
    frame = null;
  };
  // After the page has painted: a frame never costs a route change its frame.
  const cancel = idle(() => {
    frame = openFrame(hub, entry, slot, box, "view", peer => {
      if (!entry.capabilities.includes("runtime")) return [];
      const channel = new MessageChannel();
      leaveRuntime = connectRuntime(hub, entry, slot, channel.port1, peer);
      if (leaveRuntime) return [channel.port2];
      // No runtime for it: no port, which the view reads as its runtime gone.
      channel.port1.close();
      channel.port2.close();
      return [];
    });
    // No frame for it (too many, or the module was stopped): no empty dialog.
    if (!frame && slot === "sheet") sheetOpen.close(entry.id);
  });
  const offKill = whenKilled(entry.id, () => {
    stop();
    if (slot === "sheet") sheetOpen.close(entry.id);
  });
  return () => {
    cancel();
    offKill();
    stop();
  };
}
