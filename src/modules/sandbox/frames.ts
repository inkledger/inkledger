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
import { browserPage } from "./importance";
import { createLayoutChangedFeed, createLayoutFeed, createPointerFeed, createScrollingFlag, watchBlur } from "./feeds";
import { createModuleCache, indexedDbCache } from "./cache";
import { fontLoader, themeSheet } from "./themeSheet";
import interUrl from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import interTightUrl from "@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2?url";
import { sidebar } from "@/hooks/useSidebar";
import { createRpcPeer, RPC_VERSION, type HostMessage, type RpcPeer } from "./rpc";
import { budgetOf, markStopped, watchFrame } from "./watchdog";
import { createFrameBudget } from "./budget";
import { moduleSessions } from "./session";

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

const budget = createFrameBudget();
const peers = new Set<RpcPeer>();
const killed = new Set<string>();
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

let broker: ReturnType<typeof createBroker> | null = null;
let pointer: ReturnType<typeof createPointerFeed> | null = null;
let cache: ReturnType<typeof createModuleCache> | null = null;
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
const layoutChangedFeed = () => (layoutChanged ??= createLayoutChangedFeed(window, [sidebar.subscribe, sheetOpen.subscribe]));
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

/** A module that navigated or slowed the page: all its frames go, and it stays off until the page reloads. */
function kill(id: string, why: string, reason: "slow" | "navigated") {
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
  if (!entry.frameUrl || killed.has(entry.id) || !budget.take(role)) return null;
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
  // Same colour scheme as the frame's document, or the browser paints it opaque.
  Object.assign(iframe.style, { display: "block", border: "0", width: role === "view" ? "100%" : "0", height: role === "view" && !fit ? "100%" : "0", colorScheme: "normal", background: "transparent" });
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
  // The sheet is no manifest slot: its API is the module's as in its first slot.
  const { api, cas, dispose: disposeApi } = hub.apiFor(entry.id, slot === "sheet" ? (entry.slots[0] ?? "settings") : slot);
  const box: ViewBox | null =
    role === "view"
      ? {
          el: parent,
          slot,
          activate: how => peer.send({ v: RPC_VERSION, t: "activate", ...(how ? { how } : {}) }),
          focus: (focused, visible) => peer.send({ v: RPC_VERSION, t: "hit-focus", focused, visible }),
          onDock: () => layoutFeed().poke(),
        }
      : null;
  const served = frameMethods(api, cas, box, budgetOf(entry.id), { moduleId: entry.id, store: moduleSessions });
  const sheet = {
    // A runtime has no box: the view the person is in (its frame has the focus) opened it.
    open: (id: string, from?: HTMLElement | null) => sheetOpen.open(id, from ?? focusedBox(id)),
    // A sheet view going (its cleanup may still run) never closes the sheet opened again meanwhile.
    close: (id: string) => void (slot === "sheet" && role === "view" && stopped ? null : sheetOpen.close(id)),
  };
  const caps = capabilityMethods({ moduleId: entry.id, view: box, light: light(), broker: (broker ??= createBroker(browserBroker())), page: browserPage, pointer: (pointer ??= createPointerFeed(window)), layout: layoutFeed(), blur, cache: (cache ??= createModuleCache(indexedDbCache())), sheet, more: mobileMore, look: { watch: push => api.theme(t => push(readLook(t))), fonts }, layoutChanged: { feed: layoutChangedFeed(), route: fn => api.on("route", fn) } });
  let initialised = false;
  let mounted = false;
  let onUnmounted: (() => void) | null = null;
  const warned = new Set<string>();
  const peer = createRpcPeer({
    source: () => iframe.contentWindow,
    post: (m: HostMessage, transfer) => iframe.contentWindow?.postMessage(m, "*", transfer),
    capabilities: entry.capabilities,
    methods: { ...served.methods, ...caps.methods },
    onReady() {
      if (initialised) return;
      initialised = true;
      const transfer = ready(peer);
      peer.send(
        { v: RPC_VERSION, t: "init", role, moduleId: entry.id, slot: role === "view" ? slot : null, locale: locale(), capabilities: entry.capabilities, catalog: SURFACES, fit },
        transfer,
      );
    },
    onMounted() {
      mounted = true;
      iframe.dataset.state = "live";
      // The sheet's frame comes after the dialog took the focus: it takes it (Esc then reaches the frame).
      if (slot === "sheet" && role === "view" && !stopped && sheetOpen.get() === entry.id) iframe.focus({ preventScroll: true });
    },
    onUnmounted: () => onUnmounted?.(),
    onSize: resize,
    onBeat: busy => watch?.beat(busy),
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
      // Counted off now: a box remounted while this one is parked gets its frame.
      budget.give(role);
      watch?.dispose();
      watch = null;
      cancelAnimationFrame(sizeFrame);
      sizeFrame = 0;
      let ended = false;
      let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
      let settled = () => {};
      const end = () => {
        if (ended) return;
        ended = true;
        clearTimeout(deadline);
        settled();
        onUnmounted = null;
        removePeer();
        served.dispose();
        caps.dispose();
        disposeApi();
        iframe.remove();
      };
      // A live view or runtime runs its cleanup first (it may still save), served until it's done. A view
      // is parked off screen where moveBefore keeps its document, else (WebKit) left where it is, unseen.
      if (!mounted || killed.has(entry.id) || !iframe.isConnected) return end();
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
